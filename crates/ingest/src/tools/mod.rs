//! Optional tools: heavy helpers (yt-dlp, transcription models, PDF
//! converters) that Kintsugi downloads the first time they are needed,
//! instead of bundling them.
//!
//! - Nothing is downloaded without **consent**. [`Tools::grant`] records it
//!   per tool (the app asks first); [`Tools::ensure`] installs a consented
//!   tool on first need and refuses with [`ToolError::NeedsConsent`]
//!   otherwise, so a capture can tell the person what it is missing.
//! - Every download is **checked**: a SHA-256 published beside a release
//!   (a sums file or a per-asset `.sha256`), or one pinned in the
//!   [`ToolSpec`]. A mismatch discards the file.
//! - **Updates** reinstall the latest release over the old one. Tools that
//!   break as websites change (yt-dlp) declare an `update_every`; `ensure`
//!   then checks at most that often, and [`Tools::update_if_stale`] lets an
//!   adapter retry with a fresh release after a failure. A failed update
//!   keeps the working version.
//!
//! Layout under the root (in the app's data directory, never the vault):
//!
//! ```text
//! tools/
//!   <id>/tool.json         consent, installed version, checksum, last check
//!   <id>/<version>/<entry> the installed file (executable or data)
//! ```
//!
//! The specs themselves live in [`catalog`]; another ticket adds a tool by
//! adding a spec there, with no change to the manager.

pub mod catalog;

use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// Where a tool's releases come from.
#[derive(Debug, Clone)]
pub enum ToolSource {
    /// The latest GitHub release of `repo` (`owner/name`). The asset is
    /// picked per platform from [`ToolSpec::assets`].
    GitHubRelease { repo: &'static str, checksums: Checksums },
    /// One fixed file, for models and other data that do not have
    /// "latest" releases. Updating means shipping a new spec.
    Pinned { version: &'static str, url: &'static str, sha256: &'static str },
    /// Provided, downloaded and updated by the operating system (Apple's
    /// speech models). The manager only records consent; the adapter that
    /// uses it asks the system to fetch it once consent exists.
    System,
    /// A pinned Python package, installed by `runner` (uv, itself a tool in
    /// the catalog) into its own environment inside the tool's version
    /// directory, with a uv-managed Python. uv checks every package against
    /// the hash the index publishes. `prepare` then runs once from the new
    /// environment's `bin/` (for example to fetch model weights), with
    /// `{dir}` replaced by the version directory. Updating means shipping a
    /// new spec, as with [`ToolSource::Pinned`].
    PythonPackage {
        runner: &'static ToolSpec,
        /// The requirement uv installs, e.g. `docling[ocrmac]`.
        package: &'static str,
        version: &'static str,
        python: &'static str,
        prepare: &'static [&'static str],
    },
}

/// How a GitHub release publishes its checksums.
#[derive(Debug, Clone, Copy)]
pub enum Checksums {
    /// One asset listing `<sha256>  <file name>` lines (yt-dlp's
    /// `SHA2-256SUMS`).
    SumsFile(&'static str),
    /// One `<asset><suffix>` file per asset holding its hash (`.sha256sum`).
    PerAsset(&'static str),
    /// The `digest` GitHub records for every asset it stores
    /// (`sha256:<hex>`). For projects that publish no sums file.
    GitHubDigest,
}

/// How the downloaded file becomes the installed entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Archive {
    /// The download is the entry itself.
    None,
    /// A zip holding the entry (by file name, anywhere in the archive).
    Zip,
    /// A gzipped tarball holding the entry (by file name, anywhere in it).
    TarGz,
}

/// Everything the manager needs to know about one optional tool.
#[derive(Debug, Clone)]
pub struct ToolSpec {
    /// Stable id and directory name, e.g. `yt-dlp`.
    pub id: &'static str,
    /// Shown in the consent prompt.
    pub name: &'static str,
    /// What it is for, in a few words ("YouTube transcripts").
    pub purpose: &'static str,
    pub homepage: &'static str,
    pub license: &'static str,
    pub source: ToolSource,
    /// Release asset per platform, keyed `<os>-<arch>` as in
    /// `std::env::consts` (`macos-aarch64`). Unused for pinned files.
    pub assets: &'static [(&'static str, &'static str)],
    pub archive: Archive,
    /// The installed file's path inside its version directory (`bin/docling`
    /// for a Python package).
    pub entry: &'static str,
    /// Mark the entry executable.
    pub executable: bool,
    /// Downloads larger than this are refused.
    pub max_bytes: u64,
    /// Roughly how big the download is, for the consent prompt.
    pub approx_bytes: u64,
    /// Check for a newer release at most this often during `ensure`.
    pub update_every: Option<Duration>,
}

impl ToolSpec {
    /// The release asset for the platform this runs on, if there is one.
    pub fn asset(&self) -> Option<&'static str> {
        let key = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
        self.assets.iter().find(|(platform, _)| *platform == key).map(|(_, asset)| *asset)
    }
}

/// Fixed, content-free failures (they may be shown and stored).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolError {
    /// The tool is not installed and the person has not agreed to download it.
    NeedsConsent,
    /// No release asset exists for this platform.
    UnsupportedPlatform,
    /// The release, its checksum or its download could not be fetched.
    Unavailable,
    /// The download did not match its published checksum.
    ChecksumMismatch,
    /// The download exceeded the tool's size cap.
    TooLarge,
    /// The archive did not contain the expected entry.
    BadArchive,
    /// The tools directory could not be read or written.
    Storage,
    /// The operating system installs this one; there is nothing to download.
    SystemManaged,
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ToolError::NeedsConsent => "optional tool is not installed",
            ToolError::UnsupportedPlatform => "optional tool is not available for this platform",
            ToolError::Unavailable => "could not download optional tool",
            ToolError::ChecksumMismatch => "optional tool download failed its checksum",
            ToolError::TooLarge => "optional tool download exceeds its size limit",
            ToolError::BadArchive => "optional tool download is not a valid archive",
            ToolError::Storage => "could not write the optional tools folder",
            ToolError::SystemManaged => "this optional tool is installed by the operating system",
        })
    }
}

impl std::error::Error for ToolError {}

pub type ToolResult<T> = std::result::Result<T, ToolError>;

/// The persisted state of one tool (`tool.json`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolState {
    /// When the person agreed to download it (RFC 3339).
    pub consented_at: Option<String>,
    pub installed: Option<Installed>,
    /// The last successful check for a newer release (RFC 3339).
    pub checked_at: Option<String>,
    /// The latest version that check found.
    pub latest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub version: String,
    /// SHA-256 of the verified download.
    pub sha256: String,
    pub installed_at: String,
}

/// What the app shows for a tool.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub id: String,
    pub name: String,
    pub purpose: String,
    pub homepage: String,
    pub license: String,
    pub approx_bytes: u64,
    /// `download` (fetched by the manager) or `system` (fetched by the OS).
    pub kind: &'static str,
    pub supported: bool,
    pub consented: bool,
    pub installed: Option<Installed>,
    pub latest: Option<String>,
    pub checked_at: Option<String>,
    /// The installed entry, when there is one.
    pub path: Option<PathBuf>,
}

/// One resolved release: what to download and the checksum it must match.
#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub version: String,
    pub url: Url,
    pub sha256: String,
}

/// The optional-tools manager. Cheap to share; installs are serialized.
pub struct Tools {
    root: PathBuf,
    client: Client,
    github_api: String,
    locks: std::sync::Mutex<HashMap<&'static str, Arc<Mutex<()>>>>,
}

impl Tools {
    /// Manages tools under `root` (the app passes `<app data>/tools`).
    pub fn new(root: impl Into<PathBuf>) -> ToolResult<Self> {
        let client = Client::builder()
            .user_agent(concat!("Kintsugi/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 || attempt.url().scheme() != "https" && !loopback(attempt.url()) {
                    attempt.error("unsupported redirect")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|_| ToolError::Unavailable)?;
        Ok(Self {
            root: root.into(),
            client,
            github_api: "https://api.github.com".into(),
            locks: Default::default(),
        })
    }

    /// Points GitHub lookups somewhere else (tests use a loopback server).
    pub fn with_github_api(mut self, base: impl Into<String>) -> Self {
        self.github_api = base.into().trim_end_matches('/').to_string();
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn state(&self, spec: &ToolSpec) -> ToolState {
        std::fs::read(self.dir(spec).join("tool.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn status(&self, spec: &ToolSpec) -> ToolStatus {
        let state = self.state(spec);
        ToolStatus {
            id: spec.id.into(),
            name: spec.name.into(),
            purpose: spec.purpose.into(),
            homepage: spec.homepage.into(),
            license: spec.license.into(),
            approx_bytes: spec.approx_bytes,
            kind: if matches!(spec.source, ToolSource::System) { "system" } else { "download" },
            supported: match spec.source {
                ToolSource::Pinned { .. } => true,
                ToolSource::GitHubRelease { .. } => spec.asset().is_some(),
                ToolSource::System => listed_here(spec),
                ToolSource::PythonPackage { runner, .. } => listed_here(spec) && runner.asset().is_some(),
            },
            consented: state.consented_at.is_some(),
            path: self.path(spec),
            installed: state.installed,
            latest: state.latest,
            checked_at: state.checked_at,
        }
    }

    /// Whether the person agreed to download this tool.
    pub fn consented(&self, spec: &ToolSpec) -> bool {
        self.state(spec).consented_at.is_some()
    }

    /// The installed entry, if it is present on disk.
    pub fn path(&self, spec: &ToolSpec) -> Option<PathBuf> {
        let installed = self.state(spec).installed?;
        let path = self.dir(spec).join(safe_component(&installed.version)?).join(spec.entry);
        path.is_file().then_some(path)
    }

    /// Records the person's consent to download this tool (and its updates).
    pub fn grant(&self, spec: &ToolSpec) -> ToolResult<()> {
        let mut state = self.state(spec);
        state.consented_at.get_or_insert_with(crate::now);
        self.save(spec, &state)
    }

    /// Withdraws consent and deletes the installed files.
    pub fn remove(&self, spec: &ToolSpec) -> ToolResult<()> {
        match std::fs::remove_dir_all(self.dir(spec)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(ToolError::Storage),
        }
    }

    /// The installed entry, installing it first if the person agreed to.
    /// A consented tool with `update_every` is updated when its last check
    /// is older than that; a failed check keeps the installed version.
    pub async fn ensure(&self, spec: &ToolSpec) -> ToolResult<PathBuf> {
        if matches!(spec.source, ToolSource::System) {
            return Err(if self.consented(spec) { ToolError::SystemManaged } else { ToolError::NeedsConsent });
        }
        if let Some(path) = self.path(spec) {
            if let Some(every) = spec.update_every
                && self.state(spec).consented_at.is_some()
            {
                return Ok(self.update_if_stale(spec, every).await.unwrap_or(path));
            }
            return Ok(path);
        }
        if self.state(spec).consented_at.is_none() {
            return Err(ToolError::NeedsConsent);
        }
        self.install(spec).await?;
        self.path(spec).ok_or(ToolError::Storage)
    }

    /// Asks where the latest release is and records that it was checked.
    pub async fn check(&self, spec: &ToolSpec) -> ToolResult<Release> {
        let release = self.resolve(spec).await?;
        let _guard = self.lock(spec).await;
        let mut state = self.state(spec);
        state.checked_at = Some(crate::now());
        state.latest = Some(release.version.clone());
        self.save(spec, &state)?;
        Ok(release)
    }

    /// Installs the latest release (or reinstalls it, if the entry is
    /// missing). Requires consent. Returns the installed version.
    pub async fn install(&self, spec: &ToolSpec) -> ToolResult<Installed> {
        if self.state(spec).consented_at.is_none() {
            return Err(ToolError::NeedsConsent);
        }
        if let ToolSource::PythonPackage { .. } = spec.source {
            return self.install_python(spec).await;
        }
        let release = self.check(spec).await?;
        self.install_release(spec, &release).await
    }

    /// Checks for a newer release if the last check is older than `age`, and
    /// installs it. Returns the entry to use: the new one, or the current
    /// one when nothing newer exists or the check was recent.
    pub async fn update_if_stale(&self, spec: &ToolSpec, age: Duration) -> ToolResult<PathBuf> {
        let state = self.state(spec);
        if state.consented_at.is_none() {
            return self.path(spec).ok_or(ToolError::NeedsConsent);
        }
        if let ToolSource::PythonPackage { version, .. } = spec.source {
            if state.installed.is_none_or(|i| i.version != version) || self.path(spec).is_none() {
                self.install_python(spec).await?;
            }
            return self.path(spec).ok_or(ToolError::Storage);
        }
        let fresh = state
            .checked_at
            .as_deref()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .is_some_and(|t| chrono::Utc::now().signed_duration_since(t).to_std().is_ok_and(|elapsed| elapsed < age));
        if !fresh {
            let release = self.check(spec).await?;
            let current = self.state(spec).installed.map(|i| i.version);
            if current.as_deref() != Some(release.version.as_str()) || self.path(spec).is_none() {
                self.install_release(spec, &release).await?;
            }
        }
        self.path(spec).ok_or(ToolError::Storage)
    }

    /// Installs a local file as `version` without downloading anything.
    #[cfg(test)]
    pub(crate) fn install_local(&self, spec: &ToolSpec, version: &str, bytes: &[u8]) {
        let dir = self.dir(spec).join(version);
        std::fs::create_dir_all(&dir).unwrap();
        let entry = dir.join(spec.entry);
        std::fs::write(&entry, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut state = self.state(spec);
        state.installed =
            Some(Installed { version: version.into(), sha256: hex::encode(Sha256::digest(bytes)), installed_at: crate::now() });
        state.checked_at = Some(crate::now());
        self.save(spec, &state).unwrap();
    }

    async fn install_release(&self, spec: &ToolSpec, release: &Release) -> ToolResult<Installed> {
        let _guard = self.lock(spec).await;
        let version = safe_component(&release.version).ok_or(ToolError::Unavailable)?.to_string();
        // Another capture may have installed it while this one waited.
        if let Some(installed) = self.state(spec).installed.filter(|i| i.version == version && i.sha256 == release.sha256)
            && self.path(spec).is_some()
        {
            return Ok(installed);
        }
        let dir = self.dir(spec);
        std::fs::create_dir_all(&dir).map_err(|_| ToolError::Storage)?;
        let download = dir.join(format!(".download-{}", std::process::id()));
        let result = self.download(spec, release, &download).await;
        if let Err(error) = result {
            let _ = std::fs::remove_file(&download);
            return Err(error);
        }
        let staging = dir.join(format!(".staging-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging).map_err(|_| ToolError::Storage)?;
        let unpacked = unpack(spec, &download, &staging.join(spec.entry));
        let _ = std::fs::remove_file(&download);
        if let Err(error) = unpacked {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
        let target = dir.join(&version);
        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&staging, &target).map_err(|_| ToolError::Storage)?;

        let installed = Installed { version: version.clone(), sha256: release.sha256.clone(), installed_at: crate::now() };
        let mut state = self.state(spec);
        state.installed = Some(installed.clone());
        self.save(spec, &state)?;
        // Old versions go only after the new one is recorded.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if entry.path().is_dir() && name != version.as_str() {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        Ok(installed)
    }

    async fn resolve(&self, spec: &ToolSpec) -> ToolResult<Release> {
        match &spec.source {
            ToolSource::System => Err(ToolError::SystemManaged),
            ToolSource::PythonPackage { version, .. } => Ok(Release {
                version: (*version).into(),
                url: Url::parse("https://pypi.org/simple/").map_err(|_| ToolError::Unavailable)?,
                sha256: String::new(),
            }),
            ToolSource::Pinned { version, url, sha256 } => Ok(Release {
                version: (*version).into(),
                url: Url::parse(url).map_err(|_| ToolError::Unavailable)?,
                sha256: sha256.to_ascii_lowercase(),
            }),
            ToolSource::GitHubRelease { repo, checksums } => {
                let asset = spec.asset().ok_or(ToolError::UnsupportedPlatform)?;
                let api = format!("{}/repos/{repo}/releases/latest", self.github_api);
                let body = self.get_small(&api, 1024 * 1024).await?;
                let release: GitHubRelease = serde_json::from_slice(&body).map_err(|_| ToolError::Unavailable)?;
                let find = |name: &str| {
                    release.assets.iter().find(|a| a.name == name).and_then(|a| Url::parse(&a.browser_download_url).ok())
                };
                let digest = || {
                    let found = release.assets.iter().find(|a| a.name == asset)?.digest.as_deref()?;
                    sum_for(found.strip_prefix("sha256:")?, asset)
                };
                let url = find(asset).ok_or(ToolError::UnsupportedPlatform)?;
                let sha256 = match checksums {
                    Checksums::SumsFile(name) => {
                        let sums = find(name).ok_or(ToolError::Unavailable)?;
                        let text = self.get_small(sums.as_str(), 256 * 1024).await?;
                        sum_for(&String::from_utf8_lossy(&text), asset)
                    }
                    Checksums::PerAsset(suffix) => {
                        let sums = find(&format!("{asset}{suffix}")).ok_or(ToolError::Unavailable)?;
                        let text = self.get_small(sums.as_str(), 64 * 1024).await?;
                        sum_for(&String::from_utf8_lossy(&text), asset)
                    }
                    Checksums::GitHubDigest => digest(),
                }
                .ok_or(ToolError::Unavailable)?;
                Ok(Release { version: release.tag_name, url, sha256 })
            }
        }
    }

    async fn get_small(&self, url: &str, limit: usize) -> ToolResult<Vec<u8>> {
        let url = Url::parse(url).map_err(|_| ToolError::Unavailable)?;
        if url.scheme() != "https" && !loopback(&url) {
            return Err(ToolError::Unavailable);
        }
        let response = self
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json, */*")
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| ToolError::Unavailable)?;
        if !response.status().is_success() {
            return Err(ToolError::Unavailable);
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ToolError::Unavailable)?;
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                return Err(ToolError::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    /// Streams the release to `path`, hashing as it goes.
    async fn download(&self, spec: &ToolSpec, release: &Release, path: &Path) -> ToolResult<()> {
        if release.url.scheme() != "https" && !loopback(&release.url) {
            return Err(ToolError::Unavailable);
        }
        let response = self.client.get(release.url.clone()).send().await.map_err(|_| ToolError::Unavailable)?;
        if !response.status().is_success() {
            return Err(ToolError::Unavailable);
        }
        if response.content_length().is_some_and(|n| n > spec.max_bytes) {
            return Err(ToolError::TooLarge);
        }
        let mut file = std::fs::File::create(path).map_err(|_| ToolError::Storage)?;
        let mut hasher = Sha256::new();
        let mut written = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ToolError::Unavailable)?;
            written += chunk.len() as u64;
            if written > spec.max_bytes {
                return Err(ToolError::TooLarge);
            }
            hasher.update(&chunk);
            file.write_all(&chunk).map_err(|_| ToolError::Storage)?;
        }
        file.sync_all().map_err(|_| ToolError::Storage)?;
        if hex::encode(hasher.finalize()) != release.sha256 {
            return Err(ToolError::ChecksumMismatch);
        }
        Ok(())
    }

    /// Installs a [`ToolSource::PythonPackage`] with its runner (which must
    /// itself be consented), into a fresh version directory: uv's tool
    /// environment in `env/`, its scripts in `bin/`, Python itself shared in
    /// `tools/python/`, and no download cache left behind. Nothing goes to
    /// the person's own Python or uv settings.
    async fn install_python(&self, spec: &ToolSpec) -> ToolResult<Installed> {
        let ToolSource::PythonPackage { runner, package, version, python, prepare } = spec.source else {
            return Err(ToolError::Unavailable);
        };
        if !listed_here(spec) {
            return Err(ToolError::UnsupportedPlatform);
        }
        let uv = Box::pin(self.ensure(runner)).await?;
        let _guard = self.lock(spec).await;
        let version = safe_component(version).ok_or(ToolError::Unavailable)?.to_string();
        if let Some(installed) = self.state(spec).installed.filter(|i| i.version == version)
            && self.path(spec).is_some()
        {
            return Ok(installed);
        }
        // uv writes absolute paths into the environment's scripts and links,
        // so it installs straight into the final version directory. A
        // different version that already works stays until this one is done.
        let dir = self.dir(spec);
        let target = dir.join(&version);
        let _ = std::fs::remove_dir_all(&target);
        std::fs::create_dir_all(&target).map_err(|_| ToolError::Storage)?;
        let result = async {
            let target = target.canonicalize().map_err(|_| ToolError::Storage)?;
            let requirement = format!("{package}=={version}");
            let mut command = self.uv(&uv, &target);
            command.args(["tool", "install", "--python", python, requirement.as_str()]);
            run_quietly(command, Duration::from_secs(60 * 60)).await?;
            if let Some((program, args)) = prepare.split_first() {
                let mut command = tokio::process::Command::new(target.join("bin").join(program));
                let dir = target.to_string_lossy();
                command.args(args.iter().map(|arg| arg.replace("{dir}", &dir)));
                command.env("HF_HOME", target.join("hf"));
                run_quietly(command, Duration::from_secs(60 * 60)).await?;
            }
            let entry = std::fs::read(target.join(spec.entry)).map_err(|_| ToolError::BadArchive)?;
            Ok::<_, ToolError>(hex::encode(Sha256::digest(&entry)))
        }
        .await;
        let sha256 = match result {
            Ok(sha256) => sha256,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&target);
                return Err(error);
            }
        };
        let installed = Installed { version: version.clone(), sha256, installed_at: crate::now() };
        let mut state = self.state(spec);
        state.installed = Some(installed.clone());
        state.checked_at = Some(crate::now());
        state.latest = Some(version.clone());
        self.save(spec, &state)?;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() && entry.file_name() != version.as_str() {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        Ok(installed)
    }

    /// uv confined to the tools folder: no user config, its own cache and
    /// Python installs, and the tool environment under `dir`.
    fn uv(&self, uv: &Path, dir: &Path) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(uv);
        command
            .env("UV_NO_CONFIG", "1")
            .env("UV_TOOL_DIR", dir.join("env"))
            .env("UV_TOOL_BIN_DIR", dir.join("bin"))
            .env("UV_PYTHON_INSTALL_DIR", self.root.join("python"))
            // Packages are installed once into their own environment, so
            // uv's download cache (over a gigabyte for Docling) isn't kept.
            .env("UV_NO_CACHE", "1")
            .env("UV_PYTHON_PREFERENCE", "only-managed")
            .env_remove("VIRTUAL_ENV")
            .env_remove("PYTHONPATH");
        command
    }

    fn dir(&self, spec: &ToolSpec) -> PathBuf {
        self.root.join(spec.id)
    }

    fn save(&self, spec: &ToolSpec, state: &ToolState) -> ToolResult<()> {
        let dir = self.dir(spec);
        std::fs::create_dir_all(&dir).map_err(|_| ToolError::Storage)?;
        let tmp = dir.join(format!(".tool.json-{}", std::process::id()));
        let json = serde_json::to_vec_pretty(state).map_err(|_| ToolError::Storage)?;
        std::fs::write(&tmp, json).map_err(|_| ToolError::Storage)?;
        std::fs::rename(&tmp, dir.join("tool.json")).map_err(|_| ToolError::Storage)
    }

    async fn lock(&self, spec: &ToolSpec) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = self.locks.lock().unwrap_or_else(|e| e.into_inner()).entry(spec.id).or_default().clone();
        lock.lock_owned().await
    }
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
}

/// Finds `name`'s hash in a sums file (`<hex>  <name>` or `<hex> *<name>`
/// lines), or takes the only hash in a single-hash file.
fn sum_for(text: &str, name: &str) -> Option<String> {
    let is_hash = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let found = text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let file = parts.next()?.trim_start_matches('*');
        (is_hash(hash) && file == name).then(|| hash.to_ascii_lowercase())
    });
    found.or_else(|| {
        let only = lines.next()?;
        let hash = only.split_whitespace().next()?;
        (lines.next().is_none() && is_hash(hash) && only.split_whitespace().nth(1).is_none_or(|f| f.ends_with(name)))
            .then(|| hash.to_ascii_lowercase())
    })
}

fn unpack(spec: &ToolSpec, download: &Path, entry: &Path) -> ToolResult<()> {
    match spec.archive {
        Archive::None => std::fs::rename(download, entry).map_err(|_| ToolError::Storage)?,
        Archive::TarGz => {
            let file = std::fs::File::open(download).map_err(|_| ToolError::Storage)?;
            let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
            let mut found = false;
            for item in tar.entries().map_err(|_| ToolError::BadArchive)? {
                let mut item = item.map_err(|_| ToolError::BadArchive)?;
                let named = item.path().ok().is_some_and(|p| p.file_name().is_some_and(|n| n == spec.entry));
                if !named || !item.header().entry_type().is_file() {
                    continue;
                }
                if item.size() > spec.max_bytes.saturating_mul(4) {
                    return Err(ToolError::TooLarge);
                }
                let mut out = std::fs::File::create(entry).map_err(|_| ToolError::Storage)?;
                std::io::copy(&mut (&mut item).take(spec.max_bytes.saturating_mul(4)), &mut out)
                    .map_err(|_| ToolError::BadArchive)?;
                found = true;
                break;
            }
            if !found {
                return Err(ToolError::BadArchive);
            }
        }
        Archive::Zip => {
            let file = std::fs::File::open(download).map_err(|_| ToolError::Storage)?;
            let mut zip = zip::ZipArchive::new(file).map_err(|_| ToolError::BadArchive)?;
            let index = (0..zip.len())
                .find(|&i| {
                    zip.by_index(i).ok().is_some_and(|f| {
                        f.is_file() && f.enclosed_name().and_then(|p| p.file_name().map(|n| n == spec.entry)).unwrap_or(false)
                    })
                })
                .ok_or(ToolError::BadArchive)?;
            let mut source = zip.by_index(index).map_err(|_| ToolError::BadArchive)?;
            if source.size() > spec.max_bytes.saturating_mul(4) {
                return Err(ToolError::TooLarge);
            }
            let mut out = std::fs::File::create(entry).map_err(|_| ToolError::Storage)?;
            std::io::copy(&mut source, &mut out).map_err(|_| ToolError::BadArchive)?;
        }
    }
    if spec.executable {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(entry, std::fs::Permissions::from_mode(0o755)).map_err(|_| ToolError::Storage)?;
        }
    }
    Ok(())
}

/// Whether the spec lists this platform (for tools without a download asset).
fn listed_here(spec: &ToolSpec) -> bool {
    let key = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    spec.assets.iter().any(|(platform, _)| *platform == key)
}

/// Runs an installer step with no output to logs (it may print paths or
/// package names, never anything the person wrote) and a time limit.
async fn run_quietly(mut command: tokio::process::Command, limit: Duration) -> ToolResult<()> {
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| ToolError::Unavailable)?;
    match tokio::time::timeout(limit, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        _ => Err(ToolError::Unavailable),
    }
}

/// Version strings become directory names, so only plain ones are allowed.
fn safe_component(version: &str) -> Option<&str> {
    (!version.is_empty()
        && version.len() <= 64
        && !version.starts_with('.')
        && version.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'+')))
    .then_some(version)
}

fn loopback(url: &Url) -> bool {
    cfg!(test) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
}

#[cfg(test)]
mod tests;
