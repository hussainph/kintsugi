import SwiftUI
import UIKit
import UniformTypeIdentifiers
import ImageIO

private let imageLimit = 15 * 1024 * 1024
/// `MAX_CLIP_FILE_BYTES` in core, as the Mac accepts it.
private let fileLimit = CaptureStore.maxFileBytes

private enum ShareError: LocalizedError {
  case unsupported, imageTooLarge, unsupportedImage, unsupportedFile, fileTooLarge, emptyFile, damagedFile
  var errorDescription: String? {
    switch self {
    case .unsupported: return "Share a link, some text, one image, or a PDF or EPUB."
    case .imageTooLarge: return "This image is over 15 MB. Share a smaller image or a link instead."
    case .unsupportedImage: return "Share a JPEG, PNG, GIF, WebP, HEIC, HEIF or AVIF image instead."
    case .unsupportedFile: return "Kintsugi saves PDFs and EPUBs. This file is neither, so it wasn’t saved."
    case .fileTooLarge: return "This file is over 50 MB, so it wasn’t saved. Kintsugi saves PDFs and EPUBs up to 50 MB."
    case .emptyFile: return "This file is empty, so it wasn’t saved."
    case .damagedFile: return "This doesn’t look like a PDF or EPUB inside, so it wasn’t saved."
    }
  }
}

/// A shared PDF or EPUB, copied into the extension's temporary folder so it
/// outlives the provider's callback. Its bytes are read only while saving,
/// a chunk at a time (`CaptureStore.enqueue(fields:file:)`).
private struct SharedDocument: Sendable {
  let url: URL
  let name: String
  let type: String
  let size: Int
  var isPDF: Bool { type == "application/pdf" }
}

/// A native sheet: no JS runtime, page fetching, or main-app launch on the capture path.
final class ShareViewController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    preferredContentSize = CGSize(width: 540, height: 560)
    let model = ShareModel(context: extensionContext)
    let host = UIHostingController(rootView: CaptureSheet(model: model))
    addChild(host)
    host.view.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(host.view)
    NSLayoutConstraint.activate([
      host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      host.view.topAnchor.constraint(equalTo: view.topAnchor),
      host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    host.didMove(toParent: self)
    Task { await model.load() }
  }
}

@MainActor
private final class ShareModel: ObservableObject {
  @Published var url: String?
  @Published var text = ""
  @Published var preview: UIImage?
  @Published var note = ""
  @Published var loading = true
  @Published var saving = false
  @Published var error: String?
  // A Save retry is the same capture, even after an uncertain local-write error.
  private let captureID = UUID().uuidString
  private var image: Data?
  private var imageType: String?
  @Published private(set) var document: SharedDocument?
  private let context: NSExtensionContext?
  /// Where shared files are staged; removed when the sheet finishes.
  private let staging = FileManager.default.temporaryDirectory
    .appendingPathComponent("share-\(UUID().uuidString)", isDirectory: true)

  init(context: NSExtensionContext?) { self.context = context }
  var canSave: Bool { !loading && !saving && (url != nil || !text.isEmpty || image != nil || document != nil) }
  var host: String { url.flatMap(URL.init(string:))?.host ?? "Shared inspiration" }

  func load() async {
    defer { loading = false }
    do {
      let items = context?.inputItems as? [NSExtensionItem] ?? []
      var passages = [String]()
      var otherFile = false
      for item in items {
        let providers = item.attachments ?? []
        // attributedContentText is a fallback; many hosts repeat it in a text provider.
        if let content = item.attributedContentText?.string, !content.isEmpty { passages.append(content) }
        for provider in providers {
          // One PDF or EPUB per share; it is the whole capture (see below).
          if let type = Self.documentType(provider) {
            if document == nil { document = try await loadDocument(provider, type: type) }
            continue
          }
          // File URLs also conform to public.url. Prefer the image representation
          // so Photos/Files providers advertising both cannot lose their image.
          if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier), image == nil {
            let type = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .image) == true }
              ?? UTType.image.identifier
            let data = try await loadImage(provider, type: type)
            guard data.count <= imageLimit else { throw ShareError.imageTooLarge }
            image = data
            imageType = UTType(type)?.preferredMIMEType ?? "image/jpeg"
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw ShareError.unsupported }
            if let type = CGImageSourceGetType(source) {
              imageType = UTType(type as String)?.preferredMIMEType ?? imageType
            }
            let supported = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "image/avif"]
            guard let imageType, supported.contains(imageType) else { throw ShareError.unsupportedImage }
            if let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                 kCGImageSourceCreateThumbnailFromImageAlways: true,
                 kCGImageSourceThumbnailMaxPixelSize: 800,
                 kCGImageSourceCreateThumbnailWithTransform: true,
               ] as CFDictionary) {
              preview = UIImage(cgImage: thumbnail)
            }
          } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            // Files and some hosts share a bare file URL (an `.epub` often comes this way).
            let value = try await loadItem(provider, type: UTType.fileURL.identifier)
            let candidate = (value as? URL)
              ?? (value as? Data).flatMap { URL(dataRepresentation: $0, relativeTo: nil) }
            if let candidate, candidate.isFileURL, let type = Self.documentType(name: candidate.lastPathComponent) {
              if document == nil { document = try stageDocument(candidate, name: provider.suggestedName, type: type) }
            } else {
              otherFile = true
            }
          } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            let value = try await loadItem(provider, type: UTType.url.identifier)
            let candidate = (value as? URL)?.absoluteString ?? (value as? String)
              ?? (value as? Data).flatMap { String(data: $0, encoding: .utf8) }
            if let candidate, Self.webURL(candidate) != nil { url = candidate }
          } else if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier) {
            let type = provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
              ? UTType.plainText.identifier : UTType.text.identifier
            let value = try await loadItem(provider, type: type)
            if let value = value as? String { passages.append(value) }
            else if let value = value as? NSAttributedString { passages.append(value.string) }
            else if let data = value as? Data, let value = String(data: data, encoding: .utf8) { passages.append(value) }
          } else if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
            otherFile = true // a Word document, a ZIP…: say so rather than "nothing to share"
          }
        }
      }
      // A document is the capture on its own: hosts such as Safari add the
      // page's URL, title or a thumbnail beside the file, and a clip is one
      // thing. The optional note still applies.
      if document != nil {
        url = nil; image = nil; imageType = nil; preview = nil
        return
      }
      // Social apps often supply "caption https://…" as a single text item.
      if url == nil {
        let detector = try NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        for passage in passages {
          if let match = detector.matches(in: passage, range: NSRange(passage.startIndex..., in: passage))
            .first(where: { $0.url.map { Self.webURL($0.absoluteString) != nil } ?? false }) {
            url = match.url?.absoluteString
            break
          }
        }
      }
      var unique = [String]()
      for passage in passages {
        let value = (url.map { passage.replacingOccurrences(of: $0, with: "") } ?? passage)
          .trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty && !unique.contains(value) { unique.append(value) }
      }
      text = unique.joined(separator: "\n\n")
      if url == nil && text.isEmpty && image == nil {
        throw otherFile ? ShareError.unsupportedFile : ShareError.unsupported
      }
    } catch {
      // Never enable Save for a partially loaded share; do not silently lose its image/text.
      url = nil; text = ""; image = nil; preview = nil; document = nil
      try? FileManager.default.removeItem(at: staging)
      self.error = error.localizedDescription
    }
  }

  func save() {
    guard canSave else { return }
    saving = true
    error = nil
    let capturedAt = CaptureStore.localStamp()
    let payloadID = captureID
    let sharedURL = url, sharedText = text, sharedImage = image, mimeType = imageType
    let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
    if let document {
      Task {
        do {
          // Streams the file into the queue a chunk at a time (never whole in
          // memory). The app sends it: only it checks that the Mac takes
          // files (`hello.api` 4), and a 50 MiB upload would outlast this
          // extension's background upload window.
          try await Task.detached {
            var fields: [String: Any] = [
              "id": payloadID, "capturedAt": capturedAt, "via": "share",
              "fileType": document.type, "fileName": document.name,
            ]
            if !trimmedNote.isEmpty { fields["note"] = trimmedNote }
            _ = try CaptureStore().enqueue(fields: fields, file: document.url)
          }.value
          try? FileManager.default.removeItem(at: staging)
          UINotificationFeedbackGenerator().notificationOccurred(.success)
          context?.completeRequest(returningItems: nil)
        } catch {
          saving = false
          self.error = "Couldn’t save on this iPhone. \(error.localizedDescription) Try again."
        }
      }
      return
    }
    Task {
      do {
        // Encode once, off the main thread. Avoid a 20 MB JSON String roundtrip
        // and a second full parse when sharing an image near the 15 MB limit.
        let queueID = try await Task.detached {
          var payload: [String: Any] = ["id": payloadID, "capturedAt": capturedAt, "via": "share"]
          if let sharedURL { payload["url"] = sharedURL }
          if !sharedText.isEmpty { payload["text"] = sharedText }
          if let sharedImage {
            payload["image"] = sharedImage.base64EncodedString()
            payload["imageType"] = mimeType
          }
          if !trimmedNote.isEmpty { payload["note"] = trimmedNote }
          let data = try JSONSerialization.data(withJSONObject: payload)
          return try CaptureStore().enqueue(data, capturedAt: capturedAt)
        }.value
        // The system owns this upload after resume. Any error leaves the outbox intact.
        try? CaptureDelivery.shared.start(id: queueID)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        context?.completeRequest(returningItems: nil)
      } catch {
        saving = false
        self.error = "Couldn’t save on this iPhone. \(error.localizedDescription) Try again."
      }
    }
  }

  func cancel() {
    try? FileManager.default.removeItem(at: staging)
    context?.completeRequest(returningItems: nil)
  }

  /// The PDF or EPUB type a provider offers, by UTI.
  private static func documentType(_ provider: NSItemProvider) -> String? {
    if provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) { return UTType.pdf.identifier }
    if provider.hasItemConformingToTypeIdentifier(UTType.epub.identifier) { return UTType.epub.identifier }
    return nil
  }

  /// The PDF or EPUB type of a file name, by extension (`clipFileType` in core).
  private static func documentType(name: String) -> String? {
    switch (name as NSString).pathExtension.lowercased() {
    case "pdf": return UTType.pdf.identifier
    case "epub": return UTType.epub.identifier
    default: return nil
    }
  }

  private func loadDocument(_ provider: NSItemProvider, type: String) async throws -> SharedDocument {
    // Stage the file while the provider's temporary URL is valid; sizes are
    // checked before anything is copied.
    let suggestedName = provider.suggestedName
    return try await withCheckedThrowingContinuation { continuation in
      _ = provider.loadFileRepresentation(forTypeIdentifier: type) { [staging] url, error in
        do {
          if let error { throw error }
          guard let url else { throw ShareError.unsupportedFile }
          continuation.resume(returning: try Self.stage(url, name: suggestedName, type: type, into: staging))
        } catch { continuation.resume(throwing: error) }
      }
    }
  }

  private func stageDocument(_ url: URL, name: String?, type: String) throws -> SharedDocument {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    return try Self.stage(url, name: name, type: type, into: staging)
  }

  /// Checks a shared file (a regular file, 1 byte to 50 MiB, whose first
  /// bytes match its type) and copies it into `staging` (a clone on APFS: no
  /// bytes pass through memory).
  private nonisolated static func stage(_ source: URL, name: String?, type: String, into staging: URL) throws -> SharedDocument {
    let values = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    // An EPUB kept as a folder package isn't one file the Mac can take.
    guard values.isRegularFile == true, let size = values.fileSize else { throw ShareError.unsupportedFile }
    guard size <= fileLimit else { throw ShareError.fileTooLarge }
    guard size > 0 else { throw ShareError.emptyFile }
    let handle = try FileHandle(forReadingFrom: source)
    let head = try handle.read(upToCount: 1024) ?? Data()
    try? handle.close()
    let isPDF = type == UTType.pdf.identifier
    let magic = isPDF ? Data("%PDF-".utf8) : Data([0x50, 0x4B, 0x03, 0x04]) // EPUB is a ZIP
    guard isPDF ? head.range(of: magic) != nil : head.starts(with: magic) else { throw ShareError.damagedFile }

    let fileName = Self.fileName(name ?? source.lastPathComponent, fallback: source.lastPathComponent, pdf: isPDF)
    try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
    let copy = staging.appendingPathComponent(UUID().uuidString)
    try FileManager.default.copyItem(at: source, to: copy)
    return SharedDocument(url: copy, name: fileName, type: isPDF ? "application/pdf" : "application/epub+zip", size: size)
  }

  /// The original file name, never a path, ending in the type's extension.
  private nonisolated static func fileName(_ name: String, fallback: String, pdf: Bool) -> String {
    let ext = pdf ? "pdf" : "epub"
    func clean(_ value: String) -> String {
      (value.split(separator: "/").last.map(String.init) ?? "")
        .replacingOccurrences(of: "\\", with: "")
        .filter { !$0.isNewline && $0.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) } }
        .trimmingCharacters(in: .whitespaces)
    }
    var base = clean(name)
    if base.isEmpty || base.hasPrefix(".") { base = clean(fallback) }
    if base.isEmpty || base.hasPrefix(".") { base = pdf ? "Document" : "Book" }
    if (base as NSString).pathExtension.lowercased() != ext { base += ".\(ext)" }
    return String(base.prefix(200))
  }

  private static func webURL(_ value: String) -> URL? {
    guard let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
          url.host != nil else { return nil }
    return url
  }

  private func loadItem(_ provider: NSItemProvider, type: String) async throws -> NSSecureCoding {
    try await withCheckedThrowingContinuation { continuation in
      provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
        if let error { continuation.resume(throwing: error) }
        else if let item { continuation.resume(returning: item) }
        else { continuation.resume(throwing: ShareError.unsupported) }
      }
    }
  }

  private func loadImage(_ provider: NSItemProvider, type: String) async throws -> Data {
    // Read while the provider's temporary URL is valid, and check size before allocating.
    try await withCheckedThrowingContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
        do {
          if let error { throw error }
          guard let url else { throw ShareError.unsupported }
          let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
          guard size <= imageLimit else { throw ShareError.imageTooLarge }
          continuation.resume(returning: try Data(contentsOf: url, options: .mappedIfSafe))
        } catch { continuation.resume(throwing: error) }
      }
    }
  }
}

private struct CaptureSheet: View {
  @ObservedObject var model: ShareModel
  @Environment(\.colorScheme) private var scheme
  private var dark: Bool { scheme == .dark }
  // Kept in step with src/theme.ts; no material beneath text, for quiet, clear contrast.
  private var background: Color { Color(white: dark ? 10 / 255 : 1) }
  private var surface: Color { Color(white: dark ? 23 / 255 : 245 / 255) }
  private var ink: Color { Color(white: dark ? 250 / 255 : 10 / 255) }
  private var muted: Color { Color(white: dark ? 163 / 255 : 115 / 255) }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Button("Cancel", action: model.cancel).foregroundStyle(muted).frame(minHeight: 44).disabled(model.saving)
        Spacer()
        Text("Kintsugi").font(.headline)
        Spacer()
        Button("Save", action: model.save).fontWeight(.semibold).frame(minHeight: 44).disabled(!model.canSave)
      }
      .padding(20)
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          if model.loading {
            ProgressView("Preparing preview…").frame(maxWidth: .infinity).padding(40)
          } else if model.canSave || model.saving {
            VStack(alignment: .leading, spacing: 12) {
              if let preview = model.preview {
                Image(uiImage: preview).resizable().scaledToFit()
                  .frame(maxWidth: .infinity, maxHeight: 240)
                  .clipShape(RoundedRectangle(cornerRadius: 10))
                  .accessibilityLabel("Shared image preview")
              }
              if let document = model.document {
                HStack(alignment: .top, spacing: 12) {
                  Image(systemName: document.isPDF ? "doc.richtext" : "book.closed")
                    .font(.system(size: 34)).foregroundStyle(muted)
                    .frame(width: 44).accessibilityHidden(true)
                  VStack(alignment: .leading, spacing: 4) {
                    Text(document.name).font(.system(.body, design: .serif)).lineLimit(3)
                    Text("\(document.isPDF ? "PDF" : "EPUB") · \(ByteCountFormatter.string(fromByteCount: Int64(document.size), countStyle: .file))")
                      .font(.caption).foregroundStyle(muted)
                  }
                }
                .accessibilityElement(children: .combine)
              }
              if model.url != nil {
                Label(model.host, systemImage: "link").font(.subheadline.weight(.medium))
                Text(model.url ?? "").font(.caption).foregroundStyle(muted).lineLimit(3)
              }
              if !model.text.isEmpty {
                Text(model.text).font(.system(.body, design: .serif)).lineLimit(8)
              }
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(surface, in: RoundedRectangle(cornerRadius: 14))

            VStack(alignment: .leading, spacing: 8) {
              Text("A note, if you like").font(.subheadline).foregroundStyle(muted)
              TextField("What caught your attention?", text: $model.note, axis: .vertical)
                .font(.system(.body, design: .serif)).lineLimit(3...6)
                .padding(14).background(surface, in: RoundedRectangle(cornerRadius: 12))
                .disabled(model.saving)
            }
            Text(model.document == nil
                 ? "Saved on this iPhone first. Sent when your Mac is back."
                 : "Saved on this iPhone first. Kintsugi sends it to your Mac the next time you open the app.")
              .font(.footnote).foregroundStyle(muted)
          }
          if let error = model.error {
            Text(error).font(.callout).foregroundStyle(dark ? Color(red: 248 / 255, green: 113 / 255, blue: 113 / 255) : .red)
              .accessibilityAddTraits(.updatesFrequently)
          }
        }
        .padding(.horizontal, 20).padding(.bottom, 24)
      }
      .scrollDismissesKeyboard(.interactively)
    }
    .foregroundStyle(ink).tint(ink).background(background)
  }
}
