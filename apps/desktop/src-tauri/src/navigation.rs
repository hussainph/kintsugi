//! Keep file drops and external URLs from replacing the writing webview.
use tauri::Url;

pub fn allowed(url: &Url, dev_url: Option<&Url>) -> bool {
    if let Some(dev) = dev_url {
        return url.scheme() == dev.scheme() && url.origin() == dev.origin();
    }
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("tauri.localhost"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_app_origin_can_navigate_the_webview() {
        let dev = Url::parse("http://localhost:1427/.local/native.html").unwrap();
        for target in ["http://localhost:1427/", "http://localhost:1427/index.html"] {
            assert!(allowed(&Url::parse(target).unwrap(), Some(&dev)));
        }
        for target in [
            "file:///tmp/image.png",
            "https://example.com/",
            "http://localhost:1420/",
            "blob:http://localhost:1427/id",
            "javascript:alert(1)",
        ] {
            assert!(!allowed(&Url::parse(target).unwrap(), Some(&dev)));
            assert!(!allowed(&Url::parse(target).unwrap(), None));
        }
        assert!(allowed(&Url::parse("tauri://localhost/index.html").unwrap(), None));
        assert!(allowed(&Url::parse("http://tauri.localhost/").unwrap(), None));
        assert!(!allowed(&Url::parse("tauri://example.com/").unwrap(), None));
    }
}
