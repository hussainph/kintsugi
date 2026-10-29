//! Just enough of the `tailscale` CLI to put the phone server on the tailnet:
//! `tailscale serve` terminates HTTPS with a real `*.ts.net` certificate and
//! forwards to the server on localhost, so nothing listens on a public port.

use serde_json::Value;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, String>;

/// Apps launched from Finder don't get the shell's PATH, so look in the usual places.
const CLI: [&str; 3] = [
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

pub enum Tailnet {
    Missing,
    /// Installed but not connected: stopped, logged out, or not answering.
    Down,
    Up {
        /// This Mac's MagicDNS name, e.g. `mac.tail1234.ts.net`.
        host: String,
        /// Whether the tailnet hands out HTTPS certificates, which serve needs.
        https: bool,
    },
}

fn cli() -> Option<&'static str> {
    CLI.into_iter().find(|p| Path::new(p).exists())
}

/// Runs the CLI, giving up after `timeout`: `serve` waits indefinitely when
/// HTTPS isn't enabled for the tailnet, after printing where to enable it.
fn run(args: &[&str], timeout: Duration) -> Result<String> {
    let cli = cli().ok_or("Tailscale isn't installed.")?;
    let mut child = Command::new(cli)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't run tailscale: {e}"))?;
    // Drain both pipes on threads so a chatty command can't block on a full pipe.
    let drain = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut out = String::new();
            let _ = pipe.read_to_string(&mut out);
            out
        })
    };
    let stdout = drain(Box::new(child.stdout.take().unwrap()));
    let stderr = drain(Box::new(child.stderr.take().unwrap()));
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break Some(status);
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let output = format!("{}{}", stdout.join().unwrap_or_default(), stderr.join().unwrap_or_default());
    match status {
        Some(status) if status.success() => Ok(output),
        _ => Err(output.trim().to_string()),
    }
}

pub fn status() -> Tailnet {
    if cli().is_none() {
        return Tailnet::Missing;
    }
    let Ok(out) = run(&["status", "--json", "--peers=false"], Duration::from_secs(5)) else {
        return Tailnet::Down;
    };
    let Ok(json) = serde_json::from_str::<Value>(&out) else {
        return Tailnet::Down;
    };
    let state = json["BackendState"].as_str().unwrap_or_default();
    let host = json["Self"]["DNSName"].as_str().unwrap_or_default().trim_end_matches('.');
    if state != "Running" || host.is_empty() {
        return Tailnet::Down;
    }
    let https = json["CertDomains"].as_array().is_some_and(|d| !d.is_empty());
    Tailnet::Up { host: host.into(), https }
}

fn target(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Whether `tailscale serve` already forwards `port` to the local server.
pub fn serving(port: u16) -> bool {
    run(&["serve", "status", "--json"], Duration::from_secs(5)).is_ok_and(|out| out.contains(&target(port)))
}

/// Forwards `https://<host>:<port>` on the tailnet to `127.0.0.1:<port>`.
/// The setting lives in Tailscale and survives restarts.
pub fn serve(port: u16) -> Result<()> {
    run(
        &["serve", "--bg", &format!("--https={port}"), &target(port)],
        Duration::from_secs(15),
    )
    .map(drop)
    .map_err(|out| match out.split_whitespace().find(|w| w.starts_with("https://login.tailscale.com")) {
        Some(link) => format!("Turn on HTTPS for your tailnet, then try again: {link}"),
        None if out.is_empty() => "tailscale serve didn't answer.".into(),
        None => out,
    })
}

pub fn unserve(port: u16) -> Result<()> {
    run(&["serve", &format!("--https={port}"), "off"], Duration::from_secs(5)).map(drop)
}
