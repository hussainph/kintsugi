//! Pi's credentials, read from (and refreshed into) Pi's own file.
//!
//! Kintsugi stores no credentials of its own. Logging in happens in the `pi`
//! CLI, which writes `~/.pi/agent/auth.json` (or `$PI_CODING_AGENT_DIR`):
//! `{ "<providerId>": { "type": "api_key", "key": … } | { "type": "oauth",
//! "access", "refresh", "expires", … } }`. Kintsugi reads that file, and when
//! an OAuth token is about to expire it refreshes it and writes the rotated
//! token back, so Pi and every other app sharing the file stay logged in.
//!
//! Every provider id Pi uses is read the same way: an API key for any of
//! them, and the logins Pi offers: ChatGPT for Codex (`openai-codex`) and
//! for the OpenAI API (`openai`), GitHub Copilot, Kimi For Coding, xAI, Meta
//! and OpenRouter, each refreshed the way Pi does it (`src/auth/oauth/` in
//! pi-ai 1.5.0). A Claude subscription login is never used. A key Pi stores
//! as `$VAR` is read from the environment; one stored as `!command` would
//! need a shell command run, which Kintsugi never does, so it counts as
//! absent.
//!
//! The write path copies Pi's lock discipline: `proper-lockfile` takes an
//! advisory lock by creating the directory `auth.json.lock` and treats it as
//! stale after 30s. Holding that lock across read-refresh-write matters
//! because OpenAI rotates refresh tokens: two unlocked refreshers would each
//! spend the same refresh token, and the loser's write would log Pi out. A
//! refresh is capped at 15s, well inside the stale window, so the lock never
//! needs its mtime touched while held.
//!
//! Secrets never reach an error message: a malformed file is reported by
//! path alone, because serde's messages can quote the offending text.

use base64::Engine;
use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const AUTH_FILE: &str = "auth.json";
const LOCK_STALE: Duration = Duration::from_secs(30);
const LOCK_WAIT: Duration = Duration::from_secs(20);
/// Refresh when a token has less than this left, as pi-ai does.
const MINIMUM_VALIDITY_MS: u64 = 5 * 60 * 1000;
const REFRESH_TIMEOUT: Duration = Duration::from_secs(15);

const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_JWT_CLAIM: &str = "https://api.openai.com/auth";
// The other logins Pi holds (pi-ai 1.5.0, `src/auth/oauth/*.ts`).
const CHATGPT_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const CHATGPT_RESOURCE: &str = "https://api.openai.com/v1";
const XAI_TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
const XAI_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const KIMI_HOST: &str = "https://auth.kimi.com";
const KIMI_CLIENT_ID: &str = "17e5f671-d194-4dfb-9706-5516cb48c098";
const META_KEY_URL: &str = "https://api.meta.ai/muse-code/key";
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

pub struct Store {
    path: PathBuf,
    read_only: bool,
}

impl Store {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join(AUTH_FILE),
            read_only: false,
        }
    }

    pub fn default_location() -> Result<Self> {
        let mut store = Self::new(&agent_dir()?);
        // Headless never locks, refreshes, rotates or writes Pi credentials.
        store.read_only = cfg!(feature = "headless");
        Ok(store)
    }

    fn read(&self) -> Result<Map<String, Value>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
            Err(_) => return Err(format!("could not read {}", self.path.display())),
        };
        match serde_json::from_str(&text) {
            Ok(Value::Object(map)) => Ok(map),
            _ => Err(format!(
                "{} is not valid credentials JSON",
                self.path.display()
            )),
        }
    }

    /// Whole-file atomic replace, owner-only, like the `pi` CLI leaves it.
    fn write(&self, map: &Map<String, Value>) -> Result<()> {
        use std::os::unix::fs::OpenOptionsExt;
        let tmp = self
            .path
            .with_file_name(format!(".{AUTH_FILE}.kintsugi-{}", std::process::id()));
        let fail = |_| format!("could not write {}", self.path.display());
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
        fs::rename(&tmp, &self.path).map_err(fail)
    }

    fn lock(&self) -> Result<Lock> {
        let path = self.path.with_file_name(format!("{AUTH_FILE}.lock"));
        let deadline = SystemTime::now() + LOCK_WAIT;
        loop {
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Lock(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .map(|t| t.elapsed().unwrap_or_default() > LOCK_STALE)
                        .unwrap_or(false);
                    if stale {
                        let _ = fs::remove_dir(&path);
                    } else if SystemTime::now() > deadline {
                        return Err("timed out waiting for Pi's credentials lock".into());
                    } else {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
                Err(_) => return Err(format!("could not lock {}", self.path.display())),
            }
        }
    }

    /// What Pi holds for `provider`, without the secret. An expiring Codex
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

    /// A usable credential for `provider`, refreshing an expiring OAuth token
    /// first. `None` when Pi holds nothing for it.
    pub async fn auth(&self, provider: &str) -> Result<Option<Auth>> {
        let Some(cred) = self.read()?.remove(provider) else {
            return Ok(None);
        };
        match kind(&cred) {
            Some(Kind::ApiKey) => Ok(api_key(&cred).map(Auth::ApiKey)),
            Some(Kind::Oauth) if fresh(&cred) => Ok(Some(login(provider, &cred)?)),
            Some(Kind::Oauth) if self.read_only => {
                Err("Pi login expired; refresh it outside headless mode".into())
            }
            Some(Kind::Oauth) => {
                // Detached: a cancelled caller (a new keystroke aborts a
                // completion) must not drop a refresh midway, after the
                // server has rotated the refresh token but before the new
                // one is written; that would log Pi out (Pi lets a started
                // refresh finish, too).
                let store = Store {
                    path: self.path.clone(),
                    read_only: self.read_only,
                };
                let provider = provider.to_string();
                tokio::spawn(async move { store.refresh(&provider).await })
                    .await
                    .map_err(|_| "Pi login refresh stopped".to_string())?
                    .map(Some)
            }
            None => Err(format!("unrecognised credential for {provider}")),
        }
    }

    /// Refresh under Pi's lock, re-reading inside it: another process may
    /// already have refreshed, in which case its token is used as-is.
    async fn refresh(&self, provider: &str) -> Result<Auth> {
        if self.read_only {
            return Err("Pi login expired; refresh it outside headless mode".into());
        }
        let store = Store {
            path: self.path.clone(),
            read_only: self.read_only,
        };
        let provider = provider.to_string();
        let (lock, mut map) = tokio::task::spawn_blocking(move || {
            let lock = store.lock()?;
            store.read().map(|map| (lock, map))
        })
        .await
        .map_err(|e| e.to_string())??;

        let current = map
            .get(&provider)
            .cloned()
            .ok_or("credential disappeared during refresh")?;
        if fresh(&current) {
            drop(lock);
            return login(&provider, &current);
        }
        let updated = match provider.as_str() {
            "openai-codex" => refresh_codex(&current).await?,
            "openai" => refresh_chatgpt(&current).await?,
            "xai" => refresh_xai(&current).await?,
            "kimi-coding" => refresh_kimi(&current).await?,
            "github-copilot" => refresh_copilot(&current).await?,
            "meta" => refresh_meta(&current).await?,
            other => {
                return Err(format!(
                    "Kintsugi can't refresh {other} logins yet; use an API key"
                ));
            }
        };
        map.insert(provider.clone(), updated.clone());
        let store = Store {
            path: self.path.clone(),
            read_only: self.read_only,
        };
        tokio::task::spawn_blocking(move || {
            let result = store.write(&map);
            drop(lock);
            result
        })
        .await
        .map_err(|e| e.to_string())??;
        login(&provider, &updated)
    }
}

struct Lock(PathBuf);

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

fn kind(cred: &Value) -> Option<Kind> {
    match cred.get("type")?.as_str()? {
        "api_key" => Some(Kind::ApiKey),
        "oauth" => Some(Kind::Oauth),
        _ => None,
    }
}

fn str_field(cred: &Value, key: &str) -> Option<String> {
    cred.get(key)?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn now_ms() -> u64 {
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
/// other login Pi holds is used as its provider's key (Pi's `toAuth`: an
/// OpenRouter or Meta key, an xAI, Kimi, ChatGPT or Copilot token).
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

/// Pi logins Kintsugi can refresh (under Pi's lock, natively only). An
/// OpenRouter login is a key that never expires.
fn refreshable(provider: &str) -> bool {
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
        .map(String::from)
}

/// The same token request pi-ai's `openai-codex` OAuth flow makes.
async fn refresh_codex(current: &Value) -> Result<Value> {
    let refresh = str_field(current, "refresh")
        .ok_or("Codex login has no refresh token; run `pi` and log in again")?;
    let response = reqwest::Client::new()
        .post(CODEX_TOKEN_URL)
        .timeout(REFRESH_TIMEOUT)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
            ("client_id", CODEX_CLIENT_ID),
        ])
        .send()
        .await
        .map_err(|e| format!("Codex token refresh failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Codex token refresh failed ({status}); run `pi` and log in again"
        ));
    }
    let json: Value = response
        .json()
        .await
        .map_err(|_| "Codex token refresh returned bad JSON")?;
    let (Some(access), Some(refresh), Some(expires_in)) = (
        str_field(&json, "access_token"),
        str_field(&json, "refresh_token"),
        json.get("expires_in").and_then(Value::as_u64),
    ) else {
        return Err("Codex token refresh response was missing fields".into());
    };
    let account_id = codex_account_id(&access).ok_or("Codex token has no account id")?;

    // Keep whatever else Pi stored alongside the tokens.
    let mut updated = current.as_object().cloned().unwrap_or_default();
    updated.insert("type".into(), "oauth".into());
    updated.insert("access".into(), access.into());
    updated.insert("refresh".into(), refresh.into());
    updated.insert(
        "expires".into(),
        (now_ms().saturating_add(expires_in.saturating_mul(1000))).into(),
    );
    updated.insert("accountId".into(), account_id.into());
    Ok(Value::Object(updated))
}

/// One token request's JSON answer; errors name the provider, never a token.
async fn token_json(name: &str, request: reqwest::RequestBuilder) -> Result<Value> {
    let response = request
        .timeout(REFRESH_TIMEOUT)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("{name} token refresh failed: {}", e.without_url()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "{name} token refresh failed ({status}); run `pi` and log in again"
        ));
    }
    response
        .json()
        .await
        .map_err(|_| format!("{name} token refresh returned bad JSON"))
}

/// The stored login with new tokens; everything else Pi stored is kept.
fn renewed(current: &Value, access: String, refresh: Option<String>, expires: u64) -> Value {
    let mut updated = current.as_object().cloned().unwrap_or_default();
    updated.insert("type".into(), "oauth".into());
    updated.insert("access".into(), access.into());
    if let Some(refresh) = refresh {
        updated.insert("refresh".into(), refresh.into());
    }
    updated.insert("expires".into(), expires.into());
    Value::Object(updated)
}

fn refresh_token(current: &Value, name: &str) -> Result<String> {
    str_field(current, "refresh")
        .ok_or_else(|| format!("{name} login has no refresh token; run `pi` and log in again"))
}

/// "Sign in with ChatGPT" for the OpenAI API (Pi's `openai-chatgpt.ts`).
async fn refresh_chatgpt(current: &Value) -> Result<Value> {
    let refresh = refresh_token(current, "ChatGPT")?;
    let client_id = str_field(current, "clientId").ok_or("ChatGPT login has no client id")?;
    let json = token_json(
        "ChatGPT",
        reqwest::Client::new().post(CHATGPT_TOKEN_URL).form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("refresh_token", refresh.as_str()),
            ("resource", CHATGPT_RESOURCE),
        ]),
    )
    .await?;
    let (Some(access), Some(expires_in)) = (
        str_field(&json, "access_token"),
        json.get("expires_in").and_then(Value::as_u64),
    ) else {
        return Err("ChatGPT token refresh response was missing fields".into());
    };
    let mut updated = renewed(
        current,
        access,
        str_field(&json, "refresh_token"),
        (now_ms().saturating_add(expires_in.saturating_mul(1000))).saturating_sub(3 * 60 * 1000),
    );
    if let Some(scope) = str_field(&json, "scope") {
        updated["scopes"] = scope.split_whitespace().collect::<Vec<_>>().into();
    }
    Ok(updated)
}

/// xAI (Pi's `xai.ts`): a missing refresh token keeps the old one, a
/// missing lifetime is an hour.
async fn refresh_xai(current: &Value) -> Result<Value> {
    let refresh = refresh_token(current, "xAI")?;
    let json = token_json(
        "xAI",
        reqwest::Client::new().post(XAI_TOKEN_URL).form(&[
            ("grant_type", "refresh_token"),
            ("client_id", XAI_CLIENT_ID),
            ("refresh_token", refresh.as_str()),
        ]),
    )
    .await?;
    let access =
        str_field(&json, "access_token").ok_or("xAI token refresh response was missing fields")?;
    let expires_in = json
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(3600);
    Ok(renewed(
        current,
        access,
        str_field(&json, "refresh_token"),
        (now_ms().saturating_add(expires_in.saturating_mul(1000)))
            .saturating_sub(MINIMUM_VALIDITY_MS),
    ))
}

/// Kimi For Coding (Pi's `kimi-coding.ts`).
async fn refresh_kimi(current: &Value) -> Result<Value> {
    let refresh = refresh_token(current, "Kimi")?;
    let host = ["KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| KIMI_HOST.into());
    let json = token_json(
        "Kimi",
        reqwest::Client::new()
            .post(format!("{}/api/oauth/token", host.trim_end_matches('/')))
            .form(&[
                ("client_id", KIMI_CLIENT_ID),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
            ]),
    )
    .await?;
    let (Some(access), Some(refresh), Some(expires_in)) = (
        str_field(&json, "access_token"),
        str_field(&json, "refresh_token"),
        json.get("expires_in").and_then(Value::as_u64),
    ) else {
        return Err("Kimi token refresh response was missing fields".into());
    };
    Ok(renewed(
        current,
        access,
        Some(refresh),
        now_ms().saturating_add(expires_in.saturating_mul(1000)),
    ))
}

/// GitHub Copilot (Pi's `github-copilot.ts`): the stored GitHub token is
/// exchanged for a short-lived Copilot token; the GitHub token itself
/// never changes.
async fn refresh_copilot(current: &Value) -> Result<Value> {
    let github = refresh_token(current, "GitHub Copilot")?;
    let domain = str_field(current, "enterpriseUrl").unwrap_or_else(|| "github.com".into());
    let mut request = reqwest::Client::new()
        .get(format!("https://api.{domain}/copilot_internal/v2/token"))
        .bearer_auth(github);
    for (name, value) in COPILOT_HEADERS {
        request = request.header(name, value);
    }
    let json = token_json("GitHub Copilot", request).await?;
    let (Some(token), Some(expires_at)) = (
        str_field(&json, "token"),
        json.get("expires_at").and_then(Value::as_u64),
    ) else {
        return Err("GitHub Copilot token response was missing fields".into());
    };
    Ok(renewed(
        current,
        token,
        None,
        expires_at
            .saturating_mul(1000)
            .saturating_sub(MINIMUM_VALIDITY_MS),
    ))
}

/// Meta (Pi's `meta.ts`): the stored identity token mints an API key that
/// lasts a day.
async fn refresh_meta(current: &Value) -> Result<Value> {
    let identity = refresh_token(current, "Meta")?;
    let json = token_json(
        "Meta",
        reqwest::Client::new()
            .post(META_KEY_URL)
            .bearer_auth(identity)
            .header("x-api-version", "1.0.0")
            .json(&serde_json::json!({})),
    )
    .await?;
    let key =
        str_field(&json, "api_key").ok_or("Meta needs setting up again; run `pi` and log in")?;
    Ok(renewed(current, key, None, now_ms() + 24 * 60 * 60 * 1000))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
}
