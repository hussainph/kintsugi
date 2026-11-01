//! Where a provider's credential comes from, in order: the owner's OpenCode
//! login (`opencode_auth`), then Pi's (`pi_auth`), then an environment
//! variable, then nothing at all for local servers. The first source with a
//! usable credential wins. A credential Kintsugi can't use (a Claude
//! subscription login, an expired OpenCode login) doesn't stop the search;
//! it is only reported when no later source has one either.
//!
//! Kintsugi stores no credentials of its own and never signs in itself.

use super::opencode_auth;
use super::pi_auth::{self, Auth};
use super::wire::Provider;
use serde::Serialize;

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
    const NONE: Status = Status { auth: "none", source: None };
}

/// The credential sources, in the order they're consulted.
pub struct Chain {
    pub opencode: opencode_auth::Store,
    pub pi: pi_auth::Store,
    pub env: Box<dyn Fn(&str) -> Option<String> + Send + Sync>,
}

impl Chain {
    /// The owner's own stores. Headless runs read both without writing.
    pub fn default_location() -> Result<Self> {
        Ok(Chain {
            opencode: opencode_auth::Store::default_location()?,
            pi: pi_auth::Store::default_location()?,
            env: Box::new(|key| std::env::var(key).ok().filter(|v| !v.is_empty())),
        })
    }

    fn env_key(&self, provider: &Provider) -> Option<String> {
        provider.env_key.and_then(|k| (self.env)(k))
    }

    fn lookups(&self, provider: &Provider) -> Result<[(Source, Lookup); 2]> {
        Ok([(Source::Opencode, self.opencode.lookup(provider)?), (Source::Pi, self.pi.lookup(provider)?)])
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
            return Ok(Status { auth, source: Some(source) });
        }
        if self.env_key(provider).is_some() {
            return Ok(Status { auth: "api_key", source: Some(Source::Env) });
        }
        if provider.keyless {
            return Ok(Status { auth: "local", source: Some(Source::Local) });
        }
        Ok(lookups
            .iter()
            .find_map(|(source, lookup)| match lookup {
                Lookup::Unsupported => Some(Status { auth: "unsupported_login", source: Some(*source) }),
                Lookup::Expired => Some(Status { auth: "expired_login", source: Some(*source) }),
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
            (_, Some(Source::Env)) => Ok(self.env_key(provider).map(Auth::ApiKey)),
            (_, Some(Source::Local)) => Ok(None),
            ("unsupported_login", _) if provider.id == "openai-codex" => Err(
                "OpenCode's newer ChatGPT sign-in doesn't work with the Codex backend Kintsugi uses. \
                 Log in to OpenAI with the ChatGPT browser login in OpenCode or Pi, or add an OpenAI API key."
                    .into(),
            ),
            ("unsupported_login", _) => Err(format!(
                "{} holds a Claude subscription login, but Kintsugi uses only Anthropic API keys. \
                 Add an Anthropic API key in OpenCode or Pi, or set ANTHROPIC_API_KEY.",
                source_name(status.source)
            )),
            ("expired_login", Some(Source::Opencode)) => Err(format!(
                "Your OpenCode login for {} has expired. Open OpenCode once to refresh it; \
                 Kintsugi never refreshes OpenCode's logins itself.",
                provider.name
            )),
            ("expired_login", _) => Err(format!(
                "Your Pi login for {} has expired; refresh it outside headless mode.",
                provider.name
            )),
            _ => Err(format!(
                "No credentials for {}. Log in with OpenCode (or Pi), or add an API key.",
                provider.name
            )),
        }
    }
}

fn source_name(source: Option<Source>) -> &'static str {
    match source {
        Some(Source::Opencode) => "OpenCode",
        Some(Source::Pi) => "Pi",
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
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 60 * 60 * 1000
    }

    /// Fixture stores only: never the owner's files or environment.
    struct Fixture {
        _dirs: (tempfile::TempDir, tempfile::TempDir),
        chain: Chain,
    }

    fn fixture(opencode: Value, pi: Value, env: &[(&str, &str)]) -> Fixture {
        let (oc, pi_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        std::fs::write(oc.path().join("auth.json"), opencode.to_string()).unwrap();
        std::fs::write(pi_dir.path().join("auth.json"), pi.to_string()).unwrap();
        let env: HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let chain = Chain {
            opencode: opencode_auth::Store::new(oc.path()),
            pi: pi_auth::Store::new(pi_dir.path()),
            env: Box::new(move |k| env.get(k).cloned()),
        };
        Fixture { _dirs: (oc, pi_dir), chain }
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
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
            &[("ZAI_API_KEY", "from-env"), ("OPENROUTER_API_KEY", "env-or"), ("OPENAI_API_KEY", "env-oa")],
        );
        let c = &f.chain;
        assert_eq!(status(c, "zai"), ("api_key", Some(Source::Opencode)));
        assert_eq!(status(c, "openrouter"), ("api_key", Some(Source::Pi)));
        assert_eq!(status(c, "openai"), ("api_key", Some(Source::Env)));
        assert_eq!(status(c, "ollama"), ("local", Some(Source::Local)));
        assert_eq!(status(c, "opencode-go"), ("none", None));
        let resolve = |id| block_on(c.resolve(provider(id).unwrap()));
        assert_eq!(resolve("zai").unwrap(), Some(Auth::ApiKey("from-opencode".into())));
        assert_eq!(resolve("openrouter").unwrap(), Some(Auth::ApiKey("pi-or".into())));
        assert_eq!(resolve("openai").unwrap(), Some(Auth::ApiKey("env-oa".into())));
        assert_eq!(resolve("ollama").unwrap(), None);
        assert!(resolve("opencode-go").unwrap_err().contains("OpenCode"));
    }

    #[test]
    fn a_claude_login_is_refused_unless_a_key_exists_further_down() {
        let claude = json!({ "anthropic": { "type": "oauth", "access": "a", "refresh": "r", "expires": later() } });
        let f = fixture(claude.clone(), json!({}), &[]);
        assert_eq!(status(&f.chain, "anthropic"), ("unsupported_login", Some(Source::Opencode)));
        let err = block_on(f.chain.resolve(provider("anthropic").unwrap())).unwrap_err();
        assert!(err.contains("only Anthropic API keys"), "{err}");

        let f = fixture(claude, json!({}), &[("ANTHROPIC_API_KEY", "sk-ant")]);
        assert_eq!(status(&f.chain, "anthropic"), ("api_key", Some(Source::Env)));
        assert_eq!(
            block_on(f.chain.resolve(provider("anthropic").unwrap())).unwrap(),
            Some(Auth::ApiKey("sk-ant".into()))
        );
    }

    #[test]
    fn an_expired_opencode_login_falls_through_to_pi_or_says_to_open_opencode() {
        let expired = json!({ "openai": { "type": "oauth", "access": "old", "refresh": "r", "expires": 1 } });
        let f = fixture(expired.clone(), json!({}), &[]);
        assert_eq!(status(&f.chain, "openai-codex"), ("expired_login", Some(Source::Opencode)));
        let err = block_on(f.chain.resolve(provider("openai-codex").unwrap())).unwrap_err();
        assert!(err.contains("Open OpenCode once"), "{err}");

        let pi = json!({ "openai-codex": { "type": "oauth", "access": "pi", "refresh": "r", "expires": later(), "accountId": "acct" } });
        let f = fixture(expired, pi, &[]);
        assert_eq!(status(&f.chain, "openai-codex"), ("login", Some(Source::Pi)));
        assert_eq!(
            block_on(f.chain.resolve(provider("openai-codex").unwrap())).unwrap(),
            Some(Auth::Bearer { token: "pi".into(), account_id: Some("acct".into()) })
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
}
