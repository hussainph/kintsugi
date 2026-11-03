//! Small robots exclusion parser: product-specific groups, longest match,
//! Allow ties, wildcards/end anchors, crawl delay and Sitemap declarations.
use crate::{Url, web::allowed_url};
use regex::Regex;
use std::time::Duration;

#[derive(Default)]
pub(super) struct Robots {
    rules: Vec<(Regex, usize, bool)>,
    pub delay: Duration,
    pub sitemaps: Vec<Url>,
    deny_all: bool,
}

#[derive(Default)]
struct Group {
    agents: Vec<String>,
    rules: Vec<(String, bool)>,
    delay: Duration,
    started: bool,
}

impl Robots {
    pub fn deny() -> Self {
        Self {
            deny_all: true,
            ..Self::default()
        }
    }

    pub fn parse(text: &str, base: &Url) -> Self {
        let mut policy = Self::default();
        let mut groups = vec![Group::default()];
        for line in text.lines() {
            let line = line.split('#').next().unwrap_or("").trim();
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim();
            if key.trim().eq_ignore_ascii_case("sitemap") {
                if let Ok(url) = base.join(value)
                    && allowed_url(&url)
                    && policy.sitemaps.len() < 100
                {
                    policy.sitemaps.push(url);
                }
                continue;
            }
            if key.trim().eq_ignore_ascii_case("user-agent") {
                if groups.last().unwrap().started {
                    groups.push(Group::default());
                }
                groups
                    .last_mut()
                    .unwrap()
                    .agents
                    .push(value.to_ascii_lowercase());
                continue;
            }
            let group = groups.last_mut().unwrap();
            if group.agents.is_empty() {
                continue;
            }
            group.started = true;
            match key.trim().to_ascii_lowercase().as_str() {
                "allow" | "disallow" if !value.is_empty() && value.len() <= 2048 => {
                    group
                        .rules
                        .push((normalized(value), key.trim().eq_ignore_ascii_case("allow")));
                }
                "crawl-delay" => {
                    if let Ok(seconds) = value.parse::<f64>()
                        && seconds.is_finite()
                        && seconds >= 0.0
                    {
                        group.delay = Duration::from_secs_f64(seconds.min(86_400.0));
                    }
                }
                _ => {}
            }
        }
        let specificity = |g: &Group| {
            g.agents
                .iter()
                .filter_map(|a| {
                    if a == "*" {
                        Some(0)
                    } else if !a.is_empty() && "kintsugi".contains(a.as_str()) {
                        Some(a.len())
                    } else {
                        None
                    }
                })
                .max()
        };
        let best = groups.iter().filter_map(specificity).max();
        for group in groups
            .iter()
            .filter(|g| best.is_some() && specificity(g) == best)
        {
            policy.delay = policy.delay.max(group.delay);
            for (pattern, allow) in &group.rules {
                let (pattern, end) = pattern
                    .strip_suffix('$')
                    .map_or((pattern.as_str(), ""), |p| (p, "$"));
                let regex = format!(
                    "^{}{}",
                    pattern
                        .split('*')
                        .map(regex::escape)
                        .collect::<Vec<_>>()
                        .join(".*"),
                    end
                );
                if let Ok(regex) = Regex::new(&regex) {
                    policy.rules.push((
                        regex,
                        pattern.bytes().filter(|c| *c != b'*').count(),
                        *allow,
                    ));
                }
            }
        }
        policy
    }

    pub fn allows(&self, url: &Url) -> bool {
        if self.deny_all {
            return false;
        }
        let mut target = url.path().to_string();
        if let Some(query) = url.query() {
            target.push('?');
            target.push_str(query);
        }
        let target = normalized(&target);
        self.rules
            .iter()
            .filter(|(r, _, _)| r.is_match(&target))
            .max_by_key(|(_, len, allow)| (*len, *allow))
            .is_none_or(|(_, _, allow)| *allow)
    }
}

// RFC 9309: decode unreserved octets, leave reserved octets percent encoded.
fn normalized(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let a = chars.next();
            let b = chars.next();
            if let (Some(a), Some(b)) = (a, b) {
                if let (Some(a), Some(b)) = (a.to_digit(16), b.to_digit(16)) {
                    let byte = (a * 16 + b) as u8;
                    if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                        out.push(byte as char);
                    } else {
                        out.push_str(&format!("%{byte:02X}"));
                    }
                } else {
                    out.push('%');
                    out.push(a);
                    out.push(b);
                }
            } else {
                out.push('%');
                if let Some(a) = a {
                    out.push(a);
                }
            }
        } else if !c.is_ascii() {
            for byte in c.to_string().as_bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        } else {
            out.push(c);
        }
    }
    out
}
