//! Pi's credentials, read from (and refreshed into) Pi's own file, and
//! Kintsugi's own credentials, kept in a second file of exactly the same
//! format (KI-92).
//!
//! Pi's file is `~/.pi/agent/auth.json` (or `$PI_CODING_AGENT_DIR`), written
//! by the `pi` CLI: `{ "<providerId>": { "type": "api_key", "key": … } |
//! { "type": "oauth", "access", "refresh", "expires", … } }`. Kintsugi reads
//! it, and when an OAuth token is about to expire it refreshes it and writes
//! the rotated token back, so Pi and every other app sharing the file stay
//! logged in. Kintsugi's own file is `auth.json` in its app config folder:
//! keys added and logins made in Settings › Providers (`sign_in.rs`), by
//! Pi's provider ids and with Pi's fields, so either file could stand in for
//! the other. The same `Store` serves both; only the location (and the
//! advice in an error) differs.
//!
//! Every provider id Pi uses is read the same way: an API key for any of
//! them, and the logins Pi offers: ChatGPT for Codex (`openai-codex`) and
//! for the OpenAI API (`openai`), GitHub Copilot, Kimi For Coding, xAI, Meta
//! and OpenRouter, each refreshed the way Pi does it (`src/auth/oauth/` in
//! pi-ai 1.5.0). A Claude subscription login is never used. A key stored as
//! `$VAR` is read from the environment; one stored as `!command` would need
//! a shell command run, which Kintsugi never does, so it counts as absent.
//!
//! The write path copies Pi's lock discipline: `proper-lockfile` takes an
//! advisory lock by creating the directory `auth.json.lock` and treats it as
//! stale after 30s. Holding that lock across read-refresh-write matters
//! because OpenAI rotates refresh tokens: two unlocked refreshers would each
//! spend the same refresh token, and the loser's write would log the other
//! out. A refresh is capped at 15s, well inside the stale window, so the
//! lock never needs its mtime touched while held. Files are replaced
//! atomically and left owner-only (0600), as Pi leaves its own.
//!
//! Headless runs never lock, refresh or write a credential file: Pi's is
//! read-only there, and Kintsugi's is replaced by one held in memory.
//!
//! Secrets never reach an error message: a malformed file is reported by
//! path alone, because serde's messages can quote the offending text, and a
//! server's answer is never quoted back.

use base64::Engine;
use serde_json::{Map, Value, json};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const AUTH_FILE: &str = "auth.json";
const LOCK_STALE: Duration = Duration::from_secs(30);
const LOCK_WAIT: Duration = Duration::from_secs(20);
/// Refresh when a token has less than this left, as pi-ai does.
pub(super) const MINIMUM_VALIDITY_MS: u64 = 5 * 60 * 1000;
const REFRESH_TIMEOUT: Duration = Duration::from_secs(15);

// pi-ai 1.5.0, `src/auth/oauth/*.ts`. `sign_in::tests::drift` checks every
// one against Pi's source (`auth.pi.json`, written by `pnpm gen:models`).
pub(super) const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub(super) const CODEX_JWT_CLAIM: &str = "https://api.openai.com/auth";
pub(super) const CHATGPT_RESOURCE: &str = "https://api.openai.com/v1";
pub(super) const CHATGPT_DIRECT_SCOPE: &str = "chatgpt.tokens.use.direct";
/// Pi refreshes a ChatGPT token this long before it really expires.
pub(super) const CHATGPT_EXPIRY_MARGIN_MS: u64 = 3 * 60 * 1000;
pub(super) const XAI_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
pub(super) const XAI_DEFAULT_LIFETIME_S: u64 = 3600;
pub(super) const KIMI_CLIENT_ID: &str = "17e5f671-d194-4dfb-9706-5516cb48c098";
pub(super) const KIMI_HOST: &str = "https://auth.kimi.com";
pub(super) const META_KEY_LIFETIME_MS: u64 = 24 * 60 * 60 * 1000;
pub(super) const COPILOT_API_VERSION: &str = "2026-06-01";
/// The editor Copilot's token endpoint expects, as Pi sends it.
pub const COPILOT_HEADERS: [(&str, &str); 4] = [
    ("User-Agent", "GitHubCopilotChat/0.35.0"),
    ("Editor-Version", "vscode/1.107.0"),
    ("Editor-Plugin-Version", "copilot-chat/0.35.0"),
    ("Copilot-Integration-Id", "vscode-chat"),
];

type Result<T> = std::result::Result<T, String>;

/// What a request needs to authenticate.
#[derive(Debug, Clone, PartialEq)]
pub enum Auth {
    ApiKey(String),
    /// An OAuth access token, plus the ChatGPT account id Codex requires.
    Bearer {
        token: String,
        account_id: Option<String>,
    },
}

pub use super::credentials::Kind;
use super::credentials::Lookup;
use super::wire::Provider;

/// `$PI_CODING_AGENT_DIR` (with `~` expanded), else `~/.pi/agent`: Pi's own rule.
pub fn agent_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("HOME is not set")?;
    Ok(match std::env::var("PI_CODING_AGENT_DIR") {
        Ok(dir) if dir == "~" => home,
        Ok(dir) if dir.starts_with("~/") => home.join(&dir[2..]),
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home.join(".pi").join("agent"),
    })
}

/// Whose file a store is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    Pi,
    Kintsugi,
}

impl Owner {
    pub fn name(self) -> &'static str {
        match self {
            Owner::Pi => "Pi",
            Owner::Kintsugi => "Kintsugi",
        }
    }

    /// What to do about a login that can't be refreshed.
    pub fn relogin(self) -> &'static str {
        match self {
            Owner::Pi => "run `pi` and log in again",
            Owner::Kintsugi => "sign in again in Settings › Providers",
        }
    }
}

/// Every server a login or a refresh talks to, so tests can point them at
/// a local stand-in. `Default` is the real one, as Pi has it.
#[cfg_attr(feature = "headless", allow(dead_code))]
#[derive(Debug, Clone)]
pub struct Endpoints {
    /// OpenAI's auth server (Codex and Sign in with ChatGPT).
    pub openai: String,
    pub xai: String,
    /// Kimi's auth server; `None` reads Pi's `KIMI_CODE_OAUTH_HOST` /
    /// `KIMI_OAUTH_HOST`, else `https://auth.kimi.com`.
    pub kimi: Option<String>,
    pub meta_auth: String,
    pub meta_api: String,
    pub openrouter: String,
    /// One base for every GitHub and Copilot URL (tests only).
    pub github: Option<String>,
    /// The fixed loopback port both OpenAI browser logins use.
    pub openai_callback_port: u16,
    /// How long one second of a device-code flow lasts (tests shorten it).
    pub second: Duration,
    /// How long a browser login waits for its callback.
    pub login_timeout: Duration,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints {
            openai: "https://auth.openai.com".into(),
            xai: "https://auth.x.ai".into(),
            kimi: None,
            meta_auth: "https://auth.meta.com".into(),
            meta_api: "https://api.meta.ai".into(),
            openrouter: "https://openrouter.ai".into(),
            github: None,
            openai_callback_port: 1455,
            second: Duration::from_secs(1),
            login_timeout: Duration::from_secs(5 * 60),
        }
    }
}

#[cfg_attr(feature = "headless", allow(dead_code))]
impl Endpoints {
    pub fn kimi_host(&self) -> String {
        let host = self.kimi.clone().unwrap_or_else(|| {
            ["KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST"]
                .iter()
                .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
                .unwrap_or_else(|| KIMI_HOST.into())
        });
        host.trim_end_matches('/').to_string()
    }

    /// `https://<domain><path>` (GitHub's device flow).
    pub fn github_url(&self, domain: &str, path: &str) -> String {
        match &self.github {
            Some(base) => format!("{base}{path}"),
            None => format!("https://{domain}{path}"),
        }
    }

    pub fn copilot_token_url(&self, domain: &str) -> String {
        match &self.github {
            Some(base) => format!("{base}/copilot_internal/v2/token"),
            None => format!("https://api.{domain}/copilot_internal/v2/token"),
        }
    }

    /// Pi's `getGitHubCopilotBaseUrl`: the token's `proxy-ep`, else the
    /// enterprise's Copilot API, else the individual one.
    pub fn copilot_api(&self, token: &str, enterprise: Option<&str>) -> String {
        if let Some(base) = &self.github {
            return base.clone();
        }
        if let Some(proxy) = token
            .split(';')
            .find_map(|part| part.trim().strip_prefix("proxy-ep="))
            .filter(|p| !p.is_empty())
        {
            let host = proxy.strip_prefix("proxy.").map_or(proxy.to_string(), |rest| format!("api.{rest}"));
            return format!("https://{host}");
        }
        match enterprise {
            Some(domain) => format!("https://copilot-api.{domain}"),
            None => "https://api.individual.githubcopilot.com".into(),
        }
    }
}

#[derive(Clone)]
enum Backing {
    File(PathBuf),
    /// Headless runs: nothing on disk.
    Memory(Arc<Mutex<Map<String, Value>>>),
}

#[derive(Clone)]
pub struct Store {
    backing: Backing,
    read_only: bool,
    owner: Owner,
    endpoints: Arc<Endpoints>,
}

impl Store {
    /// Pi's file in `dir`.
    pub fn new(dir: &Path) -> Self {
        Self {
            backing: Backing::File(dir.join(AUTH_FILE)),
            read_only: false,
            owner: Owner::Pi,
            endpoints: Arc::default(),
        }
    }

    /// Kintsugi's own file in its config folder `dir`.
    pub fn kintsugi(dir: &Path) -> Self {
        Self {
            owner: Owner::Kintsugi,
            ..Self::new(dir)
        }
    }

    /// Kintsugi's credentials held in memory only: headless runs, and
    /// isolated dev runs without a scratch config folder. Never refreshed.
    pub fn memory() -> Self {
        Self {
            backing: Backing::Memory(Arc::default()),
            read_only: true,
            owner: Owner::Kintsugi,
            endpoints: Arc::default(),
        }
    }

    pub fn default_location() -> Result<Self> {
        let mut store = Self::new(&agent_dir()?);
        // Headless never locks, refreshes, rotates or writes Pi credentials.
        store.read_only = cfg!(feature = "headless");
        Ok(store)
    }

    #[cfg(test)]
    pub fn with_endpoints(mut self, endpoints: Endpoints) -> Self {
        self.endpoints = Arc::new(endpoints);
        self
    }

    #[cfg(test)]
    pub fn owner(&self) -> Owner {
        self.owner
    }

    #[cfg_attr(feature = "headless", allow(dead_code))]
    pub fn endpoints(&self) -> Arc<Endpoints> {
        self.endpoints.clone()
    }

    fn read(&self) -> Result<Map<String, Value>> {
        let path = match &self.backing {
            Backing::File(path) => path,
            Backing::Memory(map) => return Ok(map.lock().unwrap().clone()),
        };
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
            Err(_) => return Err(format!("could not read {}", path.display())),
        };
        match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
            Ok(Value::Object(map)) => Ok(map),
            _ => Err(format!("{} is not valid credentials JSON", path.display())),
        }
    }

    /// Whole-file atomic replace, owner-only, like the `pi` CLI leaves it.
    fn write(&self, map: &Map<String, Value>) -> Result<()> {
        use std::os::unix::fs::OpenOptionsExt;
        let path = match &self.backing {
            Backing::File(path) => path,
            Backing::Memory(memory) => {
                *memory.lock().unwrap() = map.clone();
                return Ok(());
            }
        };
        self.ensure_dir()?;
        let tmp = path.with_file_name(format!(".{AUTH_FILE}.kintsugi-{}", std::process::id()));
        let fail = |_| format!("could not write {}", path.display());
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(fail)?;
        let bytes = serde_json::to_vec_pretty(map)
            .map_err(|_| "could not encode credentials".to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(fail)?;
        fs::rename(&tmp, path).map_err(fail)
    }

    /// Pi creates its folder owner-only when it's missing; so does Kintsugi.
    fn ensure_dir(&self) -> Result<()> {
        use std::os::unix::fs::DirBuilderExt;
        let Backing::File(path) = &self.backing else {
            return Ok(());
        };
        let dir = path.parent().ok_or("credentials have no folder")?;
        if dir.is_dir() {
            return Ok(());
        }
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|_| format!("could not create {}", dir.display()))
    }

    fn lock(&self) -> Result<Lock> {
        let Backing::File(file) = &self.backing else {
            return Ok(Lock(None));
        };
        self.ensure_dir()?;
        let path = file.with_file_name(format!("{AUTH_FILE}.lock"));
        let deadline = SystemTime::now() + LOCK_WAIT;
        loop {
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Lock(Some(path))),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .map(|t| t.elapsed().unwrap_or_default() > LOCK_STALE)
                        .unwrap_or(false);
                    if stale {
                        let _ = fs::remove_dir(&path);
                    } else if SystemTime::now() > deadline {
                        return Err(format!(
                            "timed out waiting for {}'s credentials lock",
                            self.owner.name()
                        ));
                    } else {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
                Err(_) => return Err(format!("could not lock {}", file.display())),
            }
        }
    }

    /// One read-modify-write under the lock, as Pi's `modify` does it.
    /// Blocks while another process holds the lock (up to 20s).
    pub fn modify(&self, change: impl FnOnce(&mut Map<String, Value>)) -> Result<()> {
        match &self.backing {
            Backing::Memory(map) => {
                change(&mut map.lock().unwrap());
                Ok(())
            }
            Backing::File(_) if self.read_only => {
                Err("Headless runs never write credentials.".into())
            }
            Backing::File(_) => {
                let lock = self.lock()?;
                let mut map = self.read()?;
                change(&mut map);
                let result = self.write(&map);
                drop(lock);
                result
            }
        }
    }

    /// Saves one provider's credential, replacing what was there.
    pub fn save(&self, provider: &str, credential: Value) -> Result<()> {
        self.modify(|map| {
            map.insert(provider.to_string(), credential);
        })
    }

    /// Removes one provider's credential (Pi's `delete`, its logout).
    pub fn remove(&self, provider: &str) -> Result<()> {
        self.modify(|map| {
            map.remove(provider);
        })
    }

    /// The kind of credential held for `provider`, without the secret.
    pub fn held(&self, provider: &str) -> Result<Option<Kind>> {
        Ok(self.read()?.get(provider).and_then(kind))
    }

    /// What the store holds for `provider`, without the secret. An expiring
    /// login counts as usable where it can be refreshed (not read-only).
    pub fn lookup(&self, provider: &Provider) -> Result<Lookup> {
        let Some(cred) = self.read()?.remove(provider.id) else {
            return Ok(Lookup::Missing);
        };
        Ok(match kind(&cred) {
            Some(Kind::ApiKey) if api_key(&cred).is_some() => Lookup::Usable(Kind::ApiKey),
            // A Claude subscription login: Kintsugi only uses Anthropic API keys.
            Some(Kind::Oauth) if provider.id == "anthropic" => Lookup::Unsupported,
            Some(Kind::Oauth) if fresh(&cred) => Lookup::Usable(Kind::Oauth),
            Some(Kind::Oauth) if !self.read_only && refreshable(provider.id) => {
                Lookup::Usable(Kind::Oauth)
            }
            Some(Kind::Oauth) => Lookup::Expired,
            _ => Lookup::Missing,
        })
    }

    fn expired_here(&self) -> String {
        format!(
            "{} login expired; refresh it outside headless mode",
            self.owner.name()
        )
    }

    /// A usable credential for `provider`, refreshing an expiring OAuth token
    /// first. `None` when the store holds nothing for it.
    pub async fn auth(&self, provider: &str) -> Result<Option<Auth>> {
        let Some(cred) = self.read()?.remove(provider) else {
            return Ok(None);
        };
        match kind(&cred) {
            Some(Kind::ApiKey) => Ok(api_key(&cred).map(Auth::ApiKey)),
            Some(Kind::Oauth) if fresh(&cred) => Ok(Some(login(provider, &cred)?)),
            Some(Kind::Oauth) if self.read_only => Err(self.expired_here()),
            Some(Kind::Oauth) => {
                // Detached: a cancelled caller (a new keystroke aborts a
                // completion) must not drop a refresh midway, after the
                // server has rotated the refresh token but before the new
                // one is written; that would log the login out (Pi lets a
                // started refresh finish, too).
                let store = self.clone();
                let provider = provider.to_string();
                tokio::spawn(async move { store.refresh(&provider).await })
                    .await
                    .map_err(|_| "login refresh stopped".to_string())?
                    .map(Some)
            }
            None => Err(format!("unrecognised credential for {provider}")),
        }
    }

    /// Refresh under the lock, re-reading inside it: another process may
    /// already have refreshed, in which case its token is used as-is.
    async fn refresh(&self, provider: &str) -> Result<Auth> {
        if self.read_only {
            return Err(self.expired_here());
        }
        let store = self.clone();
        let (lock, mut map) = tokio::task::spawn_blocking(move || {
            let lock = store.lock()?;
            store.read().map(|map| (lock, map))
        })
        .await
        .map_err(|e| e.to_string())??;

        let current = map
            .get(provider)
            .cloned()
            .ok_or("credential disappeared during refresh")?;
        if fresh(&current) {
            drop(lock);
            return login(provider, &current);
        }
        let calls = Calls::new(&self.endpoints, self.owner.relogin(), "token refresh");
        let updated = match provider {
            "openai-codex" => refresh_codex(&calls, &current).await?,
            "openai" => refresh_chatgpt(&calls, &current).await?,
            "xai" => refresh_xai(&calls, &current).await?,
            "kimi-coding" => refresh_kimi(&calls, &current).await?,
            "github-copilot" => refresh_copilot(&calls, &current).await?,
            "meta" => refresh_meta(&calls, &current).await?,
            other => {
                return Err(format!(
                    "Kintsugi can't refresh {other} logins yet; use an API key"
                ));
            }
        };
        map.insert(provider.to_string(), updated.clone());
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let result = store.write(&map);
            drop(lock);
            result
        })
        .await
        .map_err(|e| e.to_string())??;
        login(provider, &updated)
    }
}

struct Lock(Option<PathBuf>);

impl Drop for Lock {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_dir(path);
        }
    }
}

fn kind(cred: &Value) -> Option<Kind> {
    match cred.get("type")?.as_str()? {
        "api_key" => Some(Kind::ApiKey),
        "oauth" => Some(Kind::Oauth),
        _ => None,
    }
}

pub(super) fn str_field(cred: &Value, key: &str) -> Option<String> {
    cred.get(key)?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from)
}

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn fresh(cred: &Value) -> bool {
    cred.get("expires")
        .and_then(Value::as_u64)
        .is_some_and(|expires| now_ms() + MINIMUM_VALIDITY_MS < expires)
}

/// What a fresh login sends. Codex needs its ChatGPT account too; every
/// other login is used as its provider's key (Pi's `toAuth`: an OpenRouter
/// or Meta key, an xAI, Kimi, ChatGPT or Copilot token).
fn login(provider: &str, cred: &Value) -> Result<Auth> {
    let token = str_field(cred, "access").ok_or("OAuth credential has no access token")?;
    Ok(match provider {
        "openai-codex" => Auth::Bearer {
            account_id: str_field(cred, "accountId"),
            token,
        },
        _ => Auth::ApiKey(token),
    })
}

/// Logins Kintsugi can refresh (under the lock, natively only). An
/// OpenRouter login is a key that never expires.
pub(super) fn refreshable(provider: &str) -> bool {
    matches!(
        provider,
        "openai-codex" | "openai" | "xai" | "kimi-coding" | "github-copilot" | "meta"
    )
}

/// A stored API key. Pi also accepts `$VAR`/`${VAR}` (read from the
/// credential's own `env`, then the environment) and `!command` (a shell
/// command): Kintsugi never runs commands, so such a key counts as absent.
fn api_key(cred: &Value) -> Option<String> {
    let raw = str_field(cred, "key")?;
    if raw.starts_with('!') {
        return None;
    }
    if !raw.contains('$') {
        return Some(raw);
    }
    let env = |name: &str| {
        cred.get("env")
            .and_then(|e| e.get(name))
            .and_then(Value::as_str)
            .map(String::from)
            .or_else(|| std::env::var(name).ok())
            .filter(|v| !v.trim().is_empty())
    };
    let mut out = String::new();
    let mut rest = raw.as_str();
    while let Some(at) = rest.find('$') {
        out.push_str(&rest[..at]);
        rest = &rest[at + 1..];
        match rest.chars().next() {
            Some('$') | Some('!') => {
                out.push_str(&rest[..1]);
                rest = &rest[1..];
            }
            Some('{') => {
                let end = rest.find('}')?;
                out.push_str(&env(&rest[1..end])?);
                rest = &rest[end + 1..];
            }
            _ => {
                let len = rest
                    .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .unwrap_or(rest.len());
                if len == 0 {
                    out.push('$');
                    continue;
                }
                out.push_str(&env(&rest[..len])?);
                rest = &rest[len..];
            }
        }
    }
    out.push_str(rest);
    Some(out).filter(|k| !k.is_empty())
}

/// A key as Pi's file stores it so that it reads back literally: `$` is
/// escaped as `$$`, and a leading `!` (a command to Pi) as `$!`.
pub fn literal_key(key: &str) -> String {
    let escaped = key.replace('$', "$$");
    match escaped.strip_prefix('!') {
        Some(rest) => format!("$!{rest}"),
        None => escaped,
    }
}

/// The ChatGPT account id inside a Codex access token (a JWT).
pub fn codex_account_id(access: &str) -> Option<String> {
    let payload = access.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    claims
        .get(CODEX_JWT_CLAIM)?
        .get("chatgpt_account_id")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from)
}

// --- Token requests, shared by refresh and sign-in --------------------------

/// What one login or refresh needs to make its requests.
pub(super) struct Calls<'a> {
    pub client: reqwest::Client,
    pub endpoints: &'a Endpoints,
    /// What to tell him when the login can't be renewed.
    pub relogin: &'static str,
    /// `token refresh` or `sign-in`, for errors.
    pub action: &'static str,
}

impl<'a> Calls<'a> {
    pub fn new(endpoints: &'a Endpoints, relogin: &'static str, action: &'static str) -> Self {
        Calls {
            client: reqwest::Client::new(),
            endpoints,
            relogin,
            action,
        }
    }

    /// One JSON request: the status and the body (`{}` when it isn't a JSON
    /// object). Errors name the provider and the status, never a token.
    pub async fn send(&self, name: &str, request: reqwest::RequestBuilder) -> Result<(u16, Value)> {
        let response = request
            .timeout(REFRESH_TIMEOUT)
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("{name} {} failed: {}", self.action, e.without_url()))?;
        let status = response.status().as_u16();
        let body = response
            .json::<Value>()
            .await
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        Ok((status, body))
    }

    /// A request that must succeed: its JSON answer.
    pub async fn json(&self, name: &str, request: reqwest::RequestBuilder) -> Result<Value> {
        let (status, body) = self.send(name, request).await?;
        if !(200..300).contains(&status) {
            return Err(format!(
                "{name} {} failed ({status}{}); {}",
                self.action,
                oauth_error(&body),
                self.relogin
            ));
        }
        Ok(body)
    }
}

/// `: <error>: <description>` from an OAuth error answer, or nothing. These
/// are the server's own codes and sentences, never a token.
pub(super) fn oauth_error(body: &Value) -> String {
    let text = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .map(|s| s.chars().take(200).collect::<String>())
    };
    let parts: Vec<String> = [text("error"), text("error_description")]
        .into_iter()
        .flatten()
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!(": {}", parts.join(": "))
    }
}

fn expires_in(json: &Value) -> Option<f64> {
    json.get("expires_in")
        .and_then(Value::as_f64)
        .filter(|s| s.is_finite())
}

fn after(seconds: f64) -> u64 {
    now_ms().saturating_add((seconds * 1000.0) as u64)
}

/// Pi's `credentialsFromToken` for Codex: the tokens and the ChatGPT
/// account inside the access token.
pub(super) fn codex_credential(json: &Value, action: &str) -> Result<Value> {
    let (Some(access), Some(refresh), Some(seconds)) = (
        str_field(json, "access_token"),
        str_field(json, "refresh_token"),
        expires_in(json),
    ) else {
        return Err(format!("OpenAI Codex {action} response was missing fields"));
    };
    let account = codex_account_id(&access).ok_or("Failed to extract accountId from token")?;
    Ok(json!({
        "type": "oauth",
        "access": access,
        "refresh": refresh,
        "expires": after(seconds),
        "accountId": account,
    }))
}

/// Pi's `credentialFromTokenResponse` for Sign in with ChatGPT.
pub(super) fn chatgpt_credential(json: &Value, client_id: &str) -> Result<Value> {
    let field = |key: &str| {
        str_field(json, key)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| format!("OpenAI OAuth token response has invalid {key}"))
    };
    let (access, refresh, scope) = (field("access_token")?, field("refresh_token")?, field("scope")?);
    let seconds = expires_in(json)
        .filter(|s| *s > 0.0)
        .ok_or("OpenAI OAuth token response has invalid expires_in")?;
    let scopes: Vec<&str> = scope.split_whitespace().collect();
    if !scopes.contains(&CHATGPT_DIRECT_SCOPE) {
        return Err(format!("OpenAI OAuth grant did not include {CHATGPT_DIRECT_SCOPE}"));
    }
    Ok(json!({
        "type": "oauth",
        "access": access,
        "refresh": refresh,
        "expires": after(seconds).saturating_sub(CHATGPT_EXPIRY_MARGIN_MS),
        "clientId": client_id,
        "scopes": scopes,
    }))
}

/// Pi's xAI `credentialsFromTokenResponse`: a refresh may leave out the
/// refresh token (it wasn't rotated) and the lifetime (an hour).
pub(super) fn xai_credential(json: &Value, previous: Option<&str>) -> Result<Value> {
    let invalid = |f: &str| format!("Invalid xAI OAuth response field: {f}");
    let access = str_field(json, "access_token").ok_or_else(|| invalid("access_token"))?;
    let refresh = match (json.get("refresh_token"), previous) {
        (None, Some(previous)) if !previous.is_empty() => previous.to_string(),
        _ => str_field(json, "refresh_token").ok_or_else(|| invalid("refresh_token"))?,
    };
    let seconds = match json.get("expires_in") {
        None => XAI_DEFAULT_LIFETIME_S as f64,
        Some(_) => expires_in(json)
            .filter(|s| *s > 0.0)
            .ok_or_else(|| invalid("expires_in"))?,
    };
    Ok(json!({
        "type": "oauth",
        "access": access,
        "refresh": refresh,
        "expires": after(seconds).saturating_sub(MINIMUM_VALIDITY_MS),
    }))
}

/// Pi's Kimi `parseTokenResponse`.
pub(super) fn kimi_credential(json: &Value, action: &str) -> Result<Value> {
    let (Some(access), Some(refresh), Some(seconds)) = (
        str_field(json, "access_token"),
        str_field(json, "refresh_token"),
        expires_in(json).filter(|s| *s > 0.0),
    ) else {
        return Err(format!("Kimi Code token {action} response missing fields"));
    };
    Ok(json!({ "type": "oauth", "access": access, "refresh": refresh, "expires": after(seconds) }))
}

/// Pi's `normalizeDomain`: a GitHub Enterprise URL or domain, as a host.
pub(super) fn normalize_domain(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let url = if trimmed.contains("://") {
        reqwest::Url::parse(trimmed)
    } else {
        reqwest::Url::parse(&format!("https://{trimmed}"))
    };
    url.ok()?.host_str().filter(|h| !h.is_empty()).map(String::from)
}

/// Pi's `refreshGitHubCopilotAccessToken`: the GitHub token is exchanged
/// for a short-lived Copilot token. The GitHub token never changes.
pub(super) async fn copilot_token(
    calls: &Calls<'_>,
    github: &str,
    enterprise: Option<&str>,
) -> Result<Map<String, Value>> {
    let domain = enterprise.unwrap_or("github.com");
    let mut request = calls
        .client
        .get(calls.endpoints.copilot_token_url(domain))
        .bearer_auth(github);
    for (name, value) in COPILOT_HEADERS {
        request = request.header(name, value);
    }
    let json = calls.json("GitHub Copilot", request).await?;
    let (Some(token), Some(expires_at)) = (
        str_field(&json, "token"),
        json.get("expires_at").and_then(Value::as_f64),
    ) else {
        return Err("Invalid Copilot token response fields".into());
    };
    let mut credential = Map::new();
    credential.insert("type".into(), "oauth".into());
    credential.insert("refresh".into(), github.into());
    credential.insert("access".into(), token.into());
    credential.insert(
        "expires".into(),
        ((expires_at * 1000.0) as u64).saturating_sub(MINIMUM_VALIDITY_MS).into(),
    );
    if let Some(domain) = enterprise {
        credential.insert("enterpriseUrl".into(), domain.into());
    }
    Ok(credential)
}

/// How hard to retry Copilot's rate limits: Pi's `fetchWithRateLimitRetry`.
#[derive(Clone, Copy)]
pub(super) struct Retry {
    pub max: u32,
    pub budget: Duration,
}

/// One Copilot API request, retried on 429 with Retry-After or doubling
/// waits, within `retry`'s budget. Each try is capped at 5s, as Pi does.
pub(super) async fn copilot_send(
    calls: &Calls<'_>,
    build: impl Fn() -> reqwest::RequestBuilder,
    retry: Retry,
) -> Result<(u16, Value)> {
    let deadline = tokio::time::Instant::now() + retry.budget;
    let mut attempt = 0;
    loop {
        let response = build()
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| format!("GitHub Copilot {} failed: {}", calls.action, e.without_url()))?;
        let status = response.status().as_u16();
        if status != 429 || attempt >= retry.max {
            let body = response.json::<Value>().await.unwrap_or(Value::Null);
            return Ok((status, body));
        }
        let wait = match response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
        {
            Some(value) => match value.trim().parse::<f64>() {
                Ok(seconds) if seconds.is_finite() => Duration::from_secs_f64(seconds.max(0.0)),
                _ => return Ok((status, Value::Null)),
            },
            None => Duration::from_millis(500 * 2u64.pow(attempt)),
        };
        if tokio::time::Instant::now() + wait >= deadline {
            return Ok((status, Value::Null));
        }
        tokio::time::sleep(wait).await;
        attempt += 1;
    }
}

/// Pi's `fetchGitHubCopilotModels`: the account's usable models, and the
/// known ones whose policy he hasn't set yet (Pi turns those on at login).
pub(super) async fn copilot_models(
    calls: &Calls<'_>,
    token: &str,
    enterprise: Option<&str>,
    retry: Retry,
) -> Result<(Vec<String>, Vec<String>)> {
    let base = calls.endpoints.copilot_api(token, enterprise);
    let allow_fallback = base == "https://api.individual.githubcopilot.com";
    let url = format!("{base}/models");
    let (status, body) = copilot_send(
        calls,
        || {
            let mut request = calls
                .client
                .get(&url)
                .header("Accept", "application/json")
                .bearer_auth(token);
            for (name, value) in COPILOT_HEADERS {
                request = request.header(name, value);
            }
            request.header("X-GitHub-Api-Version", COPILOT_API_VERSION)
        },
        retry,
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(format!("GitHub Copilot models request failed ({status})"));
    }
    copilot_catalog(&body, allow_fallback)
}

/// Pi's `parseGitHubCopilotModelCatalog`.
pub(super) fn copilot_catalog(raw: &Value, allow_fallback: bool) -> Result<(Vec<String>, Vec<String>)> {
    let data = raw
        .get("data")
        .and_then(Value::as_array)
        .ok_or("Invalid Copilot models response")?;
    let account: Vec<(String, bool, Option<&str>)> = data
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?;
            let tools = item.pointer("/capabilities/supports/tool_calls");
            if tools == Some(&Value::Bool(false)) {
                return None;
            }
            Some((
                id.to_string(),
                item.get("model_picker_enabled") == Some(&Value::Bool(true)),
                item.pointer("/policy/state").and_then(Value::as_str),
            ))
        })
        .collect();
    let picker: Vec<String> = account
        .iter()
        .filter(|(_, picker, policy)| *picker && *policy != Some("disabled"))
        .map(|(id, ..)| id.clone())
        .collect();
    let use_fallback = allow_fallback && picker.is_empty();
    let available = if !picker.is_empty() || !allow_fallback {
        picker
    } else {
        account
            .iter()
            .filter(|(_, _, policy)| *policy == Some("enabled"))
            .map(|(id, ..)| id.clone())
            .collect()
    };
    let known = |id: &str| super::catalog::models("github-copilot").any(|m| m.id == id);
    let policy = account
        .iter()
        .filter(|(id, picker, policy)| {
            *policy == Some("unconfigured") && known(id) && (*picker || use_fallback)
        })
        .map(|(id, ..)| id.clone())
        .collect();
    Ok((available, policy))
}

/// Pi's `mintApiKey` for Meta: the identity token mints a Model API key
/// that lasts a day. The identity token itself can't be renewed.
pub(super) async fn meta_mint(calls: &Calls<'_>, identity: &str) -> Result<Value> {
    let (status, json) = calls
        .send(
            "Meta",
            calls
                .client
                .post(format!("{}/muse-code/key", calls.endpoints.meta_api))
                .bearer_auth(identity)
                .header("Content-Type", "application/json")
                .header("x-api-version", "1.0.0")
                .body("{}"),
        )
        .await?;
    if status == 401 || status == 403 {
        return Err(format!("Meta session expired ({status}); {}", calls.relogin));
    }
    if !(200..300).contains(&status) {
        return Err(format!("Meta API key mint failed ({status})"));
    }
    let Some(key) = str_field(&json, "api_key") else {
        return Err(match json.get("action_url").and_then(Value::as_str).and_then(trusted_http_url) {
            Some(url) => format!("Meta did not issue an API key. Complete setup at {url}"),
            None => "Meta did not issue an API key.".into(),
        });
    };
    Ok(json!({
        "type": "oauth",
        "refresh": identity,
        "access": key,
        "expires": now_ms() + META_KEY_LIFETIME_MS,
    }))
}

/// Pi's `trustedHttpUrl`: an `http:` or `https:` URL, normalized, or `None`.
/// A server-supplied URL is only ever opened through this.
pub fn trusted_http_url(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

fn refresh_token(current: &Value, name: &str, relogin: &str) -> Result<String> {
    str_field(current, "refresh")
        .ok_or_else(|| format!("{name} login has no refresh token; {relogin}"))
}

/// The same token request pi-ai's `openai-codex` OAuth flow makes.
async fn refresh_codex(calls: &Calls<'_>, current: &Value) -> Result<Value> {
    let refresh = refresh_token(current, "Codex", calls.relogin)?;
    let json = calls
        .json(
            "OpenAI Codex",
            calls
                .client
                .post(format!("{}/oauth/token", calls.endpoints.openai))
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh.as_str()),
                    ("client_id", CODEX_CLIENT_ID),
                ]),
        )
        .await?;
    codex_credential(&json, "token refresh")
}

/// "Sign in with ChatGPT" for the OpenAI API (Pi's `openai-chatgpt.ts`).
async fn refresh_chatgpt(calls: &Calls<'_>, current: &Value) -> Result<Value> {
    let refresh = refresh_token(current, "ChatGPT", calls.relogin)?;
    let client_id = str_field(current, "clientId").ok_or_else(|| {
        format!("Stored OpenAI OAuth credential does not contain an issued client ID; {}", calls.relogin)
    })?;
    let json = calls
        .json(
            "ChatGPT",
            calls
                .client
                .post(format!("{}/api/accounts/oauth/token", calls.endpoints.openai))
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("client_id", client_id.as_str()),
                    ("refresh_token", refresh.as_str()),
                    ("resource", CHATGPT_RESOURCE),
                ]),
        )
        .await?;
    chatgpt_credential(&json, &client_id)
}

/// xAI (Pi's `xai.ts`).
async fn refresh_xai(calls: &Calls<'_>, current: &Value) -> Result<Value> {
    let refresh = refresh_token(current, "xAI", calls.relogin)?;
    let json = calls
        .json(
            "xAI",
            calls
                .client
                .post(format!("{}/oauth2/token", calls.endpoints.xai))
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("client_id", XAI_CLIENT_ID),
                    ("refresh_token", refresh.as_str()),
                ]),
        )
        .await?;
    xai_credential(&json, Some(&refresh))
}

/// Kimi For Coding (Pi's `kimi-coding.ts`).
async fn refresh_kimi(calls: &Calls<'_>, current: &Value) -> Result<Value> {
    let refresh = refresh_token(current, "Kimi", calls.relogin)?;
    let json = calls
        .json(
            "Kimi",
            calls
                .client
                .post(format!("{}/api/oauth/token", calls.endpoints.kimi_host()))
                .form(&[
                    ("client_id", KIMI_CLIENT_ID),
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh.as_str()),
                ]),
        )
        .await?;
    kimi_credential(&json, "refresh")
}

/// GitHub Copilot (Pi's `refreshGitHubCopilotToken`): a new Copilot token
/// for the stored GitHub token, and the account's models again.
async fn refresh_copilot(calls: &Calls<'_>, current: &Value) -> Result<Value> {
    let github = refresh_token(current, "GitHub Copilot", calls.relogin)?;
    let enterprise = str_field(current, "enterpriseUrl").and_then(|u| normalize_domain(&u));
    let mut credential = copilot_token(calls, &github, enterprise.as_deref()).await?;
    let token = str_field(&Value::Object(credential.clone()), "access").unwrap_or_default();
    let (available, _) = copilot_models(
        calls,
        &token,
        enterprise.as_deref(),
        Retry { max: 0, budget: Duration::ZERO },
    )
    .await?;
    credential.insert("availableModelIds".into(), available.into());
    Ok(Value::Object(credential))
}

/// Meta (Pi's `meta.ts`): a new day-long key from the identity token.
async fn refresh_meta(calls: &Calls<'_>, current: &Value) -> Result<Value> {
    let identity = refresh_token(current, "Meta", calls.relogin)?;
    meta_mint(calls, &identity).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(contents: Value) -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(AUTH_FILE), contents.to_string()).unwrap();
        let store = Store::new(dir.path());
        (dir, store)
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[test]
    fn reads_api_keys_and_fresh_oauth_without_touching_the_file() {
        let later = now_ms() + 60 * 60 * 1000;
        let (dir, store) = store_with(json!({
            "zai": { "type": "api_key", "key": "k" },
            "openai-codex": { "type": "oauth", "access": "a", "refresh": "r", "expires": later, "accountId": "acct" },
        }));
        let before = fs::read(dir.path().join(AUTH_FILE)).unwrap();

        assert_eq!(
            block_on(store.auth("zai")).unwrap(),
            Some(Auth::ApiKey("k".into()))
        );
        assert_eq!(
            block_on(store.auth("openai-codex")).unwrap(),
            Some(Auth::Bearer {
                token: "a".into(),
                account_id: Some("acct".into())
            })
        );
        assert_eq!(block_on(store.auth("missing")).unwrap(), None);
        assert_eq!(fs::read(dir.path().join(AUTH_FILE)).unwrap(), before);
        assert!(!dir.path().join("auth.json.lock").exists());
    }

    #[test]
    fn read_only_store_never_locks_or_refreshes_expired_oauth() {
        let (dir, mut store) = store_with(json!({
            "openai-codex": { "type": "oauth", "access": "expired", "refresh": "unused", "expires": 0 }
        }));
        store.read_only = true;
        let before = fs::read(dir.path().join(AUTH_FILE)).unwrap();
        assert!(
            block_on(store.auth("openai-codex"))
                .unwrap_err()
                .contains("outside headless")
        );
        assert_eq!(fs::read(dir.path().join(AUTH_FILE)).unwrap(), before);
        assert!(!dir.path().join("auth.json.lock").exists());
    }

    #[test]
    fn looks_up_kinds_and_expiry() {
        let p = |id| crate::ai::wire::provider(id).unwrap();
        let (_dir, mut store) = store_with(json!({
            "zai": { "type": "api_key", "key": "k" },
            "anthropic": { "type": "oauth", "access": "a", "refresh": "r", "expires": 0 },
            "openai-codex": { "type": "oauth", "access": "a", "refresh": "r", "expires": 0 },
        }));
        assert_eq!(
            store.lookup(p("zai")).unwrap(),
            Lookup::Usable(Kind::ApiKey)
        );
        assert_eq!(store.lookup(p("anthropic")).unwrap(), Lookup::Unsupported);
        assert_eq!(store.lookup(p("openrouter")).unwrap(), Lookup::Missing);
        // Refreshable natively; expired where nothing may be written.
        assert_eq!(
            store.lookup(p("openai-codex")).unwrap(),
            Lookup::Usable(Kind::Oauth)
        );
        store.read_only = true;
        assert_eq!(store.lookup(p("openai-codex")).unwrap(), Lookup::Expired);
    }

    #[test]
    fn a_held_lock_blocks_until_released_and_a_stale_one_is_broken() {
        let (dir, store) = store_with(json!({}));
        let first = store.lock().unwrap();
        let lock_path = dir.path().join("auth.json.lock");
        assert!(lock_path.is_dir());
        drop(first);
        assert!(!lock_path.exists());

        // A lock whose holder died long ago is broken rather than waited on.
        fs::create_dir(&lock_path).unwrap();
        let old = SystemTime::now() - Duration::from_secs(120);
        fs::File::open(&lock_path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let _second = store.lock().unwrap();
    }

    #[test]
    fn writes_preserve_other_providers_and_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, store) = store_with(json!({ "zai": { "type": "api_key", "key": "k" } }));
        let mut map = store.read().unwrap();
        map.insert(
            "openai-codex".into(),
            json!({ "type": "oauth", "access": "a" }),
        );
        store.write(&map).unwrap();
        let reread = store.read().unwrap();
        assert_eq!(reread["zai"]["key"], "k");
        assert_eq!(reread["openai-codex"]["access"], "a");
        let mode = fs::metadata(dir.path().join(AUTH_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn malformed_files_are_reported_by_path_only() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(AUTH_FILE), "{\"zai\": sk-secret-value").unwrap();
        let err = Store::new(dir.path()).read().unwrap_err();
        assert!(!err.contains("sk-secret"), "{err}");
    }

    #[test]
    fn every_pi_provider_id_is_read_and_logins_map_to_keys() {
        let later = now_ms() + 60 * 60 * 1000;
        let (_dir, store) = store_with(json!({
            "groq": { "type": "api_key", "key": "gsk" },
            "mistral": { "type": "api_key", "key": "!security find-generic-password -ws mistral" },
            "deepseek": { "type": "api_key", "key": "${KI60_TEST_UNSET_VAR}" },
            "together": { "type": "api_key", "key": "$FROM_ENV-suffix", "env": { "FROM_ENV": "tg" } },
            "openrouter": { "type": "oauth", "access": "sk-or", "refresh": "", "expires": 9007199254740991u64 },
            "xai": { "type": "oauth", "access": "xai-token", "refresh": "r", "expires": later },
            "github-copilot": { "type": "oauth", "access": "tid=1;proxy-ep=proxy.individual.githubcopilot.com", "refresh": "gho", "expires": 0 },
            "kimi-coding": { "type": "oauth", "access": "k", "refresh": "r", "expires": 0 },
        }));
        let p = |id| crate::ai::wire::provider(id).unwrap();
        assert_eq!(
            block_on(store.auth("groq")).unwrap(),
            Some(Auth::ApiKey("gsk".into()))
        );
        // Pi's `$VAR` templates are read; `!command` is never run.
        assert_eq!(
            block_on(store.auth("together")).unwrap(),
            Some(Auth::ApiKey("tg-suffix".into()))
        );
        assert_eq!(store.lookup(p("mistral")).unwrap(), Lookup::Missing);
        assert_eq!(store.lookup(p("deepseek")).unwrap(), Lookup::Missing);
        // A login's token is used as the provider's key.
        assert_eq!(
            block_on(store.auth("openrouter")).unwrap(),
            Some(Auth::ApiKey("sk-or".into()))
        );
        assert_eq!(
            block_on(store.auth("xai")).unwrap(),
            Some(Auth::ApiKey("xai-token".into()))
        );
        // Refreshable where Pi can refresh them, expired where nothing may
        // be written.
        assert_eq!(
            store.lookup(p("github-copilot")).unwrap(),
            Lookup::Usable(Kind::Oauth)
        );
        assert_eq!(
            store.lookup(p("kimi-coding")).unwrap(),
            Lookup::Usable(Kind::Oauth)
        );
        let mut read_only = Store::new(_dir.path());
        read_only.read_only = true;
        assert_eq!(read_only.lookup(p("kimi-coding")).unwrap(), Lookup::Expired);
        assert!(refreshable("meta") && !refreshable("anthropic") && !refreshable("groq"));
    }

    #[test]
    fn extracts_codex_account_id() {
        let claims = json!({ CODEX_JWT_CLAIM: { "chatgpt_account_id": "acct-123" } });
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string());
        assert_eq!(
            codex_account_id(&format!("h.{payload}.s")),
            Some("acct-123".into())
        );
        assert_eq!(codex_account_id("not-a-jwt"), None);
    }

    /// A JWT whose payload carries a ChatGPT account, as Codex tokens do.
    pub(crate) fn codex_jwt(account: &str, salt: &str) -> String {
        let claims = json!({ CODEX_JWT_CLAIM: { "chatgpt_account_id": account }, "salt": salt });
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string());
        format!("h.{payload}.s")
    }

    /// A token server: counts token requests and rotates the refresh token
    /// each time, as OpenAI does; answers slowly so racers overlap.
    async fn rotating_server() -> (String, Arc<Mutex<Vec<String>>>) {
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let log = seen.clone();
        let app = axum::Router::new().fallback(move |uri: axum::http::Uri, body: String| {
            let log = log.clone();
            async move {
                let n = {
                    let mut log = log.lock().unwrap();
                    log.push(format!("{} {body}", uri.path()));
                    log.len()
                };
                tokio::time::sleep(Duration::from_millis(150)).await;
                axum::Json(json!({
                    "access_token": codex_jwt("acct", &n.to_string()),
                    "refresh_token": format!("refresh-{n}"),
                    "expires_in": 3600,
                }))
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, seen)
    }

    #[test]
    fn kintsugi_refreshes_its_own_login_once_under_the_lock_and_writes_the_rotated_token() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (base, seen) = rotating_server().await;
            let dir = tempfile::tempdir().unwrap();
            let endpoints = Endpoints { openai: base, ..Endpoints::default() };
            let store = Store::kintsugi(dir.path()).with_endpoints(endpoints);
            store
                .save(
                    "openai-codex",
                    json!({ "type": "oauth", "access": "old", "refresh": "refresh-0", "expires": 0, "accountId": "acct" }),
                )
                .unwrap();
            // Two requests at once: only one refresh reaches the server, and
            // the other uses its token rather than spending the old one.
            let (a, b) = tokio::join!(store.auth("openai-codex"), store.auth("openai-codex"));
            let (a, b) = (a.unwrap().unwrap(), b.unwrap().unwrap());
            assert_eq!(a, b);
            let seen = seen.lock().unwrap().clone();
            assert_eq!(seen.len(), 1, "{seen:?}");
            assert!(seen[0].starts_with("/oauth/token "), "{seen:?}");
            assert!(seen[0].contains("grant_type=refresh_token") && seen[0].contains("refresh_token=refresh-0"));
            let saved = store.read().unwrap()["openai-codex"].clone();
            assert_eq!(saved["refresh"], "refresh-1");
            assert_eq!(saved["accountId"], "acct");
            // Pi's credentialsFromToken, field for field.
            let mut keys: Vec<_> = saved.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            assert_eq!(keys, ["access", "accountId", "expires", "refresh", "type"]);
            assert!(!dir.path().join("auth.json.lock").exists());
        });
    }

    #[test]
    fn the_kintsugi_file_is_created_owner_only_in_its_own_folder() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("dev.phalasiya.kintsugi");
        let store = Store::kintsugi(&dir);
        assert_eq!(store.held("groq").unwrap(), None);
        store.save("groq", json!({ "type": "api_key", "key": literal_key("gsk-1") })).unwrap();
        store.save("zai", json!({ "type": "api_key", "key": "zk" })).unwrap();
        store.remove("zai").unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.join(AUTH_FILE)), 0o600);
        assert_eq!(mode(&dir), 0o700);
        let text = fs::read_to_string(dir.join(AUTH_FILE)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), json!({ "groq": { "type": "api_key", "key": "gsk-1" } }));
        assert_eq!(store.held("groq").unwrap(), Some(Kind::ApiKey));
        assert_eq!(block_on(store.auth("groq")).unwrap(), Some(Auth::ApiKey("gsk-1".into())));
        assert!(!dir.join("auth.json.lock").exists());
        // Only the lock and the file: no stray temp files.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn keys_are_stored_so_they_read_back_literally() {
        for key in ["sk-plain", "has$dollar", "$LOOKS_LIKE_VAR", "!not-a-command", "a$$b", "${X}"] {
            let cred = json!({ "type": "api_key", "key": literal_key(key) });
            assert_eq!(api_key(&cred).as_deref(), Some(key), "{key}");
        }
    }

    #[test]
    fn a_memory_store_saves_and_removes_but_never_refreshes_or_touches_disk() {
        let store = Store::memory();
        assert_eq!(store.owner(), Owner::Kintsugi);
        store.save("groq", json!({ "type": "api_key", "key": "gsk" })).unwrap();
        store.save("xai", json!({ "type": "oauth", "access": "a", "refresh": "r", "expires": 0 })).unwrap();
        let p = |id| crate::ai::wire::provider(id).unwrap();
        assert_eq!(store.lookup(p("groq")).unwrap(), Lookup::Usable(Kind::ApiKey));
        assert_eq!(store.lookup(p("xai")).unwrap(), Lookup::Expired);
        assert!(block_on(store.auth("xai")).unwrap_err().contains("outside headless"));
        store.remove("groq").unwrap();
        assert_eq!(store.held("groq").unwrap(), None);
        // A read-only file store refuses writes.
        let (_dir, mut file) = store_with(json!({}));
        file.read_only = true;
        assert!(file.save("groq", json!({})).is_err());
    }

    #[test]
    fn copilot_api_follows_the_token_then_the_enterprise() {
        let e = Endpoints::default();
        assert_eq!(e.copilot_api("tid=1;proxy-ep=proxy.business.githubcopilot.com;x", None), "https://api.business.githubcopilot.com");
        assert_eq!(e.copilot_api("opaque", Some("acme.ghe.com")), "https://copilot-api.acme.ghe.com");
        assert_eq!(e.copilot_api("opaque", None), "https://api.individual.githubcopilot.com");
        assert_eq!(normalize_domain(" https://acme.ghe.com/login "), Some("acme.ghe.com".into()));
        assert_eq!(normalize_domain("acme.ghe.com"), Some("acme.ghe.com".into()));
        assert_eq!(normalize_domain("  "), None);
        assert_eq!(trusted_http_url("file:///etc/passwd"), None);
        assert_eq!(trusted_http_url("https://github.com/login/device").as_deref(), Some("https://github.com/login/device"));
    }
}
