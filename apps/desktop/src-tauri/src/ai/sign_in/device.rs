//! Polling a device-code login (RFC 8628), after Pi's `device-code.ts`:
//! the server's interval (5s if it gives none, never under 1s), `slow_down`
//! taking the server's new interval or adding 5s, and giving up at the
//! code's expiry. `second` is how long one second lasts, so tests run fast.

use std::future::Future;
use std::time::Duration;
use tokio::time::Instant;

type Result<T> = std::result::Result<T, String>;

pub const DEFAULT_INTERVAL_S: f64 = 5.0;
pub const SLOW_DOWN_INCREMENT_S: u32 = 5;
pub const TIMED_OUT: &str = "Device flow timed out";
pub const SLOW_DOWN_TIMED_OUT: &str = "Device flow timed out after one or more slow_down responses. \
     This is often caused by clock drift in a VM. Sync the clock and try again.";

/// One poll's answer.
pub enum Poll<T> {
    Complete(T),
    Pending,
    /// `slow_down`, with the interval the server now wants, if it said.
    SlowDown(Option<f64>),
    Failed(String),
}

pub struct Options {
    pub interval: Option<f64>,
    pub expires_in: Option<f64>,
    /// Wait one interval before the first poll (every flow but Codex's).
    pub wait_first: bool,
    pub second: Duration,
}

pub async fn poll<T, F, Fut>(options: Options, mut poll: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Poll<T>>>,
{
    let second = options.second;
    let deadline = options.expires_in.map(|s| Instant::now() + second.mul_f64(s.max(0.0)));
    let remaining = || deadline.map(|d| d.saturating_duration_since(Instant::now()));
    let mut interval = second
        .mul_f64(options.interval.unwrap_or(DEFAULT_INTERVAL_S).max(0.0))
        .max(second);
    let mut slowed = 0;
    if options.wait_first {
        match remaining() {
            Some(left) if left.is_zero() => {}
            Some(left) => tokio::time::sleep(interval.min(left)).await,
            None => tokio::time::sleep(interval).await,
        }
    }
    while remaining().is_none_or(|left| !left.is_zero()) {
        match poll().await? {
            Poll::Complete(value) => return Ok(value),
            Poll::Failed(message) => return Err(message),
            Poll::Pending => {}
            Poll::SlowDown(asked) => {
                slowed += 1;
                interval = match asked {
                    Some(s) if s.is_finite() && s > 0.0 => second.mul_f64(s).max(second),
                    _ => (interval + second * SLOW_DOWN_INCREMENT_S).max(second),
                };
            }
        }
        let wait = match remaining() {
            Some(left) if left.is_zero() => break,
            Some(left) => interval.min(left),
            None => interval,
        };
        tokio::time::sleep(wait).await;
    }
    Err(if slowed > 0 { SLOW_DOWN_TIMED_OUT } else { TIMED_OUT }.into())
}
