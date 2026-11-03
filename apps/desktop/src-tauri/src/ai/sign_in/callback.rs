//! The loopback server a browser login redirects to, after Pi's
//! `callback-server.ts`: bound to 127.0.0.1 only, for one sign-in, and
//! given up after a timeout. Each request is read on its own task, so a
//! browser's idle spare connection can't hold up the real callback.

use reqwest::Url;
use std::future::Future;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

type Result<T> = std::result::Result<T, String>;

const MAX_HEAD: usize = 16 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// What a login makes of one request to its callback path.
pub enum Verdict<A> {
    /// Not the callback (a stray or forged request): answer it and keep
    /// waiting.
    Ignore(u16, String),
    /// The provider said no: answer it and stop.
    Fail(String),
    /// The callback: finish the sign-in with this.
    Accept(A),
}

pub struct Callback {
    listener: TcpListener,
    path: String,
    provider: &'static str,
    timeout: Duration,
}

impl Callback {
    /// Listens on `127.0.0.1:<port>` (`0` picks a free port).
    pub async fn bind(
        port: u16,
        path: &str,
        provider: &'static str,
        timeout: Duration,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", port)).await?;
        Ok(Callback {
            listener,
            path: path.into(),
            provider,
            timeout,
        })
    }

    pub fn port(&self) -> u16 {
        self.listener.local_addr().map(|a| a.port()).unwrap_or(0)
    }

    /// `http://<host>:<port><path>`, the redirect URI the provider is given.
    pub fn redirect_uri(&self, host: &str) -> String {
        format!("http://{host}:{}{}", self.port(), self.path)
    }

    /// Serves until `check` accepts a request and `complete` has finished
    /// with it (the browser waits for the outcome), `check` fails it, or
    /// the timeout passes. The listener closes when this returns.
    pub async fn wait<A, T, F>(
        self,
        mut check: impl FnMut(&Url) -> Verdict<A>,
        complete: impl FnOnce(A) -> F,
    ) -> Result<T>
    where
        F: Future<Output = Result<T>>,
    {
        let (tx, mut rx) = mpsc::channel::<(String, String, TcpStream)>(8);
        let timeout = tokio::time::sleep(self.timeout);
        tokio::pin!(timeout);
        let mut complete = Some(complete);
        // Dropped on return: idle browser connections close with the listener.
        let mut readers = JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut timeout => return Err(format!("{} sign-in timed out", self.provider)),
                accepted = self.listener.accept() => {
                    match accepted {
                        Ok((mut stream, _)) => {
                            let tx = tx.clone();
                            readers.spawn(async move {
                                if let Some((method, target)) = read_head(&mut stream).await {
                                    let _ = tx.send((method, target, stream)).await;
                                }
                            });
                        }
                        // Out of file descriptors, say: don't spin.
                        Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
                    }
                }
                Some((method, target, stream)) = rx.recv() => {
                    let url = Url::parse(&format!("http://127.0.0.1{target}"));
                    let Ok(url) = url.map_err(drop).and_then(|u| {
                        (method == "GET" && u.path() == self.path).then_some(u).ok_or(())
                    }) else {
                        respond(stream, 404, &page("Callback route not found.")).await;
                        continue;
                    };
                    match check(&url) {
                        Verdict::Ignore(status, message) => respond(stream, status, &page(&message)).await,
                        Verdict::Fail(message) => {
                            respond(stream, 400, &page(&message)).await;
                            return Err(message);
                        }
                        Verdict::Accept(value) => {
                            let complete = complete.take().expect("one callback is accepted");
                            return match complete(value).await {
                                Ok(done) => {
                                    let text = format!("Signed in to {}. You can close this page.", self.provider);
                                    respond(stream, 200, &page(&text)).await;
                                    Ok(done)
                                }
                                Err(e) => {
                                    respond(stream, 502, &page(&format!("{} sign-in failed.", self.provider))).await;
                                    Err(e)
                                }
                            };
                        }
                    }
                }
            }
        }
    }
}

/// Pi's shared callback checks (Codex, OpenRouter): the state when there
/// is one, then the provider's error, then the code.
pub fn standard(
    state: Option<String>,
    provider: &'static str,
) -> impl FnMut(&Url) -> Verdict<String> {
    move |url| {
        let param = |name: &str| {
            url.query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.into_owned())
        };
        if let Some(state) = &state
            && param("state").as_deref() != Some(state.as_str())
        {
            return Verdict::Ignore(400, "State mismatch.".into());
        }
        if let Some(error) = param("error") {
            let description = param("error_description").unwrap_or(error);
            return Verdict::Fail(format!("{provider} authorization failed: {description}"));
        }
        match param("code").filter(|c| !c.is_empty()) {
            Some(code) => Verdict::Accept(code),
            None => Verdict::Ignore(400, "Missing authorization code.".into()),
        }
    }
}

/// The request line's method and target, once the head has arrived.
async fn read_head(stream: &mut TcpStream) -> Option<(String, String)> {
    let mut head = Vec::new();
    let mut buf = [0u8; 2048];
    let read = async {
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut buf).await.ok()?;
            if n == 0 || head.len() + n > MAX_HEAD {
                return None;
            }
            head.extend_from_slice(&buf[..n]);
        }
        Some(())
    };
    tokio::time::timeout(READ_TIMEOUT, read).await.ok()??;
    let text = String::from_utf8_lossy(&head);
    let mut line = text.lines().next()?.split_whitespace();
    let (method, target) = (line.next()?, line.next()?);
    target
        .starts_with('/')
        .then(|| (method.to_string(), target.to_string()))
}

async fn respond(mut stream: TcpStream, status: u16, html: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: text/html; charset=utf-8\r\ncache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn page(message: &str) -> String {
    let escaped = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Kintsugi</title>\
         <body style=\"font:16px system-ui;margin:4rem auto;max-width:32rem\"><p>{escaped}</p></body>"
    )
}
