//! Request-time image bounds. Storage prepares images once; this only
//! shrinks further for a model's catalog profile and never changes history.

use super::{Exchange, Image, Item, Result, Route, Wire};
use crate::ai::pi_auth::Auth;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{ImageFormat, ImageReader};
use serde_json::Value;
use std::{borrow::Cow, io::Cursor};

const MAX_SOURCE_BYTES: usize = 20 * 1024 * 1024;
const MAX_EDGE: u32 = 32_768;
const MAX_PIXELS: u64 = 40_000_000;

// Conservative fallbacks for unlisted models and incomplete catalog entries.
const MAX_PER_MESSAGE: usize = 20;
const MAX_PER_REQUEST: usize = 100;
const MAX_REQUEST_BYTES: usize = 20 * 1024 * 1024;
const OMITTED: &str = "[Harness: Older images omitted to fit this model's limits.]";

/// A request-local view; neither resizing nor eviction changes stored history.
pub(super) struct Prepared<'a> {
    pub items: Cow<'a, [Item]>,
    pub system: Cow<'a, str>,
    omission_noted: bool,
}

impl Prepared<'_> {
    pub fn exchange<'a>(&'a self, ex: &Exchange<'a>) -> Exchange<'a> {
        Exchange {
            items: self.items.as_ref(),
            system: self.system.as_ref(),
            ..ex.clone()
        }
    }

    fn omit(&mut self, remove: &[bool]) {
        let mut index = 0;
        for item in self.items.to_mut() {
            if let Item::Images(images) = item {
                images.retain(|_| {
                    let keep = !remove[index];
                    index += 1;
                    keep
                });
            }
        }
        if !self.omission_noted {
            // Keep the system/tool cache prefix byte-stable. Editing the
            // newest user text or tool output also preserves image grouping.
            let text = self
                .items
                .to_mut()
                .iter_mut()
                .rev()
                .find_map(|item| match item {
                    Item::User(text) => Some(text),
                    Item::Results(results) => results.last_mut().map(|result| &mut result.content),
                    _ => None,
                });
            if let Some(text) = text {
                text.push_str("\n\n");
                text.push_str(OMITTED);
            } else {
                // Image-only input has no text to annotate. Append after the
                // images so this cannot split an existing image group.
                self.items.to_mut().push(Item::User(OMITTED.into()));
            }
            self.omission_noted = true;
        }
    }
}

/// Run once before retrying. Count actual encoded user messages, not Item
/// batches: images can merge across empty/skipped items or follow tool results
/// in a separate user message, depending on the wire.
pub(super) fn prepare_request<'a>(
    route: &Route,
    auth: Option<&Auth>,
    ex: &Exchange<'a>,
) -> Result<Prepared<'a>> {
    let limits = route.model.map(|m| &m.input_limits);
    let image_limits = limits.and_then(|l| l.images.as_ref());
    let per_message = image_limits
        .and_then(|l| l.max_per_message)
        .unwrap_or(MAX_PER_MESSAGE);
    let per_request = image_limits
        .and_then(|l| l.max_per_request)
        .unwrap_or(MAX_PER_REQUEST);
    let max_bytes = limits
        .and_then(|l| l.max_request_bytes)
        .unwrap_or(MAX_REQUEST_BYTES);
    let mut prepared = Prepared {
        items: prepare(route, ex.items)?,
        system: Cow::Borrowed(ex.system),
        omission_noted: false,
    };
    let mut encoded = body(route, auth, &prepared.exchange(ex));
    let groups = image_groups(route.wire, &encoded);
    let expected: usize = if route.model.is_some_and(|model| !model.images()) {
        0
    } else {
        prepared
            .items
            .iter()
            .map(|item| match item {
                Item::Images(images) => images.len(),
                _ => 0,
            })
            .sum()
    };
    // Refuse rather than silently bypassing limits if an encoder's image
    // representation ever changes without updating this accounting adapter.
    if groups.iter().sum::<usize>() != expected {
        return Err("Couldn't account for the images in this request.".into());
    }
    let mut remove = Vec::new();
    for count in groups {
        remove.extend((0..count).map(|i| i < count.saturating_sub(per_message)));
    }
    let mut excess = remove
        .iter()
        .filter(|&&drop| !drop)
        .count()
        .saturating_sub(per_request);
    for drop in &mut remove {
        if !*drop && excess > 0 {
            *drop = true;
            excess -= 1;
        }
    }
    if remove.iter().any(|&drop| drop) {
        prepared.omit(&remove);
        drop(encoded);
        encoded = body(route, auth, &prepared.exchange(ex));
    }
    // Serialize exactly the same body as RequestBuilder::json, including
    // base64 prefixes, JSON escaping, tools, replay, options and the note.
    // Re-encode after eviction: empty messages and cache markers can change.
    loop {
        let bytes = encoded_bytes(&encoded)?;
        if bytes <= max_bytes {
            return Ok(prepared);
        }
        let count: usize = image_groups(route.wire, &encoded).into_iter().sum();
        drop(encoded);
        if count == 0 {
            return Err(
                "Request exceeds this model's byte limit without images. Shorten the conversation."
                    .into(),
            );
        }
        let mut remove = vec![false; count];
        remove[0] = true;
        prepared.omit(&remove);
        encoded = body(route, auth, &prepared.exchange(ex));
    }
}

/// Shared encoder dispatch ensures accounting includes auth-dependent options
/// (notably OpenAI subscription requests), and Codex's distinct envelope.
fn body(route: &Route, auth: Option<&Auth>, ex: &Exchange) -> Value {
    match route.wire {
        Wire::Anthropic => super::anthropic::body(route, ex).0,
        Wire::OpenAiChat => super::chat::body(route, &super::chat::Compat::of(route, ex.model), ex),
        Wire::OpenAiResponses => super::responses::body(route, auth, ex),
        Wire::Codex => super::responses::codex_body(route, ex),
        Wire::Google | Wire::Vertex => super::google::body(route, ex),
    }
}

fn encoded_bytes(body: &Value) -> Result<usize> {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, body).map_err(|e| e.to_string())?;
    Ok(counter.0)
}

fn image_groups(wire: Wire, body: &Value) -> Vec<usize> {
    let (messages, parts) = match wire {
        Wire::Anthropic | Wire::OpenAiChat => ("messages", "content"),
        Wire::OpenAiResponses | Wire::Codex => ("input", "content"),
        Wire::Google | Wire::Vertex => ("contents", "parts"),
    };
    body[messages]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["role"] == "user")
        .map(|m| {
            m[parts]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|p| match wire {
                    Wire::Anthropic => p["type"] == "image",
                    Wire::OpenAiChat => p["type"] == "image_url",
                    Wire::OpenAiResponses | Wire::Codex => p["type"] == "input_image",
                    Wire::Google | Wire::Vertex => p.get("inlineData").is_some(),
                })
                .count()
        })
        .filter(|&count| count > 0)
        .collect()
}

pub(super) fn prepare<'a>(route: &Route, items: &'a [Item]) -> Result<Cow<'a, [Item]>> {
    // The encoder substitutes a text note for text-only models. Do not
    // decode images that will not be sent (including older conversation parts).
    if route.model.is_some_and(|m| !m.images()) {
        return Ok(Cow::Borrowed(items));
    }
    let mut output = Cow::Borrowed(items);
    for (i, item) in items.iter().enumerate() {
        if let Item::Images(images) = item {
            for (j, image) in images.iter().enumerate() {
                if let Some(resized) = image.for_route(route)? {
                    let Item::Images(images) = &mut output.to_mut()[i] else {
                        unreachable!()
                    };
                    images[j] = resized;
                }
            }
        }
    }
    Ok(output)
}

impl Image {
    /// `None` leaves already-bounded input byte-for-byte intact. Pi's
    /// catalog defaults are 2000px / 4.5 MiB base64 / JPEG quality 80;
    /// Anthropic stays within its recommended 1568px edge by default.
    fn for_route(&self, route: &Route) -> Result<Option<Image>> {
        let profile = route
            .model
            .and_then(|m| m.input_limits.images.as_ref())
            .and_then(|limits| limits.resize)
            .unwrap_or_default();
        let edge = if route.wire == Wire::Anthropic {
            1568
        } else {
            2000
        };
        let width = profile.max_width.unwrap_or(edge).min(MAX_EDGE);
        let height = profile.max_height.unwrap_or(edge).min(MAX_EDGE);
        let max_bytes = profile.max_bytes.unwrap_or(9 * 1024 * 1024 / 2);
        let quality = profile.jpeg_quality.unwrap_or(80).clamp(1, 100);
        if width == 0 || height == 0 || max_bytes == 0 {
            return Err("Invalid image limits.".into());
        }
        if self.data.len() > MAX_SOURCE_BYTES.div_ceil(3) * 4 {
            return Err("Image is too large.".into());
        }
        let bytes = STANDARD
            .decode(&self.data)
            .map_err(|_| "Couldn't decode image.")?;
        let format = image::guess_format(&bytes).map_err(|_| "Couldn't read image.")?;
        let mime_type = match format {
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::Png => "image/png",
            ImageFormat::Gif => "image/gif",
            ImageFormat::WebP => "image/webp",
            _ => return Err("Unsupported image format.".into()),
        };
        let (w, h) = ImageReader::with_format(Cursor::new(&bytes), format)
            .into_dimensions()
            .map_err(|_| "Couldn't read image dimensions.")?;
        if w == 0
            || h == 0
            || w > MAX_EDGE
            || h > MAX_EDGE
            || u64::from(w) * u64::from(h) > MAX_PIXELS
        {
            return Err("Image dimensions are too large.".into());
        }
        if w <= width && h <= height && self.data.len() <= max_bytes {
            return Ok((self.mime_type != mime_type).then(|| Image {
                mime_type: mime_type.into(),
                data: self.data.clone(),
            }));
        }
        let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(MAX_EDGE);
        limits.max_image_height = Some(MAX_EDGE);
        limits.max_alloc = Some(160 * 1024 * 1024);
        reader.limits(limits);
        let mut decoded = reader
            .decode()
            .map_err(|_| "Couldn't decode image.")?
            .thumbnail(width, height);
        loop {
            // Preserve transparent backgrounds as white when converting to JPEG.
            let mut rgb = image::RgbImage::new(decoded.width(), decoded.height());
            for (x, y, pixel) in decoded.to_rgba8().enumerate_pixels() {
                let alpha = u16::from(pixel[3]);
                rgb.put_pixel(
                    x,
                    y,
                    image::Rgb(std::array::from_fn(|i| {
                        ((u16::from(pixel[i]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
                    })),
                );
            }
            let mut encoded = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, quality)
                .encode_image(&image::DynamicImage::ImageRgb8(rgb))
                .map_err(|_| "Couldn't resize image.")?;
            let data = STANDARD.encode(encoded);
            if data.len() <= max_bytes {
                return Ok(Some(Image {
                    mime_type: "image/jpeg".into(),
                    data,
                }));
            }
            if decoded.width() == 1 && decoded.height() == 1 {
                return Err("Image cannot fit this model's limits.".into());
            }
            let scale = ((max_bytes as f64 / data.len() as f64).sqrt() * 0.9).clamp(0.1, 0.9);
            let width = ((decoded.width() as f64 * scale) as u32).max(1);
            let height = ((decoded.height() as f64 * scale) as u32).max(1);
            decoded = decoded.thumbnail(width, height);
        }
    }
}
