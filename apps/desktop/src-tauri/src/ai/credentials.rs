//! Where a provider's credential comes from, in order: the owner's OpenCode
//! login (`opencode_auth`), then Pi's (`pi_auth`), then Kintsugi's own
//! (keys and logins saved in Settings › Providers, in Pi's format, see
//! `pi_auth` and `sign_in`), then an environment variable, then nothing at
//! all for local servers. The first source with a usable credential wins. A
//! credential Kintsugi can't use (a Claude subscription login, an expired
//! OpenCode login) doesn't stop the search; it is only reported when no
//! later source has one either.
//!
//! Kintsugi's own store comes after OpenCode's and Pi's, so anyone who
//! already logs in with them sees no change.

use super::opencode_auth;
use super::pi_auth::{self, Auth};
use super::wire::Provider;
use serde::Serialize;
use std::sync::OnceLock;

type Result<T> = std::result::Result<T, String>;

/// Non-secret: which kind of credential a store holds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    ApiKey,
    Oauth,
}

/// What one store holds for a provider.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Lookup {
    Missing,
    Usable(Kind),
    /// A login Kintsugi can't use: a Claude subscription (Kintsugi only uses
    /// Anthropic API keys), or ChatGPT's newer token-sharing sign-in.
    Unsupported,
    /// A login whose token has run out and can't be refreshed here.
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Opencode,
    Pi,
    /// Saved in Kintsugi (Settings › Providers).
    Kintsugi,
    Env,
    Local,
}

/// A provider's status: where its credential comes from and whether it can
/// be used. `source` is `None` only when nothing was found.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Status {
    pub auth: &'static str,
    pub source: Option<Source>,
}

impl Status {
    pub const NONE: Status = Status {
        auth: "none",
        source: None,
    };

    /// What one store's `lookup` means on its own.
    #[cfg_attr(not(feature = "headless"), allow(dead_code))]
    pub fn of(source: Source, lookup: Lookup) -> Status {
        let auth = match lookup {
            Lookup::Missing => return Status::NONE,
            Lookup::Usable(Kind::ApiKey) => "api_key",
            Lookup::Usable(Kind::Oauth) => "login",
            Lookup::Unsupported => "unsupported_login",
            Lookup::Expired => "expired_login",
        };
        Status {
            auth,
            source: Some(source),
        }
    }
}

/// Kintsugi's own store, set once at startup (`init`).
static KINTSUGI: OnceLock<pi_auth::Store> = OnceLock::new();

/// Points Kintsugi's store at `auth.json` in its config folder; `None`
/// (headless, or an isolated dev run without a scratch config folder) keeps
/// it in memory, so nothing is ever written there.
pub fn init(config_dir: Option<&std::path::Path>) {
    let store = match config_dir {
        Some(dir) if !cfg!(feature = "headless") => pi_auth::Store::kintsugi(dir),
        _ => pi_auth::Store::memory(),
    };
    let fresh = KINTSUGI.set(store).is_ok();
    // Set once, at startup. Headless test runs build many apps in one
    // process; each keeps the first, in-memory store.
    debug_assert!(
        fresh || cfg!(any(test, feature = "headless")),
        "Kintsugi's credential store was used before startup set it"
    );
}

/// Kintsugi's own credentials (in memory until `init` runs).
pub fn kintsugi() -> &'static pi_auth::Store {
    KINTSUGI.get_or_init(pi_auth::Store::memory)
}

/// The credential sources, in the order they're consulted.
pub struct Chain {
    pub opencode: opencode_auth::Store,
    pub pi: pi_auth::Store,
    pub kintsugi: pi_auth::Store,
    pub env: Box<dyn Fn(&str) -> Option<String> + Send + Sync>,
}

impl Chain {
    /// The owner's own stores. Headless runs read both without writing.
    pub fn default_location() -> Result<Self> {
        Ok(Chain {
            opencode: opencode_auth::Store::default_location()?,
            pi: pi_auth::Store::default_location()?,
            kintsugi: kintsugi().clone(),
            env: Box::new(|key| std::env::var(key).ok().filter(|v| !v.is_empty())),
        })
    }

    /// The first of the provider's environment keys that is set.
    fn env_key(&self, provider: &Provider) -> Option<String> {
        provider.env_keys.iter().find_map(|k| (self.env)(k))
    }

    fn lookups(&self, provider: &Provider) -> Result<[(Source, Lookup); 3]> {
        Ok([
            (Source::Opencode, self.opencode.lookup(provider)?),
            (Source::Pi, self.pi.lookup(provider)?),
            // Kintsugi's own store comes after OpenCode's and Pi's: a file
            // it can't read must not hide theirs, so it counts as empty.
            (
                Source::Kintsugi,
                self.kintsugi.lookup(provider).unwrap_or(Lookup::Missing),
            ),
        ])
    }

    pub fn status(&self, provider: &Provider) -> Result<Status> {
        let lookups = self.lookups(provider)?;
        if let Some((source, kind)) = lookups.iter().find_map(|(s, l)| match l {
            Lookup::Usable(kind) => Some((*s, *kind)),
            _ => None,
        }) {
            let auth = match kind {
                Kind::ApiKey => "api_key",
                Kind::Oauth => "login",
            };
            return Ok(Status {
                auth,
                source: Some(source),
            });
        }
        if self.env_key(provider).is_some() {
            return Ok(Status {
                auth: "api_key",
                source: Some(Source::Env),
            });
        }
        if provider.keyless {
            return Ok(Status {
                auth: "local",
                source: Some(Source::Local),
            });
        }
        Ok(lookups
            .iter()
            .find_map(|(source, lookup)| match lookup {
                Lookup::Unsupported => Some(Status {
                    auth: "unsupported_login",
                    source: Some(*source),
                }),
                Lookup::Expired => Some(Status {
                    auth: "expired_login",
                    source: Some(*source),
                }),
                _ => None,
            })
            .unwrap_or(Status::NONE))
    }

    /// The credential a request to `provider` uses: `None` for a keyless
    /// local server. Errors say what to do, never what the secret is.
    pub async fn resolve(&self, provider: &Provider) -> Result<Option<Auth>> {
        let status = self.status(provider)?;
        match (status.auth, status.source) {
            (_, Some(Source::Opencode)) if matches!(status.auth, "api_key" | "login") => {
                self.opencode.auth(provider)?.map(Some).ok_or_else(|| "OpenCode login changed; try again".into())
            }
            (_, Some(Source::Pi)) if matches!(status.auth, "api_key" | "login") => {
                self.pi.auth(provider.id).await?.map(Some).ok_or_else(|| "Pi login changed; try again".into())
            }
            (_, Some(Source::Kintsugi)) if matches!(status.auth, "api_key" | "login") => self
                .kintsugi
                .auth(provider.id)
                .await?
                .map(Some)
                .ok_or_else(|| "The saved credential changed; try again".into()),
            (_, Some(Source::Env)) => Ok(self.env_key(provider).map(Auth::ApiKey)),
            (_, Some(Source::Local)) => Ok(None),
            ("unsupported_login", _) if provider.id == "openai-codex" => Err(
                "OpenCode's newer ChatGPT sign-in doesn't work with the Codex backend Kintsugi uses. \
                 Sign in to ChatGPT (Codex) in Settings › Providers, or use the ChatGPT browser login in OpenCode or Pi."
                    .into(),
            ),
            ("unsupported_login", _) => Err(format!(
                "{} holds a Claude subscription login, but Kintsugi uses only Anthropic API keys. \
                 Add an Anthropic API key in Settings › Providers.",
                source_name(status.source)
            )),
            ("expired_login", Some(Source::Opencode)) => Err(format!(
                "Your OpenCode login for {} has expired. Open OpenCode once to refresh it; \
                 Kintsugi never refreshes OpenCode's logins itself.",
                provider.name
            )),
            ("expired_login", Some(Source::Kintsugi)) => Err(format!(
                "Your {} sign-in has expired. Sign in again in Settings › Providers.",
                provider.name
            )),
            ("expired_login", _) => Err(format!(
                "Your Pi login for {} has expired; refresh it outside headless mode.",
                provider.name
            )),
            _ => Err(format!(
                "No credentials for {}. Add a key or sign in in Settings › Providers.",
                provider.name
            )),
        }
    }
}

fn source_name(source: Option<Source>) -> &'static str {
    match source {
        Some(Source::Opencode) => "OpenCode",
        Some(Source::Pi) => "Pi",
        Some(Source::Kintsugi) => "Kintsugi",
        _ => "Your login",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::wire::provider;
    use serde_json::{Value, json};
    use std::collections::HashMap;
    use std::path::Path;

    fn later() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 60 * 60 * 1000
    }

    /// Fixture stores only: never the owner's files or environment.
    struct Fixture {
        _dirs: (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir),
        chain: Chain,
    }

    fn fixture(opencode: Value, pi: Value, env: &[(&str, &str)]) -> Fixture {
        fixture_with(opencode, pi, json!({}), env)
    }

    fn fixture_with(opencode: Value, pi: Value, kintsugi: Value, env: &[(&str, &str)]) -> Fixture {
        let (oc, pi_dir, ki) = (
            tempfile::tempdir().unwrap(),
            tempfile::tempdir().unwrap(),
            tempfile::tempdir().unwrap(),
        );
        std::fs::write(oc.path().join("auth.json"), opencode.to_string()).unwrap();
        std::fs::write(pi_dir.path().join("auth.json"), pi.to_string()).unwrap();
        std::fs::write(ki.path().join("auth.json"), kintsugi.to_string()).unwrap();
        let env: HashMap<String, String> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let chain = Chain {
            opencode: opencode_auth::Store::new(oc.path()),
            pi: pi_auth::Store::new(pi_dir.path()),
            kintsugi: pi_auth::Store::kintsugi(ki.path()),
            env: Box::new(move |k| env.get(k).cloned()),
        };
        Fixture {
            _dirs: (oc, pi_dir, ki),
            chain,
        }
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    fn status(chain: &Chain, id: &str) -> (&'static str, Option<Source>) {
        let s = chain.status(provider(id).unwrap()).unwrap();
        (s.auth, s.source)
    }

    #[test]
    fn opencode_comes_before_pi_and_pi_before_the_environment() {
        let f = fixture(
            json!({ "zai-coding-plan": { "type": "api", "key": "from-opencode" } }),
            json!({ "zai": { "type": "api_key", "key": "from-pi" }, "openrouter": { "type": "api_key", "key": "pi-or" } }),
            &[
                ("ZAI_API_KEY", "from-env"),
                ("OPENROUTER_API_KEY", "env-or"),
                ("OPENAI_API_KEY", "env-oa"),
            ],
        );
        let c = &f.chain;
        assert_eq!(status(c, "zai"), ("api_key", Some(Source::Opencode)));
        assert_eq!(status(c, "openrouter"), ("api_key", Some(Source::Pi)));
        assert_eq!(status(c, "openai"), ("api_key", Some(Source::Env)));
        assert_eq!(status(c, "ollama"), ("local", Some(Source::Local)));
        assert_eq!(status(c, "opencode-go"), ("none", None));
        let resolve = |id| block_on(c.resolve(provider(id).unwrap()));
        assert_eq!(
            resolve("zai").unwrap(),
            Some(Auth::ApiKey("from-opencode".into()))
        );
        assert_eq!(
            resolve("openrouter").unwrap(),
            Some(Auth::ApiKey("pi-or".into()))
        );
        assert_eq!(
            resolve("openai").unwrap(),
            Some(Auth::ApiKey("env-oa".into()))
        );
        assert_eq!(resolve("ollama").unwrap(), None);
        assert!(resolve("opencode-go").unwrap_err().contains("OpenCode"));
    }

    #[test]
    fn every_provider_reads_pis_environment_keys() {
        let f = fixture(
            json!({}),
            json!({}),
            &[
                ("GROQ_API_KEY", "gsk"),
                ("MOONSHOT_API_KEY", "ms"),
                ("GEMINI_API_KEY", "AIza"),
                ("OPENCODE_API_KEY", "oc"),
                ("AI_GATEWAY_API_KEY", "vg"),
            ],
        );
        let c = &f.chain;
        for id in [
            "groq",
            "moonshotai",
            "moonshotai-cn",
            "google",
            "opencode",
            "opencode-go",
            "vercel-ai-gateway",
        ] {
            assert_eq!(status(c, id), ("api_key", Some(Source::Env)), "{id}");
        }
        assert_eq!(
            block_on(c.resolve(provider("moonshotai-cn").unwrap())).unwrap(),
            Some(Auth::ApiKey("ms".into()))
        );
        assert_eq!(status(c, "xai"), ("none", None));
        // Every provider but the local one names at least one key.
        for p in crate::ai::wire::PROVIDERS {
            assert!(
                p.keyless || !p.env_keys.is_empty() || p.id == "openai-codex",
                "{}",
                p.id
            );
        }
    }

    #[test]
    fn a_claude_login_is_refused_unless_a_key_exists_further_down() {
        let claude = json!({ "anthropic": { "type": "oauth", "access": "a", "refresh": "r", "expires": later() } });
        let f = fixture(claude.clone(), json!({}), &[]);
        assert_eq!(
            status(&f.chain, "anthropic"),
            ("unsupported_login", Some(Source::Opencode))
        );
        let err = block_on(f.chain.resolve(provider("anthropic").unwrap())).unwrap_err();
        assert!(err.contains("only Anthropic API keys"), "{err}");

        let f = fixture(claude, json!({}), &[("ANTHROPIC_API_KEY", "sk-ant")]);
        assert_eq!(
            status(&f.chain, "anthropic"),
            ("api_key", Some(Source::Env))
        );
        assert_eq!(
            block_on(f.chain.resolve(provider("anthropic").unwrap())).unwrap(),
            Some(Auth::ApiKey("sk-ant".into()))
        );
    }

    #[test]
    fn an_expired_opencode_login_falls_through_to_pi_or_says_to_open_opencode() {
        let expired =
            json!({ "openai": { "type": "oauth", "access": "old", "refresh": "r", "expires": 1 } });
        let f = fixture(expired.clone(), json!({}), &[]);
        assert_eq!(
            status(&f.chain, "openai-codex"),
            ("expired_login", Some(Source::Opencode))
        );
        let err = block_on(f.chain.resolve(provider("openai-codex").unwrap())).unwrap_err();
        assert!(err.contains("Open OpenCode once"), "{err}");

        let pi = json!({ "openai-codex": { "type": "oauth", "access": "pi", "refresh": "r", "expires": later(), "accountId": "acct" } });
        let f = fixture(expired, pi, &[]);
        assert_eq!(
            status(&f.chain, "openai-codex"),
            ("login", Some(Source::Pi))
        );
        assert_eq!(
            block_on(f.chain.resolve(provider("openai-codex").unwrap())).unwrap(),
            Some(Auth::Bearer {
                token: "pi".into(),
                account_id: Some("acct".into())
            })
        );
    }

    #[test]
    fn fixture_stores_are_left_byte_for_byte() {
        let f = fixture(
            json!({ "openai": { "type": "oauth", "access": "a", "refresh": "r", "expires": later(), "accountId": "x", "extra": 1 } }),
            json!({}),
            &[],
        );
        let path = |d: &Path| d.join("auth.json");
        let before = std::fs::read(path(f._dirs.0.path())).unwrap();
        block_on(f.chain.resolve(provider("openai-codex").unwrap())).unwrap();
        assert_eq!(std::fs::read(path(f._dirs.0.path())).unwrap(), before);
    }

    #[test]
    fn kintsugi_comes_after_opencode_and_pi_and_before_the_environment() {
        let f = fixture_with(
            json!({ "groq": { "type": "api", "key": "from-opencode" } }),
            json!({ "mistral": { "type": "api_key", "key": "from-pi" } }),
            json!({
                "groq": { "type": "api_key", "key": "ki-groq" },
                "mistral": { "type": "api_key", "key": "ki-mistral" },
                "deepseek": { "type": "api_key", "key": "ki-deepseek" },
                "xai": { "type": "oauth", "access": "ki-xai", "refresh": "r", "expires": later() },
                "anthropic": { "type": "oauth", "access": "a", "refresh": "r", "expires": later() },
            }),
            &[
                ("DEEPSEEK_API_KEY", "env-deepseek"),
                ("TOGETHER_API_KEY", "env-together"),
            ],
        );
        let c = &f.chain;
        // Existing OpenCode and Pi users see no change.
        assert_eq!(status(c, "groq"), ("api_key", Some(Source::Opencode)));
        assert_eq!(status(c, "mistral"), ("api_key", Some(Source::Pi)));
        // Saved in Kintsugi beats the environment.
        assert_eq!(status(c, "deepseek"), ("api_key", Some(Source::Kintsugi)));
        assert_eq!(status(c, "xai"), ("login", Some(Source::Kintsugi)));
        assert_eq!(status(c, "together"), ("api_key", Some(Source::Env)));
        // A Claude login saved by hand is still refused.
        assert_eq!(
            status(c, "anthropic"),
            ("unsupported_login", Some(Source::Kintsugi))
        );
        let resolve = |id| block_on(c.resolve(provider(id).unwrap()));
        assert_eq!(
            resolve("groq").unwrap(),
            Some(Auth::ApiKey("from-opencode".into()))
        );
        assert_eq!(
            resolve("deepseek").unwrap(),
            Some(Auth::ApiKey("ki-deepseek".into()))
        );
        assert_eq!(resolve("xai").unwrap(), Some(Auth::ApiKey("ki-xai".into())));
        assert!(
            resolve("anthropic")
                .unwrap_err()
                .contains("only Anthropic API keys")
        );
        assert_eq!(
            serde_json::to_value(Source::Kintsugi).unwrap(),
            json!("kintsugi")
        );
    }

    #[test]
    fn an_expired_kintsugi_login_says_to_sign_in_again() {
        let mut f = fixture_with(
            json!({}),
            json!({}),
            json!({ "xai": { "type": "oauth", "access": "old", "refresh": "r", "expires": 0 } }),
            &[],
        );
        f.chain.kintsugi = pi_auth::Store::memory();
        f.chain
            .kintsugi
            .save(
                "xai",
                json!({ "type": "oauth", "access": "old", "refresh": "r", "expires": 0 }),
            )
            .unwrap();
        assert_eq!(
            status(&f.chain, "xai"),
            ("expired_login", Some(Source::Kintsugi))
        );
        let err = block_on(f.chain.resolve(provider("xai").unwrap())).unwrap_err();
        assert!(err.contains("Settings › Providers"), "{err}");
    }

    #[test]
    fn an_unreadable_kintsugi_store_hides_no_other_source() {
        let mut f = fixture(
            json!({ "groq": { "type": "api", "key": "from-opencode" } }),
            json!({ "zai": { "type": "api_key", "key": "from-pi" } }),
            &[("DEEPSEEK_API_KEY", "from-env")],
        );
        // A folder where Kintsugi's file should be: it can't be read.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("auth.json")).unwrap();
        f.chain.kintsugi = pi_auth::Store::kintsugi(dir.path());
        assert!(f.chain.kintsugi.held("groq").is_err());
        let c = &f.chain;
        assert_eq!(status(c, "groq"), ("api_key", Some(Source::Opencode)));
        assert_eq!(status(c, "zai"), ("api_key", Some(Source::Pi)));
        assert_eq!(status(c, "deepseek"), ("api_key", Some(Source::Env)));
        assert_eq!(status(c, "mistral"), ("none", None));
        assert_eq!(
            block_on(c.resolve(provider("deepseek").unwrap())).unwrap(),
            Some(Auth::ApiKey("from-env".into()))
        );
    }
}
