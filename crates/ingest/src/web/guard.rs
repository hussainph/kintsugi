//! The public-web guard, for fetches an agent asks for (Kin's `web_fetch`).
//!
//! A clip is a page the owner chose; a page Kin chose could be any URL a
//! search result or a fetched page put in front of it. So a guarded
//! [`WebAdapter`](super::WebAdapter) only reaches the public internet:
//!
//! - HTTP(S) with a host and no credentials ([`allowed_url`](super::allowed_url)),
//! - no IP literal outside public unicast space, no `localhost` or `.local`
//!   name ([`public_url`]), checked on the first request and on every redirect,
//! - and every name resolved through [`PublicResolver`], which drops private,
//!   loopback, link-local and other special addresses, so a public name that
//!   resolves to `127.0.0.1` (DNS rebinding) is refused at connect time.
//!
//! The guarded client also ignores system proxies: a proxy would resolve
//! names itself, past the resolver.

use reqwest::Url;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

/// A URL a guarded fetch may request: [`super::allowed_url`], and no host
/// that names this machine or a private network.
pub fn public_url(url: &Url) -> bool {
    if !super::allowed_url(url) {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    match bare.parse::<IpAddr>() {
        Ok(ip) => public_ip(ip),
        Err(_) => {
            let name = host.trim_end_matches('.').to_ascii_lowercase();
            !(name.is_empty()
                || name == "localhost"
                || name.ends_with(".localhost")
                || name.ends_with(".local")
                || name.ends_with(".internal")
                || name.ends_with(".home.arpa")
                // A bare name ("router", "nas") only resolves on a local network.
                || !name.contains('.'))
        }
    }
}

/// Public unicast: not loopback, private, link-local, shared (CGNAT),
/// multicast, documentation, benchmarking or otherwise reserved space.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_v4(v4);
            }
            let s = ip.segments();
            !(ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_multicast()
                // Unique local fc00::/7, link-local fe80::/10, site-local fec0::/10.
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] & 0xffc0) == 0xfec0
                // IPv4-compatible ::/96, NAT64 64:ff9b::/96 and 64:ff9b:1::/48,
                // Teredo 2001::/32, documentation 2001:db8::/32, 6to4 2002::/16:
                // each can carry an IPv4 address past the IPv4 checks.
                || (s[0..6] == [0, 0, 0, 0, 0, 0])
                || (s[0] == 0x64 && s[1] == 0xff9b)
                || (s[0] == 0x2001 && s[1] == 0)
                || (s[0] == 0x2001 && s[1] == 0x0db8)
                || s[0] == 0x2002
                // Discard-only 100::/64.
                || (s[0] == 0x100 && s[1..4] == [0, 0, 0]))
        }
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        // Shared address space (CGNAT) 100.64.0.0/10.
        || (a == 100 && (b & 0xc0) == 64)
        // IETF protocol assignments 192.0.0.0/24, benchmarking 198.18.0.0/15.
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (b & 0xfe) == 18)
        // Reserved 240.0.0.0/4.
        || a >= 240)
}

/// Resolves names with the system resolver and keeps only public addresses.
/// A name with none left fails to resolve, so nothing connects.
#[derive(Debug, Default, Clone, Copy)]
pub struct PublicResolver;

impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let found: Vec<SocketAddr> =
                tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let public = public_addrs(found);
            if public.is_empty() {
                return Err("refused: the name resolves only to non-public addresses".into());
            }
            Ok(Box::new(public.into_iter()) as Addrs)
        })
    }
}

/// The public addresses among `addrs`, in order.
pub fn public_addrs(addrs: impl IntoIterator<Item = SocketAddr>) -> Vec<SocketAddr> {
    addrs.into_iter().filter(|a| public_ip(a.ip())).collect()
}
