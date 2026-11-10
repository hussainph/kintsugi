//! Local files attached to Kin's messages. References are opaque, vault-local
//! `@attachment/<directory>/<filename>` names, never arbitrary filesystem paths.
//! Staging is retained after commit so sending a message can safely be retried.

use super::{prompt::Chip, threads, wire};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{ImageFormat, ImageReader};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read as _, Write as _};
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
pub const MAX_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_ATTACHMENTS: usize = 8;
const MAX_EDGE: u32 = 1568;
const MAX_PIXELS: u64 = 40_000_000;
const MAX_DECODE_EDGE: u32 = 32_768;
/// Text stays complete within the 20 MiB file cap; individual reads are paged.
pub const READ_TEXT_BYTES: usize = 32 * 1024;
const PDF_TEXT_CHARS: usize = kintsugi_ingest::FULL_CHARS;
const PREFIX: &str = "@attachment/";

/// Import bytes from a picker, drop or clipboard into this vault's staging area.
pub fn import(root: &Path, name: &str, bytes: &[u8]) -> Result<Chip> {
    check_size(bytes.len())?;
    let mut filename = safe_filename(name)?;
    // Clipboard files need not have an extension. Infer it from verified
    // image bytes so these still have stable image references and previews.
    if !is_image_name(&filename) {
        let extension = if is_heic(bytes) {
            Some("heic")
        } else {
            image::guess_format(bytes)
                .ok()
                .and_then(|format| match format {
                    ImageFormat::Png => Some("png"),
                    ImageFormat::Jpeg => Some("jpg"),
                    ImageFormat::Gif => Some("gif"),
                    ImageFormat::WebP => Some("webp"),
                    _ => None,
                })
        };
        if let Some(extension) = extension {
            filename = safe_filename(&format!("{filename}.{extension}"))?;
        }
    }
    let extracted = match file_kind(&filename, bytes)? {
        Kind::Image => {
            image_bytes(bytes)?;
            None
        }
        Kind::Pdf => Some(pdf_text(bytes)?),
        Kind::Text => {
            text(bytes)?;
            None
        }
    };
    stage(root, name, &filename, bytes, extracted.as_deref())
}

fn stage(
    root: &Path,
    name: &str,
    filename: &str,
    bytes: &[u8],
    extracted: Option<&str>,
) -> Result<Chip> {
    let kin = kin_dir(root)?;
    gc_staging(&kin);
    let id = Uuid::new_v4().to_string();
    let dir = kin.join("attachments").join(&id);
    ensure_dir(&dir)?;
    let file = dir.join(filename);
    write_new(&file, bytes)?;
    if let Some(extracted) = extracted {
        if let Err(error) = write_new(&text_cache(&file), extracted.as_bytes()) {
            let _ = fs::remove_file(&file);
            let _ = fs::remove_dir(&dir);
            return Err(error);
        }
    }
    Ok(Chip {
        kind: "attachment".into(),
        path: format!("{PREFIX}{id}/{filename}"),
        label: Some(name.into()),
        lines: None,
    })
}

/// Copy attachments into a thread before persisting its message. Existing
/// references remain usable, including references owned by a different thread.
/// On failure the caller's chips are unchanged; completed copies are harmless.
pub fn commit(kin_dir: &Path, thread: &str, chips: &mut [Chip]) -> Result<()> {
    valid_thread(thread)?;
    check_ancestors(kin_dir)?;
    if chips.iter().filter(|c| c.kind == "attachment").count() > MAX_ATTACHMENTS {
        return Err("Attach at most 8 files.".into());
    }
    let mut pending = Vec::new();
    for (i, chip) in chips.iter().enumerate() {
        if chip.kind != "attachment" {
            if chip.path.starts_with(PREFIX) {
                return Err("Invalid attachment chip.".into());
            }
            continue;
        }
        let reference = Reference::parse(&chip.path)?;
        let source = kin_dir
            .join("attachments")
            .join(&reference.directory)
            .join(&reference.filename);
        let bytes = read_file(&source)?;
        let cached = if matches!(file_kind(&reference.filename, &bytes)?, Kind::Pdf) {
            Some(read_file(&text_cache(&source))?)
        } else {
            None
        };
        let filename = if reference.staged {
            format!("{}-{}", reference.directory, reference.filename)
        } else {
            reference.filename
        };
        let target = kin_dir.join("attachments").join(thread).join(&filename);
        pending.push((
            i,
            target,
            bytes,
            cached,
            format!("{PREFIX}{thread}/{filename}"),
        ));
    }
    if pending.is_empty() {
        return Ok(());
    }
    ensure_dir(&kin_dir.join("attachments").join(thread))?;
    for (_, target, bytes, cached, _) in &pending {
        copy_identical(target, bytes)?;
        if let Some(cached) = cached {
            copy_identical(&text_cache(target), cached)?;
        }
    }
    for (i, _, _, _, path) in pending {
        chips[i].path = path;
    }
    Ok(())
}

/// A model-safe image data URL for a staged or persisted attachment.
pub fn preview(root: &Path, path: &str) -> Result<Option<String>> {
    let file = resolve(root, path)?;
    let bytes = read_file(&file)?;
    if !matches!(
        file_kind(file.to_str().unwrap_or_default(), &bytes)?,
        Kind::Image
    ) {
        return Ok(None);
    }
    let image = image_bytes(&bytes)?;
    Ok(Some(format!(
        "data:{};base64,{}",
        image.mime_type, image.data
    )))
}

/// Read one attachment for the model. PDF extraction is local, through the
/// ingest PDF adapter. Images carry a short note plus a wire image block.
pub fn read(root: &Path, path: &str) -> Result<(String, Vec<wire::Image>)> {
    let file = resolve(root, path)?;
    let bytes = read_file(&file)?;
    match file_kind(file.to_str().unwrap_or_default(), &bytes)? {
        Kind::Image => Ok(("Attached image.".into(), vec![image_bytes(&bytes)?])),
        Kind::Text => Ok((text(&bytes)?, vec![])),
        Kind::Pdf => Ok((text(&read_file(&text_cache(&file))?)?, vec![])),
    }
}

/// Encode an explicitly authorized local image (e.g. a library image). This
/// function does not authorize arbitrary paths; its caller must resolve those.
/// Links, non-files, oversized files and decode bombs are refused here too.
pub fn image_file(path: &Path) -> Result<wire::Image> {
    image_bytes(&read_file(path)?)
}

/// Delete only this thread's attachment directory. No links are traversed,
/// including links placed inside the directory since the message was saved.
pub fn remove(kin_dir: &Path, thread: &str) -> Result<()> {
    remove_thread(kin_dir, thread, true)
}

/// A new thread failed to save. Remove its copies, retaining imports for retry.
pub fn rollback(kin_dir: &Path, thread: &str) -> Result<()> {
    remove_thread(kin_dir, thread, false)
}

fn remove_thread(kin_dir: &Path, thread: &str, staged_originals: bool) -> Result<()> {
    valid_thread(thread)?;
    let dir = kin_dir.join("attachments").join(thread);
    check_ancestors(&dir)?;
    match fs::symlink_metadata(&dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Couldn't inspect attachments.".into()),
        Ok(m) if !m.is_dir() => return Err("Invalid attachment folder.".into()),
        _ => {}
    }
    // Our thread directories contain files only, not subdirectories.
    let files = fs::read_dir(&dir)
        .map_err(|_| "Couldn't inspect attachments.")?
        .map(|entry| {
            let entry = entry.map_err(|_| "Couldn't inspect attachments.")?;
            let path = entry.path();
            check_ancestors(&path)?;
            if !entry
                .file_type()
                .map_err(|_| "Couldn't inspect attachment.")?
                .is_file()
            {
                return Err("Invalid attachment file.".into());
            }
            Ok(path)
        })
        .collect::<Result<Vec<_>>>()?;
    // Remove matching originals too. Copies owned by other threads remain
    // independent; deleting one thread must never delete another's copy.
    if staged_originals {
        for file in &files {
            remove_matching_staging(kin_dir, file);
        }
    }
    for file in files {
        fs::remove_file(file).map_err(|_| "Couldn't remove attachment.")?;
    }
    fs::remove_dir(dir).map_err(|_| "Couldn't remove attachments.".into())
}

/// Discard a staged reference, never a persisted thread copy. Removing an
/// already-discarded reference is harmless.
pub fn discard(root: &Path, path: &str) -> Result<()> {
    let reference = Reference::parse(path)?;
    if !reference.staged {
        return Err("Only unsent attachments can be discarded.".into());
    }
    let file = resolve(root, path)?;
    check_ancestors(&text_cache(&file))?;
    for path in [&file, &text_cache(&file)] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Couldn't discard attachment.".into()),
        }
    }
    if let Some(parent) = file.parent() {
        let _ = fs::remove_dir(parent);
    }
    Ok(())
}

fn text_cache(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".extracted.txt");
    PathBuf::from(name)
}
fn copy_identical(target: &Path, bytes: &[u8]) -> Result<()> {
    match write_new(target, bytes) {
        Ok(()) => Ok(()),
        Err(_) if read_file(target).as_deref() == Ok(bytes) => Ok(()),
        Err(error) => Err(error),
    }
}
fn remove_matching_staging(kin_dir: &Path, persisted: &Path) {
    let Some(name) = persisted.file_name().and_then(|s| s.to_str()) else {
        return;
    };
    let Some(id) = name.get(..36).filter(|s| uuid(s)) else {
        return;
    };
    let Some(filename) = name.get(37..).filter(|s| is_safe_filename(s)) else {
        return;
    };
    if name.as_bytes().get(36) != Some(&b'-') {
        return;
    }
    let staged = kin_dir.join("attachments").join(id).join(filename);
    let Ok(original) = read_file(&staged) else {
        return;
    };
    if read_file(persisted).as_deref() != Ok(original.as_slice()) {
        return;
    }
    if check_ancestors(&text_cache(&staged)).is_err() {
        return;
    }
    let _ = fs::remove_file(&staged);
    let _ = fs::remove_file(text_cache(&staged));
    if let Some(parent) = staged.parent() {
        let _ = fs::remove_dir(parent);
    }
}
/// Collect expired imports when a vault opens, as well as on later imports.
pub fn collect_staging(root: &Path) -> Result<()> {
    gc_staging(&kin_dir(root)?);
    Ok(())
}

fn gc_staging(kin_dir: &Path) {
    use std::time::{Duration, SystemTime};
    let base = kin_dir.join("attachments");
    if check_ancestors(&base).is_err() {
        return;
    }
    let Ok(entries) = fs::read_dir(&base) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry.file_name().to_str().is_some_and(uuid) || check_ancestors(&path).is_err() {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir()
            || !metadata
                .modified()
                .ok()
                .and_then(|at| SystemTime::now().duration_since(at).ok())
                .is_some_and(|age| age > Duration::from_secs(7 * 24 * 60 * 60))
        {
            continue;
        }
        let Ok(entries) = fs::read_dir(&path) else {
            continue;
        };
        let files: Vec<_> = entries.collect();
        if !files.iter().all(|entry| {
            entry.as_ref().is_ok_and(|entry| {
                entry.file_name().to_str().is_some_and(|s| {
                    is_safe_filename(s)
                        || s.strip_suffix(".extracted.txt")
                            .is_some_and(is_safe_filename)
                }) && check_ancestors(&entry.path()).is_ok()
                    && entry.file_type().is_ok_and(|m| m.is_file())
            })
        }) {
            continue;
        }
        for entry in files.into_iter().flatten() {
            let _ = fs::remove_file(entry.path());
        }
        let _ = fs::remove_dir(path);
    }
}

struct Reference {
    directory: String,
    filename: String,
    staged: bool,
}
impl Reference {
    fn parse(path: &str) -> Result<Self> {
        let invalid = || "Invalid attachment reference.".to_string();
        let tail = path.strip_prefix(PREFIX).ok_or_else(invalid)?;
        let (directory, filename) = tail.split_once('/').ok_or_else(invalid)?;
        if filename.contains('/') || !is_safe_filename(filename) {
            return Err(invalid());
        }
        // A persisted filename starts with the staging UUID. A staging
        // filename never needs such a prefix, even when its name resembles one.
        let staged = uuid(directory);
        if staged {
            if filename.len() > 120 {
                return Err(invalid());
            }
        } else {
            valid_thread(directory)?;
            if filename.len() < 38
                || !uuid(&filename[..36.min(filename.len())])
                || filename.as_bytes().get(36) != Some(&b'-')
                || !is_safe_filename(&filename[37..])
                || filename[37..].len() > 120
            {
                return Err(invalid());
            }
        }
        Ok(Self {
            directory: directory.into(),
            filename: filename.into(),
            staged,
        })
    }
}

fn uuid(s: &str) -> bool {
    Uuid::parse_str(s).is_ok_and(|u| u.hyphenated().to_string() == s)
}
fn valid_thread(thread: &str) -> Result<()> {
    // UUID directories belong to staging, not threads.
    if !threads::valid_id(thread) || uuid(thread) {
        return Err("Invalid attachment thread.".into());
    }
    Ok(())
}
/// A bounded ASCII filename, retaining its extension and refusing separators.
pub fn safe_filename(name: &str) -> Result<String> {
    if name.is_empty()
        || name.len() > 1024
        || name.contains(['/', '\\', '\0'])
        || name == "."
        || name == ".."
    {
        return Err("Invalid attachment filename.".into());
    }
    // Keep the extension while bounding a filename's length. ASCII names make
    // reference parsing independent of platform separators and Unicode forms.
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_start_matches('.');
    if cleaned.is_empty() {
        return Err("Invalid attachment filename.".into());
    }
    let result = if cleaned.len() > 120 {
        let (stem, extension) = cleaned.rsplit_once('.').ok_or("Filename is too long.")?;
        if extension.len() > 16 {
            return Err("Filename is too long.".into());
        }
        format!(
            "{}.{}",
            &stem[..(119 - extension.len()).min(stem.len())],
            extension
        )
    } else {
        cleaned.into()
    };
    if !is_safe_filename(&result) {
        return Err("Invalid attachment filename.".into());
    }
    Ok(result)
}
fn is_safe_filename(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name.len() <= 157
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
}
fn kin_dir(root: &Path) -> Result<PathBuf> {
    check_ancestors(root)?;
    let kin = threads::vault_dir(root)?;
    check_ancestors(&kin)?;
    Ok(kin)
}
fn resolve(root: &Path, path: &str) -> Result<PathBuf> {
    let reference = Reference::parse(path)?;
    let file = kin_dir(root)?
        .join("attachments")
        .join(reference.directory)
        .join(reference.filename);
    check_ancestors(&file)?;
    Ok(file)
}

/// Inspect every existing path component, not just the final directory. Do
/// not canonicalize an untrusted path first: that would erase link evidence.
fn check_ancestors(path: &Path) -> Result<()> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| "Couldn't locate attachments.")?
            .join(path)
    };
    let mut at = PathBuf::new();
    for component in absolute.components() {
        if !matches!(
            component,
            Component::RootDir | Component::Normal(_) | Component::Prefix(_)
        ) {
            return Err("Invalid attachment path.".into());
        }
        at.push(component.as_os_str());
        match fs::symlink_metadata(&at) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err("Attachment links aren't allowed.".into());
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Couldn't inspect attachment path.".into()),
        }
    }
    Ok(())
}
fn ensure_dir(path: &Path) -> Result<()> {
    check_ancestors(path)?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            ensure_dir(parent)?;
        }
    }
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("Couldn't create attachment folder.".into()),
    }
    check_ancestors(path)?;
    if !path.is_dir() {
        return Err("Invalid attachment folder.".into());
    }
    Ok(())
}
fn check_size(len: usize) -> Result<()> {
    if len == 0 {
        return Err("Attachment is empty.".into());
    }
    if len > MAX_BYTES {
        return Err("Each file must be 20 MiB or smaller.".into());
    }
    Ok(())
}
fn read_file(path: &Path) -> Result<Vec<u8>> {
    check_ancestors(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| "Couldn't read attachment.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Couldn't inspect attachment.")?;
    if !metadata.is_file() {
        return Err("Invalid attachment file.".into());
    }
    check_size(usize::try_from(metadata.len()).unwrap_or(usize::MAX))?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Couldn't read attachment.")?;
    check_size(bytes.len())?;
    Ok(bytes)
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    check_ancestors(path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Couldn't save attachment.")?;
    let result = file.write_all(bytes).and_then(|_| file.sync_all());
    if result.is_err() {
        let _ = fs::remove_file(path);
        return Err("Couldn't save attachment.".into());
    }
    Ok(())
}

/// Whether a local filename names a supported image. Content is still verified
/// by `image_file`; an extension alone never establishes an image's MIME type.
pub fn is_image_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|extension| {
            ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"]
                .iter()
                .any(|known| extension.eq_ignore_ascii_case(known))
        })
}

enum Kind {
    Image,
    Pdf,
    Text,
}
fn file_kind(name: &str, bytes: &[u8]) -> Result<Kind> {
    let extension = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "heif" => {
            if image::guess_format(bytes).is_ok_and(supported_image) || is_heic(bytes) {
                Ok(Kind::Image)
            } else {
                Err("Couldn't read image.".into())
            }
        }
        "pdf"
            if bytes
                .iter()
                .take(1024)
                .copied()
                .collect::<Vec<_>>()
                .windows(5)
                .any(|w| w == b"%PDF-") =>
        {
            Ok(Kind::Pdf)
        }
        "txt" | "md" | "markdown" => Ok(Kind::Text),
        _ => Err("Use an image, PDF, Markdown or text file.".into()),
    }
}
fn text(bytes: &[u8]) -> Result<String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Use a UTF-8 text file.")?;
    if text.contains('\0') {
        return Err("Use a UTF-8 text file.".into());
    }
    Ok(text.to_string())
}

/// A complete line window, with a byte budget and a cursor for the next read.
/// No line is silently clipped: a line that cannot fit is refused explicitly.
pub fn text_page(path: &str, text: &str, offset: usize, limit: usize) -> Result<String> {
    let line_count = text.lines().count();
    let offset = offset.max(1);
    if offset > line_count.max(1) {
        return Err(format!("{path} has {line_count} lines"));
    }
    let start = offset - 1;
    let through = start.saturating_add(limit.max(1)).min(line_count);
    let mut body = String::new();
    let mut end = start;
    for (index, line) in text.lines().enumerate().take(through).skip(start) {
        let numbered = format!("{}: {line}\n", index + 1);
        // Leave room for the path, line counts and continuation cursor.
        if numbered.len() > READ_TEXT_BYTES - 1024 {
            if end == start {
                return Err("Attachment line exceeds 32 KiB; split it into shorter lines.".into());
            }
            break;
        }
        if body.len() + numbered.len() > READ_TEXT_BYTES - 1024 {
            break;
        }
        body.push_str(&numbered);
        end = index + 1;
    }
    let mut out = format!("{path}, lines {offset}-{end} of {line_count}\n{body}");
    if end < line_count {
        out.push_str(&format!("(more: read with offset {})\n", end + 1));
    }
    Ok(out)
}
fn supported_image(format: ImageFormat) -> bool {
    matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP
    )
}
fn check_dimensions(width: u32, height: u32) -> Result<()> {
    if width == 0
        || height == 0
        || width > MAX_DECODE_EDGE
        || height > MAX_DECODE_EDGE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err("Image dimensions are too large.".into());
    }
    Ok(())
}
fn image_bytes(bytes: &[u8]) -> Result<wire::Image> {
    check_size(bytes.len())?;
    if is_heic(bytes) {
        return heic_image(bytes);
    }
    let format = image::guess_format(bytes).map_err(|_| "Couldn't read image.")?;
    if !supported_image(format) {
        return Err("Unsupported image format.".into());
    }
    let dimensions = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| "Couldn't read image dimensions.")?;
    check_dimensions(dimensions.0, dimensions.1)?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DECODE_EDGE);
    limits.max_image_height = Some(MAX_DECODE_EDGE);
    limits.max_alloc = Some(160 * 1024 * 1024);
    reader.limits(limits);
    use image::ImageDecoder as _;
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "Couldn't decode image.")?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut decoded =
        image::DynamicImage::from_decoder(decoder).map_err(|_| "Couldn't decode image.")?;
    decoded.apply_orientation(orientation);
    let decoded = if decoded.width() > MAX_EDGE || decoded.height() > MAX_EDGE {
        decoded.thumbnail(MAX_EDGE, MAX_EDGE)
    } else {
        decoded
    };
    // JPEG bounds the model payload, including noisy screenshots. Composite
    // alpha onto white rather than silently turning transparent pixels black.
    let mut rgb = image::RgbImage::new(decoded.width(), decoded.height());
    for (x, y, pixel) in decoded.to_rgba8().enumerate_pixels() {
        let a = u16::from(pixel[3]);
        rgb.put_pixel(
            x,
            y,
            image::Rgb(std::array::from_fn(|i| {
                ((u16::from(pixel[i]) * a + 255 * (255 - a) + 127) / 255) as u8
            })),
        );
    }
    let mut output = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 85)
        .encode_image(&image::DynamicImage::ImageRgb8(rgb))
        .map_err(|_| "Couldn't resize image.")?;
    Ok(wire::Image {
        mime_type: "image/jpeg".into(),
        data: STANDARD.encode(output),
    })
}
fn is_heic(bytes: &[u8]) -> bool {
    bytes.len() >= 16
        && &bytes[4..8] == b"ftyp"
        && matches!(
            &bytes[8..12],
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1"
        )
}

#[cfg(target_os = "macos")]
fn heic_image(bytes: &[u8]) -> Result<wire::Image> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    fn run(command: &mut Command) -> Result<()> {
        let mut child = command
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Couldn't convert HEIC image.")?;
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => return Ok(()),
                Ok(Some(_)) => return Err("Couldn't convert HEIC image.".into()),
                Ok(None) if start.elapsed() < Duration::from_secs(15) => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("HEIC conversion timed out.".into());
                }
            }
        }
    }
    let work = tempfile::tempdir().map_err(|_| "Couldn't convert HEIC image.")?;
    // Canonicalize only our newly created temporary directory, not user paths.
    let work_path = work
        .path()
        .canonicalize()
        .map_err(|_| "Couldn't convert HEIC image.")?;
    let input = work_path.join("input.heic");
    let output = work_path.join("output.jpg");
    let probe = work_path.join("dimensions.txt");
    write_new(&input, bytes)?;
    run(Command::new("/usr/bin/sips")
        .args(["-g", "pixelWidth", "-g", "pixelHeight"])
        .arg(&input)
        .stdout(File::create(&probe).map_err(|_| "Couldn't inspect HEIC image.")?))?;
    let info = String::from_utf8(read_file(&probe)?).map_err(|_| "Couldn't inspect HEIC image.")?;
    let dimension = |key: &str| {
        info.lines()
            .find_map(|line| line.trim().strip_prefix(key)?.trim().parse::<u32>().ok())
    };
    let width = dimension("pixelWidth:").ok_or("Couldn't read HEIC dimensions.")?;
    let height = dimension("pixelHeight:").ok_or("Couldn't read HEIC dimensions.")?;
    check_dimensions(width, height)?;
    let edge = MAX_EDGE.min(width.max(height)).to_string();
    run(Command::new("/usr/bin/sips")
        .args(["-Z", &edge, "-s", "format", "jpeg"])
        .arg(&input)
        .arg("--out")
        .arg(&output)
        .stdout(Stdio::null()))?;
    image_bytes(&read_file(&output)?)
}
#[cfg(not(target_os = "macos"))]
fn heic_image(_: &[u8]) -> Result<wire::Image> {
    Err("HEIC conversion requires macOS.".into())
}

fn pdf_text(bytes: &[u8]) -> Result<String> {
    let reader = crate::tools::pdf_helper().map(|helper| {
        std::sync::Arc::new(kintsugi_ingest::pdf::PdfKitReader::new(helper))
            as std::sync::Arc<dyn kintsugi_ingest::pdf::PdfReader>
    });
    pdf_with_reader(bytes, reader)
}
struct ExtractedPdf(kintsugi_ingest::pdf::PdfText);
impl kintsugi_ingest::pdf::PdfReader for ExtractedPdf {
    fn read<'a>(
        &'a self,
        _: &'a Path,
        _: Option<&'a Path>,
    ) -> kintsugi_ingest::BoxFuture<'a, kintsugi_ingest::Result<kintsugi_ingest::pdf::PdfText>>
    {
        Box::pin(async { Ok(self.0.clone()) })
    }
}

fn pdf_with_reader(
    bytes: &[u8],
    reader: Option<std::sync::Arc<dyn kintsugi_ingest::pdf::PdfReader>>,
) -> Result<String> {
    let bytes = bytes.to_vec();
    // A dedicated runtime works whether the caller is already inside Tokio
    // or is a synchronous command. Extraction never refreshes AI credentials.
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "Couldn't read PDF.")?;
        runtime.block_on(async move {
            let work = tempfile::tempdir().map_err(|_| "Couldn't read PDF.")?;
            let input = work.path().join("attachment.pdf");
            fs::write(&input, bytes).map_err(|_| "Couldn't read PDF.")?;
            // Inspect the complete helper result before the ingest adapter's
            // publication cap can shorten it. Never cache an unnoticed prefix.
            let reader = reader.ok_or("Couldn't extract PDF text.")?;
            let extracted = reader
                .read(&input, None)
                .await
                .map_err(|_| "Couldn't extract PDF text.")?;
            if extracted.locked {
                return Err("Remove the PDF password before attaching.".into());
            }
            if extracted.pages.len() != extracted.page_count {
                return Err("PDF text is incomplete; attach fewer pages.".into());
            }
            if kintsugi_ingest::pdf::layout::markdown(&extracted)
                .chars()
                .count()
                > PDF_TEXT_CHARS
            {
                return Err("PDF text exceeds 250,000 characters; attach fewer pages.".into());
            }
            let reader = std::sync::Arc::new(ExtractedPdf(extracted))
                as std::sync::Arc<dyn kintsugi_ingest::pdf::PdfReader>;
            let adapter = kintsugi_ingest::pdf::PdfAdapter::new(Some(reader))
                .map_err(|_| "Couldn't read PDF.")?;
            let item = adapter
                .capture_file(
                    &input,
                    None,
                    kintsugi_ingest::CaptureOptions { want_media: false },
                )
                .await
                .map_err(|_| "Couldn't extract PDF text.")?;
            if item.body.trim().is_empty() {
                return Err("This PDF has no readable text.".into());
            }
            text(item.body.as_bytes())
        })
    })
    .join()
    .map_err(|_| "Couldn't read PDF.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn vault() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        (temp, root)
    }
    fn image(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(width, height)
            .write_to(&mut bytes, format)
            .unwrap();
        bytes.into_inner()
    }
    #[test]
    fn import_commit_retry_copy_and_remove() {
        let (_temp, root) = vault();
        let chip = import(&root, "my notes.md", b"# Hello\nWorld").unwrap();
        assert_eq!(chip.kind, "attachment");
        assert_eq!(chip.label.as_deref(), Some("my notes.md"));
        assert!(chip.path.ends_with("/my_notes.md"));
        let original = chip.clone();
        let kin = threads::vault_dir(&root).unwrap();
        let mut chips = vec![chip];
        commit(&kin, "t-one", &mut chips).unwrap();
        assert!(chips[0].path.starts_with("@attachment/t-one/"));
        let persisted = chips[0].path.clone();
        assert_eq!(read(&root, &persisted).unwrap().0, "# Hello\nWorld");
        assert_eq!(preview(&root, &persisted).unwrap(), None);
        commit(&kin, "t-one", &mut chips).unwrap();
        assert_eq!(chips[0].path, persisted);
        let mut retry = vec![original.clone()];
        commit(&kin, "t-one", &mut retry).unwrap();
        assert_eq!(retry, chips);
        assert!(read(&root, &original.path).is_ok());
        commit(&kin, "t-two", &mut chips).unwrap();
        assert!(chips[0].path.starts_with("@attachment/t-two/"));
        remove(&kin, "t-one").unwrap();
        assert!(read(&root, &original.path).is_err());
        assert!(read(&root, &persisted).is_err());
        assert!(read(&root, &chips[0].path).is_ok());
        remove(&kin, "t-one").unwrap();
    }
    #[test]
    fn refuses_size_count_and_invalid_files() {
        let (_temp, root) = vault();
        assert!(import(&root, "a.txt", &vec![b'a'; MAX_BYTES + 1]).is_err());
        assert!(import(&root, "a.txt", b"").is_err());
        assert!(import(&root, "a.txt", &[0xff]).is_err());
        assert!(import(&root, "a.txt", b"a\0b").is_err());
        assert!(import(&root, "a.png", b"not an image").is_err());
        assert!(import(&root, "a.pdf", b"not a PDF").is_err());
        assert!(import(&root, "a.exe", b"binary").is_err());
        let chip = import(&root, "a.txt", b"okay").unwrap();
        let mut chips = vec![chip; 9];
        let before = chips.clone();
        assert!(commit(&kin_dir(&root).unwrap(), "t-one", &mut chips).is_err());
        assert_eq!(chips, before);
    }
    #[test]
    fn traversal_and_malformed_references() {
        let (_temp, root) = vault();
        for name in ["../x.txt", "/x.txt", "a/b.txt", "a\\b.txt", "..", "\0.txt"] {
            assert!(import(&root, name, b"okay").is_err(), "{name:?}");
        }
        for path in [
            "a.txt",
            "@attachment/../a.txt",
            "@attachment/t-one/a.txt",
            "@attachment/t-one/../../a.txt",
            "@attachment/t-one/a/b.txt",
            "@attachment//a.txt",
            "@attachment/t-one/éééééééééééééééééééé.txt",
            "@attachment/00000000-0000-0000-0000-000000000000/../a.txt",
        ] {
            assert!(read(&root, path).is_err(), "{path:?}");
        }
        for thread in [
            "..",
            "a/b",
            "",
            "/tmp",
            "00000000-0000-0000-0000-000000000000",
        ] {
            assert!(remove(&kin_dir(&root).unwrap(), thread).is_err());
        }
    }
    #[test]
    fn formats_mime_and_resize() {
        let (_temp, root) = vault();
        for format in [
            ImageFormat::Png,
            ImageFormat::Jpeg,
            ImageFormat::Gif,
            ImageFormat::WebP,
        ] {
            let bytes = image(format, 2000, 1000);
            // MIME comes from content, never from the claimed extension.
            let chip = import(&root, "picture.png", &bytes).unwrap();
            let (note, images) = read(&root, &chip.path).unwrap();
            assert_eq!(note, "Attached image.");
            assert_eq!(images[0].mime_type, "image/jpeg");
            let out = STANDARD.decode(&images[0].data).unwrap();
            let decoded = image::load_from_memory(&out).unwrap();
            assert_eq!((decoded.width(), decoded.height()), (1568, 784));
            assert!(out.len() < 5 * 1024 * 1024);
            assert!(
                preview(&root, &chip.path)
                    .unwrap()
                    .unwrap()
                    .starts_with("data:image/jpeg;base64,")
            );
        }
    }
    #[test]
    fn decode_bomb_dimensions_and_local_file_cap() {
        assert!(check_dimensions(10_000, 10_000).is_err());
        assert!(check_dimensions(1, 40_000).is_err());
        assert!(check_dimensions(0, 1).is_err());
        let (_temp, root) = vault();
        let huge = root.join("huge.png");
        let file = File::create(&huge).unwrap();
        file.set_len(MAX_BYTES as u64 + 1).unwrap();
        assert!(image_file(&huge).is_err());
        let directory = root.join("directory.png");
        fs::create_dir(&directory).unwrap();
        assert!(image_file(&directory).is_err());
    }
    #[test]
    fn bounded_text_and_pdf_import() {
        let (_temp, root) = vault();
        let original = "é".repeat(100_001);
        let chip = import(&root, "long.txt", original.as_bytes()).unwrap();
        let body = read(&root, &chip.path).unwrap().0;
        assert_eq!(body, original, "stored text must not lose its tail");
        struct Saved;
        impl kintsugi_ingest::pdf::PdfReader for Saved {
            fn read<'a>(
                &'a self,
                _: &'a Path,
                _: Option<&'a Path>,
            ) -> kintsugi_ingest::BoxFuture<
                'a,
                kintsugi_ingest::Result<kintsugi_ingest::pdf::PdfText>,
            > {
                Box::pin(async {
                    use kintsugi_ingest::pdf::layout::{Line, PageText, PdfText};
                    Ok(PdfText {
                        page_count: 1,
                        pages: vec![PageText {
                            page: 1,
                            lines: vec![Line {
                                text: "Local PDF text.".into(),
                                size: 12.0,
                                ..Default::default()
                            }],
                            ..Default::default()
                        }],
                        ..Default::default()
                    })
                })
            }
        }
        let pdf = include_bytes!("../../../../../crates/ingest/fixtures/pdf/columns.pdf");
        let extracted = pdf_with_reader(pdf, Some(std::sync::Arc::new(Saved))).unwrap();
        assert!(extracted.contains("Local PDF text."));
        let chip = stage(&root, "paper.pdf", "paper.pdf", pdf, Some(&extracted)).unwrap();
        assert_eq!(preview(&root, &chip.path).unwrap(), None);
        let staged = chip.path.clone();
        assert_eq!(read(&root, &staged).unwrap().0, extracted);
        let mut chips = vec![chip];
        let kin = kin_dir(&root).unwrap();
        commit(&kin, "t-pdf", &mut chips).unwrap();
        assert_eq!(read(&root, &chips[0].path).unwrap().0, extracted);
        commit(&kin, "t-pdf-copy", &mut chips).unwrap();
        remove(&kin, "t-pdf").unwrap();
        assert!(read(&root, &staged).is_err());
        assert_eq!(read(&root, &chips[0].path).unwrap().0, extracted);
        assert!(pdf_with_reader(pdf, None).is_err());
    }
    #[test]
    fn discard_and_expired_staging() {
        let (_temp, root) = vault();
        let chip = import(&root, "gone.txt", b"gone").unwrap();
        discard(&root, &chip.path).unwrap();
        discard(&root, &chip.path).unwrap();
        assert!(read(&root, &chip.path).is_err());
        let chip = import(&root, "old.txt", b"old").unwrap();
        let file = resolve(&root, &chip.path).unwrap();
        let dir = file.parent().unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 24 * 60 * 60);
        File::open(dir)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
        let current = import(&root, "new.txt", b"new").unwrap();
        assert!(!dir.exists());
        let mut chips = vec![current];
        commit(&kin_dir(&root).unwrap(), "t-one", &mut chips).unwrap();
        assert!(discard(&root, &chips[0].path).is_err());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn pdfkit_extracts_real_fixture() {
        let (_temp, root) = vault();
        let source = root.join("pdf.swift");
        let helper = root.join("kintsugi-pdf");
        fs::write(
            &source,
            include_str!("../../../../../crates/ingest/swift/pdf.swift"),
        )
        .unwrap();
        let status = std::process::Command::new("xcrun")
            .args(["swiftc", "-O", "-parse-as-library"])
            .arg(&source)
            .arg("-o")
            .arg(&helper)
            .status()
            .unwrap();
        assert!(status.success());
        let bytes = include_bytes!("../../../../../crates/ingest/fixtures/pdf/repair.pdf");
        let body = pdf_with_reader(
            bytes,
            Some(std::sync::Arc::new(
                kintsugi_ingest::pdf::PdfKitReader::new(helper),
            )),
        )
        .unwrap();
        assert!(body.contains("Urushi lacquer"));
        let chip = stage(&root, "repair.pdf", "repair.pdf", bytes, Some(&body)).unwrap();
        assert_eq!(read(&root, &chip.path).unwrap().0, body);
        let outputs = tempfile::tempdir().unwrap();
        let tools = crate::ai::tools::Tools::new(&root, outputs.path().into(), "pdf").unwrap();
        let (message, images) = tools.attachment_chips(std::slice::from_ref(&chip));
        assert!(images.is_empty());
        let restarted =
            crate::ai::tools::Tools::new(&root, outputs.path().into(), "pdf-replay").unwrap();
        crate::ai::context::protect(&restarted, &message);
        for context in [tools, restarted] {
            let memory = tempfile::tempdir().unwrap();
            let context = context.with_memory(crate::ai::memory::Access {
                store: crate::ai::memory::Store::open(&root, Some(memory.path())).unwrap(),
                source: crate::ai::memory::Source::chat("pdf", "Save this"),
                remember: true,
            });
            let refused = context.run(&crate::ai::wire::ToolCall {
                id:"save".into(), name:"memory".into(), arguments:serde_json::json!({"file":"user","ops":[{"op":"add","text":"A planted PDF preference."}]}),
            });
            assert!(refused.is_error);
            assert_eq!(refused.content, crate::ai::web::guard::MEMORY_LOCKED);
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn heic_converts_to_verified_jpeg() {
        let (_temp, root) = vault();
        let input = root.join("source.png");
        let output = root.join("photo.heic");
        fs::write(&input, image(ImageFormat::Png, 40, 20)).unwrap();
        let status = std::process::Command::new("/usr/bin/sips")
            .args(["-s", "format", "heic"])
            .arg(&input)
            .arg("--out")
            .arg(&output)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        let encoded = image_file(&output).unwrap();
        assert_eq!(encoded.mime_type, "image/jpeg");
        let decoded = image::load_from_memory(&STANDARD.decode(encoded.data).unwrap()).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (40, 20));
    }
    #[test]
    fn exif_orientation_is_applied() {
        let mut bytes = image(ImageFormat::Jpeg, 10, 5);
        // APP1 EXIF: little-endian TIFF with orientation=6 (90 degrees).
        let exif: &[u8] =
            b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
        let mut app1 = vec![0xff, 0xe1];
        app1.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        app1.extend_from_slice(exif);
        bytes.splice(2..2, app1);
        let encoded = image_bytes(&bytes).unwrap();
        let decoded = image::load_from_memory(&STANDARD.decode(encoded.data).unwrap()).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (5, 10));
    }
    #[cfg(unix)]
    #[test]
    fn refuses_links_at_every_level() {
        use std::os::unix::fs::symlink;
        let (_temp, root) = vault();
        let outside = root.join("outside");
        fs::create_dir(&outside).unwrap();
        let link_root = root.join("alias");
        symlink(&outside, &link_root).unwrap();
        assert!(import(&link_root, "a.txt", b"x").is_err());
        symlink(&outside, root.join(".kintsugi")).unwrap();
        assert!(import(&root, "a.txt", b"x").is_err());
        fs::remove_file(root.join(".kintsugi")).unwrap();
        let chip = import(&root, "a.txt", b"x").unwrap();
        let path = resolve(&root, &chip.path).unwrap();
        let kin = kin_dir(&root).unwrap();
        let mut chips = vec![chip.clone()];
        fs::remove_file(&path).unwrap();
        let secret = outside.join("secret.txt");
        fs::write(&secret, "secret").unwrap();
        symlink(&secret, &path).unwrap();
        assert!(read(&root, &chip.path).is_err());
        assert!(commit(&kin, "t-one", &mut chips).is_err());
        fs::remove_file(&path).unwrap();
        fs::write(&path, "safe").unwrap();
        symlink(&outside, kin.join("attachments/t-one")).unwrap();
        assert!(commit(&kin, "t-one", &mut chips).is_err());
        assert!(remove(&kin, "t-one").is_err());
        fs::remove_file(kin.join("attachments/t-one")).unwrap();
        commit(&kin, "t-one", &mut chips).unwrap();
        let persisted = resolve(&root, &chips[0].path).unwrap();
        fs::remove_file(&persisted).unwrap();
        symlink(&secret, &persisted).unwrap();
        assert!(remove(&kin, "t-one").is_err());
        assert_eq!(fs::read_to_string(secret).unwrap(), "secret");
    }
}

#[cfg(test)]
mod paging_tests {
    use super::*;

    struct Reader {
        line: String,
        page_count: usize,
    }
    impl kintsugi_ingest::pdf::PdfReader for Reader {
        fn read<'a>(
            &'a self,
            _: &'a Path,
            _: Option<&'a Path>,
        ) -> kintsugi_ingest::BoxFuture<'a, kintsugi_ingest::Result<kintsugi_ingest::pdf::PdfText>>
        {
            Box::pin(async {
                use kintsugi_ingest::pdf::layout::{Line, PageText, PdfText};
                Ok(PdfText {
                    page_count: self.page_count,
                    pages: vec![PageText {
                        page: 1,
                        lines: vec![Line {
                            text: self.line.clone(),
                            size: 12.0,
                            ..Default::default()
                        }],
                        ..Default::default()
                    }],
                    ..Default::default()
                })
            })
        }
    }

    #[test]
    fn complete_pdf_cache_retains_text_beyond_old_cap_and_refuses_adapter_truncation() {
        let pdf = include_bytes!("../../../../../crates/ingest/fixtures/pdf/columns.pdf");
        let body = format!("BEGIN {} PDF_END", "é".repeat(100_100));
        let extracted = pdf_with_reader(
            pdf,
            Some(std::sync::Arc::new(Reader {
                line: body,
                page_count: 1,
            })),
        )
        .unwrap();
        assert!(extracted.chars().count() > 100_000);
        assert!(extracted.ends_with("PDF_END"));
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let chip = stage(&root, "long.pdf", "long.pdf", pdf, Some(&extracted)).unwrap();
        let mut chips = vec![chip];
        commit(&kin_dir(&root).unwrap(), "t-long-pdf", &mut chips).unwrap();
        assert_eq!(read(&root, &chips[0].path).unwrap().0, extracted);
        let too_large = pdf_with_reader(
            pdf,
            Some(std::sync::Arc::new(Reader {
                line: "x".repeat(PDF_TEXT_CHARS + 1),
                page_count: 1,
            })),
        )
        .unwrap_err();
        assert!(too_large.contains("250,000"), "{too_large}");
        let incomplete = pdf_with_reader(
            pdf,
            Some(std::sync::Arc::new(Reader {
                line: "one page".into(),
                page_count: 2,
            })),
        )
        .unwrap_err();
        assert!(incomplete.contains("incomplete"));
    }

    #[test]
    fn locked_pdf_is_refused_before_caching() {
        struct Locked;
        impl kintsugi_ingest::pdf::PdfReader for Locked {
            fn read<'a>(
                &'a self,
                _: &'a Path,
                _: Option<&'a Path>,
            ) -> kintsugi_ingest::BoxFuture<
                'a,
                kintsugi_ingest::Result<kintsugi_ingest::pdf::PdfText>,
            > {
                Box::pin(async {
                    Ok(kintsugi_ingest::pdf::PdfText {
                        locked: true,
                        page_count: 1,
                        ..Default::default()
                    })
                })
            }
        }
        let pdf = include_bytes!("../../../../../crates/ingest/fixtures/pdf/columns.pdf");
        assert_eq!(
            pdf_with_reader(pdf, Some(std::sync::Arc::new(Locked))).unwrap_err(),
            "Remove the PDF password before attaching."
        );
    }

    #[test]
    fn windows_preserve_unicode_and_provide_gapless_continuation() {
        let original = (1..=1000)
            .map(|n| format!("Paragraph {n} {}\n", "語é ".repeat(24)))
            .collect::<String>();
        let mut offset = 1;
        let mut numbers = Vec::new();
        while offset <= 1000 {
            let page = text_page("@attachment/t-file/name.txt", &original, offset, 1000).unwrap();
            assert!(page.len() <= READ_TEXT_BYTES);
            let shown: Vec<usize> = page
                .lines()
                .filter_map(|line| line.split_once(": ")?.0.parse().ok())
                .collect();
            assert_eq!(shown[0], offset);
            offset = shown.last().unwrap() + 1;
            if offset <= 1000 {
                assert!(page.contains(&format!("more: read with offset {offset}")));
            }
            numbers.extend(shown);
        }
        assert_eq!(numbers, (1..=1000).collect::<Vec<_>>());
    }
}
