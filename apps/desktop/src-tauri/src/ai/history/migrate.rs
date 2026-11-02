//! Moving the old global conversation log into a vault, once (KI-59).
//!
//! Until KI-59 there was one log for every vault, in
//! `<config>/kin/conversation/`. Now each vault keeps its own in
//! `.kintsugi/kin/`. On the first launch after the update, the old log moves
//! into the vault that's open (the last one used); other vaults start empty.
//!
//! Each step can be cut short by a crash and picked up again on the next
//! launch, and nothing is deleted until the vault's copy has been read back
//! and checked:
//!
//! 1. **Claim.** `conversation/` is renamed to `conversation.moving/` in one
//!    step. From then on it's a backup that no other vault picks up.
//! 2. **Copy.** `threads.json`, then `log.jsonl`, are written into the
//!    vault's folder atomically (a temp file, fsync, rename). `log.jsonl`
//!    appearing is what marks the copy done.
//! 3. **Confirm.** The vault's `log.jsonl` is read back: it must start with
//!    every byte of the old log (entries added since are fine). Only then is
//!    the backup deleted.
//!
//! A vault that already has a log of its own is never overwritten: the old
//! log is set aside as `conversation.unmoved-<time>/` and left for the owner.

use kintsugi_vault::write_bytes_atomic;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, String>;

/// Copied in this order: the log last, since it marks the copy done.
const FILES: [&str; 2] = ["threads.json", "log.jsonl"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Migrated {
    /// There was no old log (a fresh install, or moved already).
    Nothing,
    /// The old log is now the vault's, with this many bytes of log.
    Moved { bytes: usize },
    /// The vault already had its own log; the old one was kept here.
    Kept(PathBuf),
}

/// The backup the old log becomes while it's being moved.
fn backup_of(old: &Path) -> PathBuf {
    old.with_file_name(format!(
        "{}.moving",
        old.file_name().unwrap_or_default().to_string_lossy()
    ))
}

/// Moves the old global log folder `old` into a vault's log folder `to`.
/// Safe to call on every launch: it does nothing once the move is done.
pub fn migrate(old: &Path, to: &Path) -> Result<Migrated> {
    migrate_until(old, to, usize::MAX)
}

/// [`migrate`], stopping after `steps` steps: what a crash at that point
/// leaves on disk (tests).
pub(super) fn migrate_until(old: &Path, to: &Path, steps: usize) -> Result<Migrated> {
    let fail =
        |what: &str, e: std::io::Error| format!("could not move Kin's conversation ({what}): {e}");
    let backup = backup_of(old);
    let mut step = 0;
    let mut stop = || {
        step += 1;
        step > steps
    };

    // 1. Claim. A backup left by an interrupted move is finished first.
    if !backup.exists() {
        match fs::rename(old, &backup) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Migrated::Nothing),
            Err(e) => return Err(fail("claim", e)),
        }
    }
    if stop() {
        return Err("stopped after claiming".into());
    }

    let old_log = match fs::read(backup.join("log.jsonl")) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(fail("read", e)),
    };

    // 2. Copy, unless the vault has the log already (a crash after copying).
    let target = to.join("log.jsonl");
    match fs::read(&target) {
        Ok(current) if current.starts_with(&old_log) => {}
        Ok(current) if current.is_empty() => copy(&backup, to, &mut stop)?,
        Ok(_) => {
            let kept = old.with_file_name(format!(
                "{}.unmoved-{}",
                old.file_name().unwrap_or_default().to_string_lossy(),
                chrono::Local::now().format("%Y%m%d-%H%M%S")
            ));
            fs::rename(&backup, &kept).map_err(|e| fail("set aside", e))?;
            return Ok(Migrated::Kept(kept));
        }
        Err(e) if e.kind() == ErrorKind::NotFound => copy(&backup, to, &mut stop)?,
        Err(e) => return Err(fail("read the vault's log", e)),
    }

    // 3. Confirm, then let the backup go.
    let moved = fs::read(&target).map_err(|e| fail("check", e))?;
    if !moved.starts_with(&old_log) {
        return Err("could not move Kin's conversation: the copy doesn't match".into());
    }
    if stop() {
        return Err("stopped before removing the backup".into());
    }
    fs::remove_dir_all(&backup).map_err(|e| fail("remove the backup", e))?;
    Ok(Migrated::Moved {
        bytes: old_log.len(),
    })
}

fn copy(from: &Path, to: &Path, stop: &mut impl FnMut() -> bool) -> Result<()> {
    fs::create_dir_all(to).map_err(|e| format!("could not create {}: {e}", to.display()))?;
    for name in FILES {
        let bytes = match fs::read(from.join(name)) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("could not read the old {name}: {e}")),
        };
        write_bytes_atomic(&to.join(name), &bytes)?;
        if stop() {
            return Err(format!("stopped after copying {name}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{Draft, Log, Role};
    use super::*;

    struct Dirs {
        _tmp: tempfile::TempDir,
        old: PathBuf,
        a: PathBuf,
        b: PathBuf,
    }

    fn dirs() -> Dirs {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("config/kin/conversation");
        let a = tmp.path().join("vault-a/.kintsugi/kin");
        let b = tmp.path().join("vault-b/.kintsugi/kin");
        Dirs {
            old,
            a,
            b,
            _tmp: tmp,
        }
    }

    /// An old global log with a thread, a reply and a summary.
    fn old_log(dir: &Path) -> Vec<u8> {
        let mut log = Log::open(Some(dir.into()));
        let q = log.say("What did I say about kilns?", vec![]).unwrap();
        log.reply(
            Role::Kin,
            Draft {
                text: "That they fire for days.".into(),
                answers: vec![q.seq],
                ..Draft::default()
            },
        )
        .unwrap();
        log.mark_answered(q.seq);
        log.set_summary("", "Kilns.", 2).unwrap();
        fs::read(dir.join("log.jsonl")).unwrap()
    }

    fn moved_intact(to: &Path, bytes: &[u8]) {
        assert_eq!(fs::read(to.join("log.jsonl")).unwrap(), bytes);
        let log = Log::open(Some(to.into()));
        assert_eq!(log.len(), 2);
        assert_eq!(log.thread("").unwrap().summary, "Kilns.");
        assert!(log.pending().is_empty());
    }

    #[test]
    fn a_fresh_install_has_nothing_to_move() {
        let d = dirs();
        assert_eq!(migrate(&d.old, &d.a).unwrap(), Migrated::Nothing);
        assert!(!d.a.exists(), "nothing is created in the vault");
        assert!(!backup_of(&d.old).exists());
    }

    #[test]
    fn the_existing_log_moves_into_the_vault_and_the_backup_goes() {
        let d = dirs();
        let bytes = old_log(&d.old);
        assert_eq!(
            migrate(&d.old, &d.a).unwrap(),
            Migrated::Moved { bytes: bytes.len() }
        );
        moved_intact(&d.a, &bytes);
        assert!(!d.old.exists() && !backup_of(&d.old).exists());
        // Next launch: nothing more to do.
        assert_eq!(migrate(&d.old, &d.a).unwrap(), Migrated::Nothing);
    }

    #[test]
    fn with_two_vaults_only_the_open_one_gets_the_log() {
        let d = dirs();
        let bytes = old_log(&d.old);
        migrate(&d.old, &d.a).unwrap();
        // Later, the other vault is opened: it starts empty.
        assert_eq!(migrate(&d.old, &d.b).unwrap(), Migrated::Nothing);
        assert!(!d.b.join("log.jsonl").exists());
        assert_eq!(Log::open(Some(d.b.clone())).len(), 0);
        moved_intact(&d.a, &bytes);
    }

    #[test]
    fn a_crash_at_any_step_loses_nothing_and_the_next_launch_finishes() {
        // Steps: claim, threads.json, log.jsonl, confirm.
        for steps in 0..4 {
            let d = dirs();
            let bytes = old_log(&d.old);
            assert!(
                migrate_until(&d.old, &d.a, steps).is_err(),
                "step {steps} should stop"
            );
            // Whatever the crash left, the old log is still whole somewhere.
            let backup = if d.old.exists() {
                d.old.clone()
            } else {
                backup_of(&d.old)
            };
            assert_eq!(fs::read(backup.join("log.jsonl")).unwrap(), bytes);
            assert_eq!(
                migrate(&d.old, &d.a).unwrap(),
                Migrated::Moved { bytes: bytes.len() },
                "after a crash at step {steps}"
            );
            moved_intact(&d.a, &bytes);
            assert!(!backup_of(&d.old).exists());
        }
    }

    #[test]
    fn a_crash_after_copying_keeps_what_was_added_since() {
        let d = dirs();
        let bytes = old_log(&d.old);
        let _ = migrate_until(&d.old, &d.a, 3);
        let mut log = Log::open(Some(d.a.clone()));
        log.say("And glazes?", vec![]).unwrap();
        drop(log);
        migrate(&d.old, &d.a).unwrap();
        let log = Log::open(Some(d.a.clone()));
        assert_eq!(log.len(), 3);
        assert!(fs::read(d.a.join("log.jsonl")).unwrap().starts_with(&bytes));
    }

    #[test]
    fn a_vault_with_its_own_log_is_never_overwritten() {
        let d = dirs();
        let bytes = old_log(&d.old);
        let mut own = Log::open(Some(d.a.clone()));
        own.say("This vault's own question.", vec![]).unwrap();
        let before = fs::read(d.a.join("log.jsonl")).unwrap();
        let Migrated::Kept(kept) = migrate(&d.old, &d.a).unwrap() else {
            panic!("expected the old log to be kept");
        };
        assert_eq!(fs::read(d.a.join("log.jsonl")).unwrap(), before);
        assert_eq!(fs::read(kept.join("log.jsonl")).unwrap(), bytes);
        // Set aside, it isn't moved into the next vault either.
        assert_eq!(migrate(&d.old, &d.b).unwrap(), Migrated::Nothing);
    }
}
