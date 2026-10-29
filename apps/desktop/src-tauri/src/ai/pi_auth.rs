//! Pi's credentials, read from (and refreshed into) Pi's own file.
//!
//! Kintsugi stores no credentials of its own. Logging in happens in the `pi`
//! CLI, which writes `~/.pi/agent/auth.json` (or `$PI_CODING_AGENT_DIR`):
//! `{ "<providerId>": { "type": "api_key", "key": … } | { "type": "oauth",
//! "access", "refresh", "expires", … } }`. Kintsugi reads that file, and when
//! an OAuth token is about to expire it refreshes it and writes the rotated
//! token back, so Pi and every other app sharing the file stay logged in.
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

type Result<T> = std::result::Result<T, String>;

/// What a request needs to authenticate.
#[derive(Debug, Clone, PartialEq)]
pub enum Auth {
    ApiKey(String),
    /// An OAuth access token, plus the ChatGPT account id Codex requires.
    Bearer { token: String, account_id: Option<String> },
}

/// Non-secret: which kind of credential Pi holds for a provider.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    ApiKey,
    Oauth,
}

/// `$PI_CODING_AGENT_DIR` (with `~` expanded), else `~/.pi/agent`: Pi's own rule.
pub fn agent_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME is not set")?;
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
        Self { path: dir.join(AUTH_FILE), read_only: false }
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
            _ => Err(format!("{} is not valid credentials JSON", self.path.display())),
        }
    }

    /// Whole-file atomic replace, owner-only, like the `pi` CLI leaves it.
    fn write(&self, map: &Map<String, Value>) -> Result<()> {
        use std::os::unix::fs::OpenOptionsExt;
        let tmp = self.path.with_file_name(format!(".{AUTH_FILE}.kintsugi-{}", std::process::id()));
        let fail = |_| format!("could not write {}", self.path.display());
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(fail)?;
        let bytes = serde_json::to_vec_pretty(map).map_err(|_| "could not encode credentials".to_string())?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(fail)?;
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

    /// Every provider Pi holds a credential for.
    pub fn list(&self) -> Result<Vec<(String, Kind)>> {
        Ok(self
            .read()?
            .into_iter()
            .filter_map(|(id, cred)| kind(&cred).map(|k| (id, k)))
            .collect())
    }

    /// A usable credential for `provider`, refreshing an expiring OAuth token
    /// first. `None` when Pi holds nothing for it.
    pub async fn auth(&self, provider: &str) -> Result<Option<Auth>> {
        let Some(cred) = self.read()?.remove(provider) else { return Ok(None) };
        match kind(&cred) {
            Some(Kind::ApiKey) => Ok(str_field(&cred, "key").map(Auth::ApiKey)),
            Some(Kind::Oauth) if fresh(&cred) => Ok(Some(bearer(&cred)?)),
            Some(Kind::Oauth) if self.read_only => Err("Pi login expired; refresh it outside headless mode".into()),
            Some(Kind::Oauth) => self.refresh(provider).await.map(Some),
            None => Err(format!("unrecognised credential for {provider}")),
        }
    }

    /// Refresh under Pi's lock, re-reading inside it: another process may
    /// already have refreshed, in which case its token is used as-is.
    async fn refresh(&self, provider: &str) -> Result<Auth> {
        let store = Store { path: self.path.clone(), read_only: self.read_only };
        let provider = provider.to_string();
        let (lock, mut map) = tokio::task::spawn_blocking(move || {
            let lock = store.lock()?;
            store.read().map(|map| (lock, map))
        })
        .await
        .map_err(|e| e.to_string())??;

        let current = map.get(&provider).cloned().ok_or("credential disappeared during refresh")?;
        if fresh(&current) {
            drop(lock);
            return bearer(&current);
        }
        let updated = match provider.as_str() {
            "openai-codex" => refresh_codex(&current).await?,
            other => return Err(format!("Kintsugi can't refresh {other} logins yet; use an API key")),
        };
        map.insert(provider, updated.clone());
        let store = Store { path: self.path.clone(), read_only: self.read_only };
        tokio::task::spawn_blocking(move || {
            let result = store.write(&map);
            drop(lock);
            result
        })
        .await
        .map_err(|e| e.to_string())??;
        bearer(&updated)
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
    cred.get(key)?.as_str().filter(|s| !s.is_empty()).map(String::from)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn fresh(cred: &Value) -> bool {
    cred.get("expires")
        .and_then(Value::as_u64)
        .is_some_and(|expires| now_ms() + MINIMUM_VALIDITY_MS < expires)
}

fn bearer(cred: &Value) -> Result<Auth> {
    Ok(Auth::Bearer {
        token: str_field(cred, "access").ok_or("OAuth credential has no access token")?,
        account_id: str_field(cred, "accountId"),
    })
}

/// The ChatGPT account id inside a Codex access token (a JWT).
pub fn codex_account_id(access: &str) -> Option<String> {
    let payload = access.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    claims.get(CODEX_JWT_CLAIM)?.get("chatgpt_account_id")?.as_str().map(String::from)
}

/// The same token request pi-ai's `openai-codex` OAuth flow makes.
async fn refresh_codex(current: &Value) -> Result<Value> {
    let refresh = str_field(current, "refresh").ok_or("Codex login has no refresh token; run `pi` and log in again")?;
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
        return Err(format!("Codex token refresh failed ({status}); run `pi` and log in again"));
    }
    let json: Value = response.json().await.map_err(|_| "Codex token refresh returned bad JSON")?;
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
    updated.insert("expires".into(), (now_ms() + expires_in * 1000).into());
    updated.insert("accountId".into(), account_id.into());
    Ok(Value::Object(updated))
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
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    #[test]
    fn reads_api_keys_and_fresh_oauth_without_touching_the_file() {
        let later = now_ms() + 60 * 60 * 1000;
        let (dir, store) = store_with(json!({
            "zai": { "type": "api_key", "key": "k" },
            "openai-codex": { "type": "oauth", "access": "a", "refresh": "r", "expires": later, "accountId": "acct" },
        }));
        let before = fs::read(dir.path().join(AUTH_FILE)).unwrap();

        assert_eq!(block_on(store.auth("zai")).unwrap(), Some(Auth::ApiKey("k".into())));
        assert_eq!(
            block_on(store.auth("openai-codex")).unwrap(),
            Some(Auth::Bearer { token: "a".into(), account_id: Some("acct".into()) })
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
        assert!(block_on(store.auth("openai-codex")).unwrap_err().contains("outside headless"));
        assert_eq!(fs::read(dir.path().join(AUTH_FILE)).unwrap(), before);
        assert!(!dir.path().join("auth.json.lock").exists());
    }

    #[test]
    fn lists_kinds() {
        let (_dir, store) = store_with(json!({
            "zai": { "type": "api_key", "key": "k" },
            "anthropic": { "type": "oauth", "access": "a", "refresh": "r", "expires": 0 },
        }));
        let mut kinds = store.list().unwrap();
        kinds.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(kinds, vec![("anthropic".into(), Kind::Oauth), ("zai".into(), Kind::ApiKey)]);
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
        fs::File::open(&lock_path).unwrap().set_modified(old).unwrap();
        let _second = store.lock().unwrap();
    }

    #[test]
    fn writes_preserve_other_providers_and_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, store) = store_with(json!({ "zai": { "type": "api_key", "key": "k" } }));
        let mut map = store.read().unwrap();
        map.insert("openai-codex".into(), json!({ "type": "oauth", "access": "a" }));
        store.write(&map).unwrap();
        let reread = store.read().unwrap();
        assert_eq!(reread["zai"]["key"], "k");
        assert_eq!(reread["openai-codex"]["access"], "a");
        let mode = fs::metadata(dir.path().join(AUTH_FILE)).unwrap().permissions().mode();
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
    fn extracts_codex_account_id() {
        let claims = json!({ CODEX_JWT_CLAIM: { "chatgpt_account_id": "acct-123" } });
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string());
        assert_eq!(codex_account_id(&format!("h.{payload}.s")), Some("acct-123".into()));
        assert_eq!(codex_account_id("not-a-jwt"), None);
    }
}
