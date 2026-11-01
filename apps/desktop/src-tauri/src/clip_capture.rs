//! Delivery receipts belong to the app, not the vault's plain clip files.
//! Both desktop and phone captures use this one lock and persisted journal.

use kintsugi_vault as vault;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use crate::AppHandle;
#[cfg(not(feature = "headless"))]
use tauri::Manager;

const MAX_RECEIPTS: usize = 1024;
const MAX_STORE_BYTES: u64 = 8 * 1024 * 1024;
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Deserialize)]
#[serde(try_from = "WireCapture")]
pub struct Capture {
    pub id: Option<String>,
    pub clip: vault::ClipCapture,
}

// Avoid serde(flatten)'s intermediate value buffer for large desktop images.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCapture {
    id: Option<String>,
    url: Option<String>,
    text: Option<String>,
    note: Option<String>,
    title: Option<String>,
    image: Option<Vec<u8>>,
    image_type: Option<String>,
    /// Base64, like the phone API: a number array would be several times
    /// the size of a 50 MiB PDF.
    file: Option<String>,
    file_type: Option<String>,
    file_name: Option<String>,
    captured_at: String,
    via: vault::ClipVia,
}

/// Base64 adds a third; a little slack for padding and line breaks.
pub const MAX_ENCODED_FILE_BYTES: usize = vault::MAX_CLIP_FILE_BYTES.div_ceil(3) * 4 + 16;

/// Why a capture's file field was refused, before it reaches the vault.
#[derive(Debug, PartialEq)]
pub enum FileError {
    TooLarge,
    Invalid(&'static str),
}

impl std::fmt::Display for FileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge => f.write_str("PDFs and EPUBs must be 50 MiB or smaller."),
            Self::Invalid(message) => f.write_str(message),
        }
    }
}

/// Decodes a capture's base64 file. The type and bytes are checked by the
/// vault; this checks only the encoding, the size and that a type came along.
pub fn decode_file(
    file: Option<String>,
    file_type: Option<String>,
    file_name: Option<String>,
) -> Result<Option<vault::ClipFile>, FileError> {
    use base64::Engine;
    let Some(encoded) = file else {
        return match file_type {
            Some(_) => Err(FileError::Invalid("A clip file type needs a file.")),
            None => Ok(None),
        };
    };
    if encoded.len() > MAX_ENCODED_FILE_BYTES {
        return Err(FileError::TooLarge);
    }
    let mime = file_type.ok_or(FileError::Invalid("A clip file needs its type."))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .map_err(|_| FileError::Invalid("The clip file must be valid base64."))?;
    if bytes.len() > vault::MAX_CLIP_FILE_BYTES {
        return Err(FileError::TooLarge);
    }
    // Only a bare name is kept; it names the clip and never becomes a path.
    let name = file_name
        .map(|n| n.rsplit(['/', '\\']).next().unwrap_or_default().chars().take(255).collect::<String>())
        .filter(|n| !n.trim().is_empty());
    Ok(Some(vault::ClipFile { bytes, mime, name }))
}

impl TryFrom<WireCapture> for Capture {
    type Error = FileError;

    fn try_from(wire: WireCapture) -> Result<Self, FileError> {
        let file = decode_file(wire.file, wire.file_type, wire.file_name)?;
        Ok(Self {
            id: wire.id,
            clip: vault::ClipCapture {
                url: wire.url,
                text: wire.text,
                note: wire.note,
                title: wire.title,
                image: wire.image,
                image_type: wire.image_type,
                file,
                captured_at: wire.captured_at,
                via: wire.via,
            },
        })
    }
}

pub struct Created {
    pub path: String,
    pub created: bool,
}

#[derive(Debug)]
pub enum Error {
    Invalid(String),
    Storage,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => f.write_str(message),
            Self::Storage => f.write_str("Could not save the clip capture. Please retry."),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Receipt {
    root: PathBuf,
    id: String,
    path: String,
    // A reservation is durable before the clip is written. After a crash,
    // a pending receipt with a file can be completed without another write.
    complete: bool,
}

pub fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "headless")]
    { Ok(crate::config::directory(app)?.join("clip-capture-ids.json")) }
    #[cfg(not(feature = "headless"))]
    {
        if crate::config::isolated_dev() {
            return Ok(app.state::<crate::vault::Vault>().root()?.join(".kintsugi/clip-capture-ids.json"));
        }
        Ok(crate::config::directory(app)?.join("clip-capture-ids.json"))
    }
}

fn capture_id(value: &str) -> Result<String, Error> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(i, byte)| {
            if [8, 13, 18, 23].contains(&i) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err(Error::Invalid("Clip capture id must be a UUID.".into()));
    }
    Ok(value.to_ascii_lowercase())
}

fn load(index: &Path) -> Result<Vec<Receipt>, Error> {
    match fs::metadata(index) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Ok(meta) if meta.is_file() && meta.len() <= MAX_STORE_BYTES => {}
        _ => return Err(Error::Storage),
    }
    let text = fs::read_to_string(index).map_err(|_| Error::Storage)?;
    let receipts: Vec<Receipt> = serde_json::from_str(&text).map_err(|_| Error::Storage)?;
    if receipts.len() > MAX_RECEIPTS
        || receipts.iter().any(|r| {
            capture_id(&r.id).as_deref().ok() != Some(r.id.as_str())
                || !r.root.is_absolute()
                || !valid_path(&r.path)
        })
    {
        return Err(Error::Storage);
    }
    Ok(receipts)
}

fn valid_path(path: &str) -> bool {
    let Some(name) = path.strip_prefix("inspiration/") else {
        return false;
    };
    name.ends_with(".md") && !name.starts_with('.') && !name.contains(['/', '\\'])
}

fn save(index: &Path, receipts: &[Receipt]) -> Result<(), Error> {
    let json = serde_json::to_string(receipts).map_err(|_| Error::Storage)?;
    if json.len() as u64 > MAX_STORE_BYTES {
        return Err(Error::Storage);
    }
    fs::create_dir_all(index.parent().ok_or(Error::Storage)?).map_err(|_| Error::Storage)?;
    vault::write_atomic(index, &json).map_err(|_| Error::Storage)?;
    // Persist the rename before the clip can be written in the other directory.
    #[cfg(unix)]
    fs::File::open(index.parent().ok_or(Error::Storage)?)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| Error::Storage)?;
    Ok(())
}

/// A completed receipt is authoritative even if its clip was trashed. The
/// oldest receipt is evicted after 1024 distinct IDs, not on duplicate reads.
/// IDs are scoped to the canonical vault root, so switching vaults is safe.
pub fn create(root: &Path, index: &Path, capture: &Capture) -> Result<Created, Error> {
    let id = capture.id.as_deref().map(capture_id).transpose()?;
    // Includes receipt lookup, path selection, clip creation and journal save.
    let _guard = LOCK.lock().map_err(|_| Error::Storage)?;
    let root = root.canonicalize().map_err(|_| Error::Storage)?;
    let mut receipts = load(index)?;
    if let Some(at) = receipts
        .iter()
        .position(|r| r.root == root && Some(&r.id) == id.as_ref())
    {
        if receipts[at].complete {
            return Ok(Created {
                path: receipts[at].path.clone(),
                created: false,
            });
        }
        let target = vault::clip_path(&root, &receipts[at].path).map_err(|_| Error::Storage)?;
        match fs::symlink_metadata(target) {
            Ok(meta) if meta.is_file() => {
                // All app captures skip other pending paths, so this is ours
                // even if enrichment or the writer has edited it since.
                receipts[at].complete = true;
                save(index, &receipts)?;
                return Ok(Created {
                    path: receipts[at].path.clone(),
                    created: true,
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(Error::Storage),
        }
    }
    vault::clip_validate_capture(&capture.clip).map_err(Error::Invalid)?;
    let reserved: Vec<_> = receipts
        .iter()
        .filter(|r| r.root == root && !r.complete && Some(&r.id) != id.as_ref())
        .map(|r| r.path.clone())
        .collect();
    let Some(id) = id else {
        let path = vault::clip_create_with_receipt(&root, &capture.clip, &reserved, |_| Ok(()))
            .map_err(|_| Error::Storage)?;
        return Ok(Created {
            path,
            created: true,
        });
    };
    let mut previous = receipts.clone();
    previous.retain(|r| r.root != root || r.id != id);
    let result = vault::clip_create_with_receipt(&root, &capture.clip, &reserved, |path| {
        receipts.retain(|r| r.root != root || r.id != id);
        if receipts.len() == MAX_RECEIPTS {
            receipts.remove(0);
        }
        receipts.push(Receipt {
            root: root.clone(),
            id: id.clone(),
            path: path.into(),
            complete: false,
        });
        save(index, &receipts).map_err(|e| e.to_string())
    });
    let path = match result {
        Ok(path) => path,
        Err(_) => {
            // A known failed create saved no Markdown. Release its reservation
            // when possible; a crash or failed cleanup is handled on recovery.
            let _ = save(index, &previous);
            return Err(Error::Storage);
        }
    };
    // The reservation also recovers a crash or disk error between these writes.
    receipts.last_mut().ok_or(Error::Storage)?.complete = true;
    save(index, &receipts)?;
    Ok(Created {
        path,
        created: true,
    })
}

/// Complete pending receipts before the app trashes their clip, so a retry
/// after an interrupted capture cannot resurrect a deliberate deletion.
pub fn trash(
    root: &Path,
    index: &Path,
    path: &str,
    remove: impl FnOnce(&[PathBuf]) -> Result<(), String>,
) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| Error::Storage.to_string())?;
    let root = root
        .canonicalize()
        .map_err(|_| Error::Storage.to_string())?;
    let mut receipts = load(index).map_err(|e| e.to_string())?;
    vault::clip_trash(&root, path, |targets| {
        let mut changed = false;
        for receipt in &mut receipts {
            if receipt.root == root && receipt.path == path && !receipt.complete {
                receipt.complete = true;
                changed = true;
            }
        }
        if changed {
            save(index, &receipts).map_err(|e| e.to_string())?;
        }
        remove(targets)
    })
}

#[cfg(test)]
mod tests;
