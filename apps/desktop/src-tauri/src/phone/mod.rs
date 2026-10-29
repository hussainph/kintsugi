//! Phone access: the Kintsugi mobile app reads, edits and captures into this
//! Mac's vault over Tailscale while Kintsugi is running here.

mod server;
mod tailscale;

use crate::config;
use crate::vault;
use serde::Serialize;
use server::{Changed, Host};
use std::io::Read;
use std::sync::{Arc, Mutex};
use tailscale::Tailnet;
use tauri::{async_runtime, AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

/// The same on both sides of `tailscale serve`, so the URL is easy to read.
pub const PORT: u16 = 47474;

type Result<T> = std::result::Result<T, String>;

/// The running server, if phone access is on.
#[derive(Default)]
pub struct Phone(Mutex<Option<oneshot::Sender<()>>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneStatus {
    enabled: bool,
    listening: bool,
    /// `missing`, `down`, `no_https`, `not_serving` or `ready`.
    tailscale: &'static str,
    /// The address the phone uses, once Tailscale can serve it.
    url: Option<String>,
    /// A `kintsugi://pair` link carrying the address and token, for the QR code.
    pair: Option<String>,
    /// Pairs the iOS Simulator with this Mac directly; development builds only.
    dev_pair: Option<String>,
    problem: Option<String>,
}

fn pair_link(url: &str, token: &str) -> String {
    format!("kintsugi://pair?url={}&token={token}", url.replace(':', "%3A").replace('/', "%2F"))
}

/// 120 random bits as six groups of Crockford base32, readable aloud if need be.
fn new_token() -> Result<String> {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut bytes = [0u8; 15];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("couldn't make a pairing token: {e}"))?;
    let bits = bytes.iter().fold(0u128, |acc, &b| (acc << 8) | b as u128);
    let chars: Vec<char> = (0..24).rev().map(|i| ALPHABET[((bits >> (i * 5)) & 31) as usize] as char).collect();
    Ok(chars.chunks(4).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("-"))
}

fn host(app: &AppHandle) -> Host {
    Host {
        root: Arc::new({
            let app = app.clone();
            move || vault::current(&app)
        }),
        changed: Arc::new({
            let app = app.clone();
            move |change: Changed| {
                let _ = app.emit("vault:changed", change);
            }
        }),
    }
}

/// Starts the server, replacing one that is already running.
async fn listen(app: &AppHandle, token: &str) -> Result<()> {
    stop(app);
    let stop = server::start(host(app), token, PORT).await?;
    *app.state::<Phone>().0.lock().unwrap() = Some(stop);
    Ok(())
}

fn stop(app: &AppHandle) {
    if let Some(stop) = app.state::<Phone>().0.lock().unwrap().take() {
        let _ = stop.send(());
    }
}

/// Picks phone access back up when the app starts, if it was left on.
pub fn restore(app: &AppHandle) {
    let phone = config::load(app).phone;
    if let (true, Some(token)) = (phone.enabled, phone.token) {
        let app = app.clone();
        async_runtime::spawn(async move {
            if let Err(e) = listen(&app, &token).await {
                eprintln!("phone access: {e}");
            }
        });
    }
}

async fn status(app: &AppHandle, problem: Option<String>) -> PhoneStatus {
    let phone = config::load(app).phone;
    let listening = app.state::<Phone>().0.lock().unwrap().is_some();
    let (tailnet, serving) = async_runtime::spawn_blocking(|| (tailscale::status(), tailscale::serving(PORT)))
        .await
        .unwrap_or((Tailnet::Down, false));
    let (tailscale, url) = match tailnet {
        Tailnet::Missing => ("missing", None),
        Tailnet::Down => ("down", None),
        Tailnet::Up { https: false, .. } => ("no_https", None),
        Tailnet::Up { .. } if !serving => ("not_serving", None),
        Tailnet::Up { host, .. } => ("ready", Some(format!("https://{host}:{PORT}"))),
    };
    let token = phone.token.filter(|_| phone.enabled);
    PhoneStatus {
        enabled: phone.enabled,
        listening,
        tailscale,
        pair: url.as_deref().zip(token.as_deref()).map(|(u, t)| pair_link(u, t)),
        dev_pair: token
            .as_deref()
            .filter(|_| cfg!(debug_assertions))
            .map(|t| pair_link(&format!("http://127.0.0.1:{PORT}"), t)),
        url,
        problem,
    }
}

#[tauri::command]
pub async fn phone_status(app: AppHandle) -> PhoneStatus {
    status(&app, None).await
}

/// Turns phone access on or off: the local server and the `tailscale serve`
/// forward together. Problems with Tailscale come back in the status, so the
/// server can stay up while the writer fixes them.
#[tauri::command]
pub async fn phone_enable(app: AppHandle, enabled: bool) -> Result<PhoneStatus> {
    if !enabled {
        stop(&app);
        config::update(&app, |c| c.phone.enabled = false)?;
        let problem = async_runtime::spawn_blocking(|| match tailscale::status() {
            Tailnet::Up { .. } if tailscale::serving(PORT) => tailscale::unserve(PORT).err(),
            _ => None,
        })
        .await
        .map_err(|e| e.to_string())?;
        return Ok(status(&app, problem).await);
    }
    let token = match config::load(&app).phone.token {
        Some(token) => token,
        None => new_token()?,
    };
    listen(&app, &token).await?;
    config::update(&app, |c| {
        c.phone.enabled = true;
        c.phone.token = Some(token);
    })?;
    let problem = async_runtime::spawn_blocking(|| match tailscale::status() {
        Tailnet::Missing => Some("Install Tailscale on this Mac and your phone, then try again.".into()),
        Tailnet::Down => Some("Tailscale isn't connected on this Mac.".into()),
        Tailnet::Up { https: false, .. } => {
            Some("Turn on HTTPS certificates for your tailnet in the Tailscale admin console (DNS page).".into())
        }
        Tailnet::Up { .. } if tailscale::serving(PORT) => None,
        Tailnet::Up { .. } => tailscale::serve(PORT).err(),
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(status(&app, problem).await)
}

/// A new token: the paired phone is signed out and has to scan again.
#[tauri::command]
pub async fn phone_reset(app: AppHandle, phone: State<'_, Phone>) -> Result<PhoneStatus> {
    let token = new_token()?;
    let running = phone.0.lock().unwrap().is_some();
    config::update(&app, |c| c.phone.token = Some(token.clone()))?;
    if running {
        listen(&app, &token).await?;
    }
    Ok(status(&app, None).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_grouped_crockford() {
        let token = new_token().unwrap();
        assert_eq!(token.len(), 29);
        assert!(token.split('-').all(|g| g.len() == 4));
        assert!(token.chars().all(|c| c == '-' || "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(c)));
        assert_ne!(token, new_token().unwrap());
    }

    #[test]
    fn pair_links_encode_the_address() {
        assert_eq!(
            pair_link("https://mac.tail1.ts.net:47474", "AAAA-BBBB"),
            "kintsugi://pair?url=https%3A%2F%2Fmac.tail1.ts.net%3A47474&token=AAAA-BBBB"
        );
    }
}
