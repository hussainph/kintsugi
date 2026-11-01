//! A loopback HTTP server for adapter tests: one canned response per route,
//! in order, so nothing touches the internet.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

pub(crate) struct Route {
    /// The request target must start with this (path and query).
    pub target: String,
    pub head: String,
    pub body: Vec<u8>,
}

pub(crate) fn route(target: &str, status: u16, body: impl Into<Vec<u8>>) -> Route {
    let reason = match status {
        200 => "OK",
        301 => "Moved Permanently",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        _ => "Status",
    };
    Route { target: target.into(), head: format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n"), body: body.into() }
}

impl Route {
    pub fn header(mut self, line: &str) -> Self {
        self.head.push_str(line);
        self.head.push_str("\r\n");
        self
    }
}

pub(crate) struct Server {
    pub base: String,
    /// Each request's first line and user agent, in order.
    pub seen: Arc<Mutex<Vec<(String, String)>>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    /// Waits until every route was requested.
    pub fn finish(mut self) -> Vec<(String, String)> {
        self.thread.take().unwrap().join().unwrap();
        self.seen.lock().unwrap().clone()
    }
}

pub(crate) fn serve(routes: Vec<Route>) -> Server {
    serve_with(|_| routes)
}

/// Like [`serve`], for responses that mention the server's own address.
pub(crate) fn serve_with(routes: impl FnOnce(&str) -> Vec<Route>) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/", listener.local_addr().unwrap());
    let routes = routes(&base);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let thread = std::thread::spawn(move || {
        for route in routes {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 8192];
            let n = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..n]).to_string();
            let line = request.lines().next().unwrap_or_default().to_string();
            let agent = request
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("user-agent: ").map(str::to_string))
                .unwrap_or_default();
            log.lock().unwrap().push((line.clone(), agent));
            assert!(line.starts_with(&format!("GET {}", route.target)), "expected {} got {line}", route.target);
            let _ = write!(stream, "{}Content-Length: {}\r\nConnection: close\r\n\r\n", route.head, route.body.len());
            let _ = stream.write_all(&route.body);
        }
    });
    Server { base, seen, thread: Some(thread) }
}

pub(crate) fn run<T>(f: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}
