// kintsugi-pdf: reads one PDF with Apple's PDFKit (part of macOS, nothing to
// download). The Rust side (`kintsugi_ingest::pdf::PdfKitReader`) runs it as
// a child process, so a malformed file that crashes or hangs the parser can
// be killed without taking the app down.
//
//   kintsugi-pdf <file.pdf> [--max-chars N] [--thumbnail <out.png>]
//
// stdout: {"pageCount":3,"locked":false,"title":…,"author":…,"subject":…,
//          "keywords":[…],"created":"2024-05-01T10:00:00Z","outline":[{"title":…,"page":1,"level":1}],
//          "pages":[{"page":1,"lines":[{"text":"…","size":24.0,"bold":true,"y":700.0}]}]}
// Exit codes: 0 done, 2 usage, 3 unsupported (no PDFKit), 5 the file is not
// a readable PDF. Nothing is printed on stdout unless the exit code is 0, and
// stderr carries no document text.
//
// Lines keep their dominant font size so the Rust side can tell headings
// from body text; it also rebuilds paragraphs, drops running headers and
// page numbers, and writes the Markdown. --thumbnail renders page one as a
// PNG at most 800 pixels on its long side (the clip's card image).

import AppKit
import Foundation
import PDFKit

struct Line: Encodable {
    let text: String
    let size: Double
    let bold: Bool
    /// The line's bottom edge in page points, from the page's bottom; the
    /// gap between lines tells paragraphs apart.
    let y: Double
}

struct Page: Encodable {
    let page: Int
    let lines: [Line]
}

struct OutlineEntry: Encodable {
    let title: String
    let page: Int?
    let level: Int
}

struct Output: Encodable {
    let pageCount: Int
    let locked: Bool
    let title: String?
    let author: String?
    let subject: String?
    let keywords: [String]
    let created: String?
    let outline: [OutlineEntry]
    let pages: [Page]
}

func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

func attribute(_ document: PDFDocument, _ key: PDFDocumentAttribute) -> String? {
    guard let value = document.documentAttributes?[key] as? String else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : String(trimmed.prefix(500))
}

/// Each line of a page with the font size that covers most of its characters.
func lines(of page: PDFPage) -> [Line] {
    guard let text = page.attributedString, text.length > 0 else { return [] }
    let string = text.string as NSString
    var result: [Line] = []
    string.enumerateSubstrings(in: NSRange(location: 0, length: string.length), options: [.byLines]) { line, range, _, _ in
        guard let line = line?.trimmingCharacters(in: .whitespaces), !line.isEmpty else { return }
        var sizes: [Double: Int] = [:]
        var boldChars = 0
        text.enumerateAttribute(.font, in: range) { value, run, _ in
            guard let font = value as? NSFont else { return }
            sizes[Double(font.pointSize), default: 0] += run.length
            if font.fontDescriptor.symbolicTraits.contains(.bold) || font.fontName.lowercased().contains("bold") {
                boldChars += run.length
            }
        }
        let size = sizes.max { $0.value < $1.value }?.key ?? 0
        let y = page.selection(for: range).map { Double($0.bounds(for: page).minY) } ?? 0
        result.append(
            Line(text: line, size: (size * 10).rounded() / 10, bold: boldChars * 2 > range.length, y: (y * 10).rounded() / 10))
    }
    return result
}

func outline(_ document: PDFDocument) -> [OutlineEntry] {
    var entries: [OutlineEntry] = []
    func walk(_ node: PDFOutline, level: Int) {
        for i in 0..<node.numberOfChildren {
            guard entries.count < 500, let child = node.child(at: i) else { return }
            if let label = child.label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty {
                let page = child.destination?.page.map { document.index(for: $0) + 1 }
                entries.append(OutlineEntry(title: String(label.prefix(300)), page: page, level: level))
            }
            if level < 4 { walk(child, level: level + 1) }
        }
    }
    if let root = document.outlineRoot { walk(root, level: 1) }
    return entries
}

func writeThumbnail(_ page: PDFPage, to path: String) {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width > 0, bounds.height > 0 else { return }
    let scale = 800 / max(bounds.width, bounds.height)
    let image = page.thumbnail(of: NSSize(width: bounds.width * scale, height: bounds.height * scale), for: .mediaBox)
    guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
        let png = bitmap.representation(using: .png, properties: [:])
    else { return }
    try? png.write(to: URL(fileURLWithPath: path))
}

@main
struct Main {
    static func main() {
        var args = Array(CommandLine.arguments.dropFirst())
        guard !args.isEmpty else { fail(2, "usage: kintsugi-pdf <file.pdf> [--max-chars N] [--thumbnail out.png]") }
        let path = args.removeFirst()
        var maxChars = 400_000
        var thumbnail: String?
        while !args.isEmpty {
            let flag = args.removeFirst()
            guard !args.isEmpty else { fail(2, "missing value for \(flag)") }
            let value = args.removeFirst()
            switch flag {
            case "--max-chars": maxChars = Int(value) ?? maxChars
            case "--thumbnail": thumbnail = value
            default: fail(2, "unknown option")
            }
        }
        guard let document = PDFDocument(url: URL(fileURLWithPath: path)) else { fail(5, "not a readable PDF") }
        // Many PDFs are "encrypted" only against editing, with an empty
        // password for reading.
        if document.isLocked { _ = document.unlock(withPassword: "") }
        let locked = document.isLocked
        var pages: [Page] = []
        var chars = 0
        if !locked {
            for index in 0..<document.pageCount {
                guard chars < maxChars, let page = document.page(at: index) else { break }
                let found = lines(of: page)
                chars += found.reduce(0) { $0 + $1.text.count }
                pages.append(Page(page: index + 1, lines: found))
            }
            if let thumbnail, let first = document.page(at: 0) { writeThumbnail(first, to: thumbnail) }
        }
        let formatter = ISO8601DateFormatter()
        let created = (document.documentAttributes?[PDFDocumentAttribute.creationDateAttribute] as? Date).map {
            formatter.string(from: $0)
        }
        let keywords: [String]
        switch document.documentAttributes?[PDFDocumentAttribute.keywordsAttribute] {
        case let list as [String]: keywords = list
        case let text as String: keywords = text.split(whereSeparator: { $0 == "," || $0 == ";" }).map(String.init)
        default: keywords = []
        }
        let output = Output(
            pageCount: document.pageCount,
            locked: locked,
            title: attribute(document, .titleAttribute),
            author: attribute(document, .authorAttribute),
            subject: attribute(document, .subjectAttribute),
            keywords: keywords.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.prefix(20).map { String($0.prefix(100)) },
            created: created,
            outline: locked ? [] : outline(document),
            pages: pages)
        guard let data = try? JSONEncoder().encode(output) else { fail(5, "could not encode the result") }
        FileHandle.standardOutput.write(data)
        exit(0)
    }
}
