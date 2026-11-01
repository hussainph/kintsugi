//! PDF export: Typst, in-process, with the fonts it bundles (Libertinus
//! Serif, DejaVu Sans Mono, New Computer Modern). The frontend renders a
//! piece to Typst source (`packages/core/src/export-typst.ts`); this compiles
//! it against a closed world: that one source file plus the piece's images,
//! read from the vault. No packages, no system fonts, no other files, so the
//! same piece typesets the same way everywhere, headless runs included.

use std::collections::HashMap;
use std::sync::OnceLock;
use typst::diag::{FileError, FileResult, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_layout::PagedDocument;

type Result<T> = std::result::Result<T, String>;

struct Fonts {
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
}

fn fonts() -> &'static Fonts {
    static FONTS: OnceLock<Fonts> = OnceLock::new();
    FONTS.get_or_init(|| {
        let fonts: Vec<Font> = typst_assets::fonts().flat_map(|data| Font::iter(Bytes::new(data))).collect();
        Fonts { book: LazyHash::new(FontBook::from_fonts(&fonts)), fonts }
    })
}

fn library() -> &'static LazyHash<Library> {
    static LIBRARY: OnceLock<LazyHash<Library>> = OnceLock::new();
    LIBRARY.get_or_init(|| LazyHash::new(Library::builder().build()))
}

fn file_id(path: &str) -> Result<FileId> {
    let vpath = VirtualPath::new(path).map_err(|e| format!("{e:?}"))?;
    Ok(RootedPath::new(VirtualRoot::Project, vpath).intern())
}

struct Piece {
    main: Source,
    /// `/assets/<name>` → bytes.
    files: HashMap<FileId, Bytes>,
}

impl World for Piece {
    fn library(&self) -> &LazyHash<Library> {
        library()
    }
    fn book(&self) -> &LazyHash<FontBook> {
        &fonts().book
    }
    fn main(&self) -> FileId {
        self.main.id()
    }
    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main.id() { Ok(self.main.clone()) } else { Err(FileError::AccessDenied) }
    }
    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.files.get(&id).cloned().ok_or(FileError::AccessDenied)
    }
    fn font(&self, index: usize) -> Option<Font> {
        fonts().fonts.get(index).cloned()
    }
    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        None
    }
}

fn describe(errors: &[SourceDiagnostic]) -> String {
    let messages: Vec<String> = errors.iter().take(3).map(|e| e.message.to_string()).collect();
    format!("The PDF couldn't be typeset: {}", messages.join("; "))
}

/// Typesets `source`; `assets` are (name, bytes) pairs it may show as
/// `/assets/<name>`.
pub fn typeset(source: &str, assets: Vec<(String, Vec<u8>)>) -> Result<PagedDocument> {
    let main = Source::new(file_id("/main.typ")?, source.to_string());
    let mut files = HashMap::new();
    for (name, bytes) in assets {
        if name.contains('/') || name.starts_with('.') {
            return Err(format!("not an asset name: {name}"));
        }
        files.insert(file_id(&format!("/assets/{name}"))?, Bytes::new(bytes));
    }
    let world = Piece { main, files };
    typst::compile::<PagedDocument>(&world).output.map_err(|errors| describe(&errors))
}

pub fn pdf(document: &PagedDocument) -> Result<Vec<u8>> {
    let options = typst_pdf::PdfOptions { creator: typst::foundations::Smart::Custom(Some("Kintsugi".into())), ..Default::default() };
    typst_pdf::pdf(document, &options).map_err(|errors| describe(&errors))
}

/// The first `limit` pages as SVG, for the export dialog's preview.
pub fn svg_pages(document: &PagedDocument, limit: usize) -> Vec<String> {
    document.pages().iter().take(limit).map(|page| typst_svg::svg(page, &Default::default())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PIECE: &str = r##"#set document(title: "On craft")
#set text(font: "Libertinus Serif", lang: "en")
#text(size: 2em)[#"On craft"]

#"Text with \"quotes\", a # hash, a $ and a "#link("https://example.com")[#"link"]#"."

#figure(image("/assets/image-1.png", alt: "dot"), caption: [#"A dot"])
"##;

    /// A 1×1 PNG.
    fn png() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0,
            0, 0x90, 0x77, 0x53, 0xde, 0, 0, 0, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0, 0, 0x03, 0x01,
            0x01, 0, 0x18, 0xdd, 0x8d, 0xb0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ]
    }

    #[test]
    fn typesets_a_piece_with_an_image_into_a_pdf_and_svg() {
        let doc = typeset(PIECE, vec![("image-1.png".into(), png())]).unwrap();
        let bytes = pdf(&doc).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("Kintsugi"), "the creator is recorded");
        assert!(text.contains("https://example.com"), "links stay links");
        let pages = svg_pages(&doc, 4);
        assert_eq!(pages.len(), 1);
        assert!(pages[0].starts_with("<svg"));
    }

    #[test]
    fn the_world_is_closed() {
        // Only the piece's own assets: no files from disk, no packages.
        let err = typeset(r#"#image("/etc/hosts")"#, vec![]).unwrap_err();
        assert!(err.contains("couldn't be typeset"), "{err}");
        let err = typeset(r#"#import "@preview/anything:0.1.0": *"#, vec![]).unwrap_err();
        assert!(err.contains("couldn't be typeset"), "{err}");
        assert!(typeset("x", vec![("../evil.png".into(), png())]).is_err());
    }
}
