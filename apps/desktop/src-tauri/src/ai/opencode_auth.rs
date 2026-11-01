//! OpenCode's credentials, read (never written) from OpenCode's own store.
//!
//! Logging in happens in OpenCode (`opencode auth login`, or `/connect` in
//! its TUI). Both stores live in OpenCode's data folder,
//! `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`, on macOS
//! too):
//!
//! - **OpenCode 2** keeps credentials in its SQLite database `opencode.db`
//!   (`$OPENCODE_DB` overrides it), table `credential`: one row per login
//!   with `integration_id` (the provider id), `active`, `time_created` and a
//!   JSON `value`, `{ "type": "key", "key", "metadata"? }` or
//!   `{ "type": "oauth", "methodID", "refresh", "access", "expires",
//!   "metadata": { "accountID"? }? }` (`expires` in epoch ms). A provider's
//!   login is its active row, else its newest (`packages/core/src/credential.ts`,
//!   `integration.ts` in OpenCode v2.0.32).
//! - **OpenCode 1** kept them in `auth.json`: `{ "<providerId>": { "type":
//!   "api", "key" } | { "type": "oauth", "refresh", "access", "expires",
//!   "accountId"? } }`. OpenCode 2 imports that file into the database once
//!   and never touches it again, so it's read only when there is no
//!   database.
//!
//! **Read-only, always.** The database is opened read-only, the legacy file
//! only read. OpenCode 2.0.32 refreshes and rotates OAuth tokens with no
//! cross-process lock (a later OpenCode adds a private flock), and OpenAI
//! rotates refresh tokens: a refresh here racing one in OpenCode would spend
//! the same refresh token twice and log one of them out, and writing another
//! app's database is not safe anyway. So Kintsugi never refreshes an
//! OpenCode login: an expired one is reported as expired, and opening
//! OpenCode once refreshes it.
//!
//! OpenCode's provider ids are mapped to Kintsugi's: `openai` is an OpenAI
//! API key, or (as a ChatGPT login) the Codex backend; `zai-coding-plan`
//! (else `zai`) is Kintsugi's `zai`; `opencode` is OpenCode Zen and
//! `opencode-go` OpenCode Go.
//!
//! Secrets never reach an error message: a store that can't be read is
//! reported by path alone.

use super::credentials::{Kind, Lookup};
use super::pi_auth::{Auth, codex_account_id};
use super::wire::{Provider, Wire};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type Result<T> = std::result::Result<T, String>;

const DATABASE: &str = "opencode.db";
const LEGACY_FILE: &str = "auth.json";
/// A login with less than this left is treated as expired, as OpenCode does.
const MINIMUM_VALIDITY_MS: u64 = 5 * 60 * 1000;
/// ChatGPT's newer sign-in calls api.openai.com with a scoped token, not the
/// Codex backend Kintsugi speaks.
const TOKEN_SHARING: &str = "chatgpt-token-sharing";

/// OpenCode's data directory: `$XDG_DATA_HOME/opencode` (absolute paths
/// only, per the XDG spec), else `~/.local/share/opencode`.
pub fn data_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME is not set")?;
    let base = match std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
        Some(dir) if dir.is_absolute() => dir,
        _ => home.join(".local").join("share"),
    };
    Ok(base.join("opencode"))
}

/// The OpenCode provider ids that hold a credential for a Kintsugi
/// provider, most specific first, and which kinds of credential count.
fn sources(provider: &str) -> &'static [(&'static str, Want)] {
    match provider {
        "anthropic" => &[("anthropic", Want::Any)],
        "openai" => &[("openai", Want::ApiKey)],
        "openai-codex" => &[("openai", Want::Oauth)],
        "openrouter" => &[("openrouter", Want::Any)],
        "zai" => &[("zai-coding-plan", Want::Any), ("zai", Want::Any)],
        "opencode" => &[("opencode", Want::Any)],
        "opencode-go" => &[("opencode-go", Want::Any)],
        _ => &[],
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Want {
    Any,
    ApiKey,
    Oauth,
}

/// One credential, in either store's format.
#[derive(Debug, Clone, PartialEq)]
enum Cred {
    Key(String),
    Oauth { access: String, expires: u64, account_id: Option<String>, method: Option<String> },
}

impl Cred {
    fn kind(&self) -> Kind {
        match self {
            Cred::Key(_) => Kind::ApiKey,
            Cred::Oauth { .. } => Kind::Oauth,
        }
    }

    /// Either store's JSON; anything else (`external`, `wellknown`, empty
    /// secrets) is no usable credential.
    fn parse(value: &Value) -> Option<Cred> {
        let text = |key: &str| value.get(key)?.as_str().filter(|s| !s.is_empty()).map(String::from);
        match value.get("type")?.as_str()? {
            "key" | "api" => text("key").map(Cred::Key),
            "oauth" => {
                let meta = |key: &str| {
                    ["metadata", "configuration"]
                        .iter()
                        .find_map(|m| value.get(*m)?.get(key)?.as_str().map(String::from))
                };
                Some(Cred::Oauth {
                    access: text("access")?,
                    expires: value.get("expires").and_then(Value::as_u64).unwrap_or(0),
                    account_id: meta("accountID").or_else(|| text("accountId")),
                    method: text("methodID"),
                })
            }
            _ => None,
        }
    }
}

pub struct Store {
    database: PathBuf,
    legacy: PathBuf,
}

impl Store {
    pub fn new(dir: &Path) -> Self {
        Self { database: dir.join(DATABASE), legacy: dir.join(LEGACY_FILE) }
    }

    /// OpenCode's own rule: `$OPENCODE_DB` (absolute) or `<data>/opencode.db`.
    pub fn default_location() -> Result<Self> {
        let mut store = Self::new(&data_dir()?);
        if let Some(db) = std::env::var_os("OPENCODE_DB").map(PathBuf::from).filter(|p| p.is_absolute()) {
            store.database = db;
        }
        Ok(store)
    }

    /// Every provider's login: from the database when there is one, else
    /// from the legacy file.
    fn read(&self) -> Result<HashMap<String, Cred>> {
        if self.database.is_file() {
            return self.read_database();
        }
        let text = match fs::read_to_string(&self.legacy) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(_) => return Err(format!("could not read {}", self.legacy.display())),
        };
        match serde_json::from_str(&text) {
            Ok(Value::Object(map)) => Ok(map
                .into_iter()
                .filter_map(|(id, v)| Some((id.trim_end_matches('/').to_string(), Cred::parse(&v)?)))
                .collect()),
            _ => Err(format!("{} is not valid credentials JSON", self.legacy.display())),
        }
    }

    fn read_database(&self) -> Result<HashMap<String, Cred>> {
        use rusqlite::{Connection, OpenFlags};
        let fail = |_| format!("could not read OpenCode's credentials in {}", self.database.display());
        // Read-only: never creates, migrates or writes the database, and
        // creates no file beside it. OpenCode runs it in WAL mode. With no
        // `-wal` file every row is in the main file, which is then opened
        // `immutable` (no journal, no lock files). With OpenCode's `-wal` and
        // `-shm` present, a read-only connection reads through them as any
        // reader does; SQLite's shared-memory index is its only touch.
        let wal = with_suffix(&self.database, "-wal");
        let shm = with_suffix(&self.database, "-shm");
        let uri = match (wal.exists(), shm.exists()) {
            (false, _) => format!("{}?mode=ro&immutable=1", file_uri(&self.database)),
            (true, true) => format!("{}?mode=ro", file_uri(&self.database)),
            (true, false) => {
                return Err("OpenCode's database is mid-write; open OpenCode once, then try again".into());
            }
        };
        let db = Connection::open_with_flags(
            uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(fail)?;
        db.busy_timeout(Duration::from_secs(2)).map_err(fail)?;
        let has_table: bool = db
            .query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'credential'", [], |r| {
                r.get::<_, i64>(0)
            })
            .map(|n| n > 0)
            .map_err(fail)?;
        if !has_table {
            return Ok(HashMap::new());
        }
        // The active login first, then the newest, as OpenCode picks.
        let mut rows = db
            .prepare(
                "SELECT integration_id, value FROM credential WHERE integration_id IS NOT NULL \
                 ORDER BY coalesce(active, 0) DESC, time_created DESC, id DESC",
            )
            .map_err(fail)?;
        let mut creds = HashMap::new();
        let mut query = rows.query([]).map_err(fail)?;
        while let Some(row) = query.next().map_err(fail)? {
            let (Ok(id), Ok(value)) = (row.get::<_, String>(0), row.get::<_, String>(1)) else { continue };
            if creds.contains_key(&id) {
                continue;
            }
            if let Some(cred) = serde_json::from_str(&value).ok().as_ref().and_then(Cred::parse) {
                creds.insert(id, cred);
            }
        }
        Ok(creds)
    }

    /// The credential OpenCode holds for a Kintsugi provider, if any.
    fn find(&self, provider: &str) -> Result<Option<Cred>> {
        let mut creds = self.read()?;
        Ok(sources(provider).iter().find_map(|(id, want)| {
            let cred = creds.remove(*id)?;
            let wanted = match want {
                Want::Any => true,
                Want::ApiKey => cred.kind() == Kind::ApiKey,
                Want::Oauth => cred.kind() == Kind::Oauth,
            };
            wanted.then_some(cred)
        }))
    }

    /// What OpenCode holds for `provider`, without the secret.
    pub fn lookup(&self, provider: &Provider) -> Result<Lookup> {
        Ok(match self.find(provider.id)? {
            None => Lookup::Missing,
            Some(Cred::Key(_)) => Lookup::Usable(Kind::ApiKey),
            // A Claude subscription login: Kintsugi only uses Anthropic API keys.
            Some(Cred::Oauth { .. }) if provider.wire == Wire::Anthropic => Lookup::Unsupported,
            Some(Cred::Oauth { method, .. }) if provider.wire == Wire::Codex && method.as_deref() == Some(TOKEN_SHARING) => {
                Lookup::Unsupported
            }
            Some(Cred::Oauth { expires, .. }) if fresh(expires) => Lookup::Usable(Kind::Oauth),
            Some(Cred::Oauth { .. }) => Lookup::Expired,
        })
    }

    /// A usable credential for `provider`, or `None`. Never refreshes.
    pub fn auth(&self, provider: &Provider) -> Result<Option<Auth>> {
        if !matches!(self.lookup(provider)?, Lookup::Usable(_)) {
            return Ok(None);
        }
        Ok(self.find(provider.id)?.map(|cred| match cred {
            Cred::Key(key) => Auth::ApiKey(key),
            Cred::Oauth { access, account_id, .. } => {
                let account_id = match provider.wire {
                    Wire::Codex => account_id.or_else(|| codex_account_id(&access)),
                    _ => None,
                };
                Auth::Bearer { token: access, account_id }
            }
        }))
    }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// A `file:` URI for SQLite, with the characters URIs reserve escaped.
fn file_uri(path: &Path) -> String {
    let mut uri = String::from("file:");
    for b in path.to_string_lossy().bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => uri.push(b as char),
            _ => uri.push_str(&format!("%{b:02X}")),
        }
    }
    uri
}

fn fresh(expires: u64) -> bool {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    now + MINIMUM_VALIDITY_MS < expires
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::ai::wire::provider;
    use serde_json::json;

    pub(crate) fn later() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 60 * 60 * 1000
    }

    /// A fixture of OpenCode 2's database: the `credential` table as
    /// v2.0.32 creates it, in WAL mode like OpenCode's. Rows are
    /// `(integration, active, time_created, value)`.
    pub(crate) fn write_database(dir: &Path, rows: &[(&str, Option<bool>, i64, Value)]) {
        let db = rusqlite::Connection::open(dir.join(DATABASE)).unwrap();
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL,
               value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER,
               time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);",
        )
        .unwrap();
        for (i, (integration, active, created, value)) in rows.iter().enumerate() {
            db.execute(
                "INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated)
                 VALUES (?1, ?2, 'x', ?3, ?4, ?5, ?5)",
                rusqlite::params![format!("cred_{i}"), integration, value.to_string(), active, created],
            )
            .unwrap();
        }
    }

    fn legacy_store(contents: Value) -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(LEGACY_FILE), contents.to_string()).unwrap();
        let store = Store::new(dir.path());
        (dir, store)
    }

    fn p(id: &str) -> &'static Provider {
        provider(id).unwrap()
    }

    /// Every file in the folder, with a hash of its bytes.
    fn snapshot(dir: &Path) -> Vec<(String, u64)> {
        use std::hash::{Hash, Hasher};
        let hash = |bytes: Vec<u8>| {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            bytes.hash(&mut h);
            h.finish()
        };
        let mut files: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap())
            .map(|e| (e.file_name().to_string_lossy().into_owned(), hash(fs::read(e.path()).unwrap())))
            .collect();
        files.sort();
        files
    }

    #[test]
    fn reads_opencode_2s_database_read_only() {
        let dir = tempfile::tempdir().unwrap();
        write_database(dir.path(), &[
            ("openai", None, 1, json!({ "type": "oauth", "methodID": "chatgpt-browser", "refresh": "r", "access": "a",
                "expires": later(), "metadata": { "accountID": "acct" } })),
            ("opencode-go", None, 1, json!({ "type": "key", "key": "go" })),
            ("zai-coding-plan", None, 1, json!({ "type": "key", "key": "zk" })),
            ("anthropic", None, 1, json!({ "type": "oauth", "methodID": "oauth", "refresh": "r", "access": "a", "expires": later() })),
            ("azure", None, 1, json!({ "type": "external", "methodID": "cli" })),
            // A stale legacy file is ignored once there's a database.
        ]);
        fs::write(dir.path().join(LEGACY_FILE), json!({ "opencode": { "type": "api", "key": "stale" } }).to_string()).unwrap();
        let before = snapshot(dir.path());
        let store = Store::new(dir.path());

        assert_eq!(store.auth(p("openai-codex")).unwrap(), Some(Auth::Bearer { token: "a".into(), account_id: Some("acct".into()) }));
        assert_eq!(store.auth(p("opencode-go")).unwrap(), Some(Auth::ApiKey("go".into())));
        assert_eq!(store.auth(p("zai")).unwrap(), Some(Auth::ApiKey("zk".into())));
        assert_eq!(store.lookup(p("anthropic")).unwrap(), Lookup::Unsupported);
        assert_eq!(store.lookup(p("opencode")).unwrap(), Lookup::Missing);
        assert_eq!(store.lookup(p("openai")).unwrap(), Lookup::Missing);

        // No journal, lock or temp file created; every byte as it was.
        assert_eq!(snapshot(dir.path()), before);
    }

    #[test]
    fn reads_rows_still_in_opencodes_wal_while_it_runs() {
        let dir = tempfile::tempdir().unwrap();
        write_database(dir.path(), &[]);
        // OpenCode running: its connection holds the WAL open, with a row
        // not yet checkpointed into the main file.
        let opencode = rusqlite::Connection::open(dir.path().join(DATABASE)).unwrap();
        opencode.execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;").unwrap();
        opencode
            .execute(
                "INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES ('c', 'opencode-go', 'x', ?1, 1, 1)",
                [json!({ "type": "key", "key": "in-wal" }).to_string()],
            )
            .unwrap();
        assert!(dir.path().join("opencode.db-wal").exists());
        let names = |d: &Path| snapshot(d).into_iter().map(|(n, _)| n).collect::<Vec<_>>();
        let (main_before, names_before) = (fs::read(dir.path().join(DATABASE)).unwrap(), names(dir.path()));
        assert_eq!(Store::new(dir.path()).auth(p("opencode-go")).unwrap(), Some(Auth::ApiKey("in-wal".into())));
        assert_eq!(fs::read(dir.path().join(DATABASE)).unwrap(), main_before);
        assert_eq!(names(dir.path()), names_before);
    }

    #[test]
    fn database_paths_become_escaped_uris() {
        assert_eq!(file_uri(Path::new("/a b/c?d#e.db")), "file:/a%20b/c%3Fd%23e.db");
    }

    #[test]
    fn the_active_login_wins_else_the_newest() {
        let dir = tempfile::tempdir().unwrap();
        write_database(dir.path(), &[
            ("opencode", None, 1, json!({ "type": "key", "key": "old" })),
            ("opencode", None, 5, json!({ "type": "key", "key": "new" })),
            ("opencode-go", Some(true), 1, json!({ "type": "key", "key": "chosen" })),
            ("opencode-go", Some(false), 9, json!({ "type": "key", "key": "other" })),
        ]);
        let store = Store::new(dir.path());
        assert_eq!(store.auth(p("opencode")).unwrap(), Some(Auth::ApiKey("new".into())));
        assert_eq!(store.auth(p("opencode-go")).unwrap(), Some(Auth::ApiKey("chosen".into())));
    }

    #[test]
    fn chatgpt_token_sharing_is_not_a_codex_login() {
        let dir = tempfile::tempdir().unwrap();
        write_database(dir.path(), &[(
            "openai",
            None,
            1,
            json!({ "type": "oauth", "methodID": "chatgpt-token-sharing", "refresh": "r", "access": "a", "expires": later() }),
        )]);
        assert_eq!(Store::new(dir.path()).lookup(p("openai-codex")).unwrap(), Lookup::Unsupported);
    }

    #[test]
    fn a_database_without_the_table_holds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        rusqlite::Connection::open(dir.path().join(DATABASE)).unwrap().execute_batch("CREATE TABLE kv (key TEXT)").unwrap();
        assert_eq!(Store::new(dir.path()).lookup(p("opencode")).unwrap(), Lookup::Missing);
    }

    #[test]
    fn maps_legacy_ids_and_reads_keys_and_logins_without_touching_the_file() {
        let (dir, store) = legacy_store(json!({
            "anthropic": { "type": "api", "key": "ak" },
            "openai": { "type": "oauth", "access": "a", "refresh": "r", "expires": later(), "accountId": "acct" },
            "openrouter": { "type": "api", "key": "ork" },
            "zai-coding-plan": { "type": "api", "key": "zk" },
            "opencode": { "type": "api", "key": "zen", "metadata": { "note": "kept" } },
            "opencode-go/": { "type": "api", "key": "go" },
            "github-copilot": { "type": "oauth", "access": "x", "refresh": "y", "expires": 0 },
        }));
        let before = snapshot(dir.path());
        let key = |id| store.auth(p(id)).unwrap();

        assert_eq!(key("anthropic"), Some(Auth::ApiKey("ak".into())));
        assert_eq!(key("openai-codex"), Some(Auth::Bearer { token: "a".into(), account_id: Some("acct".into()) }));
        // A ChatGPT login is not an OpenAI API key.
        assert_eq!(key("openai"), None);
        assert_eq!(store.lookup(p("openai")).unwrap(), Lookup::Missing);
        assert_eq!(key("openrouter"), Some(Auth::ApiKey("ork".into())));
        assert_eq!(key("zai"), Some(Auth::ApiKey("zk".into())));
        assert_eq!(key("opencode"), Some(Auth::ApiKey("zen".into())));
        assert_eq!(key("opencode-go"), Some(Auth::ApiKey("go".into())));
        assert_eq!(key("ollama"), None);
        assert_eq!(store.lookup(p("opencode-go")).unwrap(), Lookup::Usable(Kind::ApiKey));
        assert_eq!(store.lookup(p("openai-codex")).unwrap(), Lookup::Usable(Kind::Oauth));
        assert_eq!(snapshot(dir.path()), before);
    }

    #[test]
    fn an_openai_api_key_is_openai_and_not_codex() {
        let (_dir, store) = legacy_store(json!({ "openai": { "type": "api", "key": "sk" } }));
        assert_eq!(store.auth(p("openai")).unwrap(), Some(Auth::ApiKey("sk".into())));
        assert_eq!(store.lookup(p("openai-codex")).unwrap(), Lookup::Missing);
    }

    #[test]
    fn a_plain_zai_key_is_used_when_there_is_no_coding_plan() {
        let (_dir, store) = legacy_store(json!({ "zai": { "type": "api", "key": "plain" } }));
        assert_eq!(store.auth(p("zai")).unwrap(), Some(Auth::ApiKey("plain".into())));
    }

    #[test]
    fn an_expired_login_is_reported_and_never_refreshed() {
        let dir = tempfile::tempdir().unwrap();
        write_database(dir.path(), &[(
            "openai",
            None,
            1,
            json!({ "type": "oauth", "methodID": "chatgpt-browser", "refresh": "unused", "access": "old", "expires": 1 }),
        )]);
        let before = snapshot(dir.path());
        let store = Store::new(dir.path());
        assert_eq!(store.lookup(p("openai-codex")).unwrap(), Lookup::Expired);
        assert_eq!(store.auth(p("openai-codex")).unwrap(), None);
        assert_eq!(snapshot(dir.path()), before);
    }

    #[test]
    fn the_codex_account_id_falls_back_to_the_token() {
        use base64::Engine;
        let claims = json!({ "https://api.openai.com/auth": { "chatgpt_account_id": "from-jwt" } });
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string());
        let (_dir, store) = legacy_store(json!({
            "openai": { "type": "oauth", "access": format!("h.{payload}.s"), "refresh": "r", "expires": later() }
        }));
        let Some(Auth::Bearer { account_id, .. }) = store.auth(p("openai-codex")).unwrap() else { panic!() };
        assert_eq!(account_id.as_deref(), Some("from-jwt"));
    }

    #[test]
    fn missing_stores_and_empty_keys_hold_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Store::new(dir.path()).lookup(p("opencode")).unwrap(), Lookup::Missing);
        let (_dir, store) = legacy_store(json!({ "opencode": { "type": "api", "key": "" } }));
        assert_eq!(store.lookup(p("opencode")).unwrap(), Lookup::Missing);
    }

    #[test]
    fn unreadable_stores_are_reported_by_path_only() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(LEGACY_FILE), "{\"opencode\": oc_sk_secret").unwrap();
        let err = Store::new(dir.path()).lookup(p("opencode")).unwrap_err();
        assert!(err.contains("auth.json") && !err.contains("oc_sk"), "{err}");

        fs::write(dir.path().join(DATABASE), "not a database oc_sk_secret").unwrap();
        let err = Store::new(dir.path()).lookup(p("opencode")).unwrap_err();
        assert!(err.contains("opencode.db") && !err.contains("oc_sk"), "{err}");
    }
}
