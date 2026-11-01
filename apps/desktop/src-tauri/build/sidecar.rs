//! Whether a Swift sidecar needs building. Shared by `build.rs` and the
//! crate's tests (a build script's own tests never run).

use std::path::Path;

/// The first bytes of the stand-in `build.rs` writes when Swift can't build
/// a helper. A real helper is a Mach-O binary and never starts like this.
pub const STUB_HEADER: &[u8] = b"#!/bin/sh\n";

/// A built helper newer than its source. A stub is never fresh, so the next
/// build tries Swift again instead of keeping the stand-in.
pub fn fresh(out: &Path, source: &Path) -> bool {
    let built = std::fs::metadata(out).and_then(|m| m.modified());
    let changed = std::fs::metadata(source).and_then(|m| m.modified());
    match (built, changed) {
        (Ok(built), Ok(changed)) => built >= changed && !is_stub(out),
        _ => false,
    }
}

pub fn is_stub(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; STUB_HEADER.len()];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok_and(|()| head == STUB_HEADER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stub_is_never_fresh_but_a_built_helper_is() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("pdf.swift");
        let out = dir.path().join("kintsugi-pdf");
        std::fs::write(&source, "print(1)").unwrap();
        assert!(!fresh(&out, &source), "missing");
        // Written after the source, as after a failed build.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&out, [STUB_HEADER, b"exit 3\n"].concat()).unwrap();
        assert!(is_stub(&out));
        assert!(!fresh(&out, &source), "a stub must not stick");
        std::fs::write(&out, b"\xcf\xfa\xed\xfe binary").unwrap();
        assert!(!is_stub(&out));
        assert!(fresh(&out, &source));
        // An edited source is newer than the helper.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&source, "print(2)").unwrap();
        assert!(!fresh(&out, &source));
    }
}
