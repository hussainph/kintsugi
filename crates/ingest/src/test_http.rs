//! A loopback HTTP server for tests: fixed routes, any order, any number of
//! requests, counted. Nothing in the tests touches the internet.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

pub struct Server {
    pub base: String,
    hits: Arc<Mutex<HashMap<String, usize>>>,
}

impl Server {
    /// Routes map a path (with query) to `(status, content type, body)`.
    /// Unknown paths answer 404. `{base}` in a body becomes the server's URL.
    pub fn start(routes: Vec<(&str, u16, &str, Vec<u8>)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let routes: HashMap<String, (u16, String, Vec<u8>)> =
            routes
            .into_iter()
            .map(|(p, s, t, b)| {
                let b = match String::from_utf8(b) {
                    Ok(text) => text.replace("{base}", &base).into_bytes(),
                    Err(e) => e.into_bytes(),
                };
                (p.to_string(), (s, t.to_string(), b))
            })
            .collect();
        let hits = Arc::new(Mutex::new(HashMap::new()));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut request = Vec::new();
                let mut buf = [0; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let text = String::from_utf8_lossy(&request);
                let path = text.split_whitespace().nth(1).unwrap_or("").to_string();
                *counter.lock().unwrap().entry(path.clone()).or_insert(0) += 1;
                let (status, mime, body) =
                    routes.get(&path).cloned().unwrap_or((404, "text/plain".into(), b"not found".to_vec()));
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(&body);
            }
        });
        Self { base, hits }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    pub fn hits(&self, path: &str) -> usize {
        self.hits.lock().unwrap().get(path).copied().unwrap_or(0)
    }
}

pub fn run<T>(f: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}
