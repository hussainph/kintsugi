import SwiftUI
import UIKit
import UniformTypeIdentifiers
import ImageIO

private let imageLimit = 15 * 1024 * 1024

private enum ShareError: LocalizedError {
  case unsupported, imageTooLarge, unsupportedImage
  var errorDescription: String? {
    switch self {
    case .unsupported: return "Share a link, some text, or one image."
    case .imageTooLarge: return "This image is over 15 MB. Share a smaller image or a link instead."
    case .unsupportedImage: return "Share a JPEG, PNG, GIF, WebP, HEIC, HEIF or AVIF image instead."
    }
  }
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
  private var image: Data?
  private var imageType: String?
  private let context: NSExtensionContext?

  init(context: NSExtensionContext?) { self.context = context }
  var canSave: Bool { !loading && !saving && (url != nil || !text.isEmpty || image != nil) }
  var host: String { url.flatMap(URL.init(string:))?.host ?? "Shared inspiration" }

  func load() async {
    defer { loading = false }
    do {
      let items = context?.inputItems as? [NSExtensionItem] ?? []
      var passages = [String]()
      for item in items {
        let providers = item.attachments ?? []
        // attributedContentText is a fallback; many hosts repeat it in a text provider.
        if let content = item.attributedContentText?.string, !content.isEmpty { passages.append(content) }
        for provider in providers {
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
          }
        }
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
      if url == nil && text.isEmpty && image == nil { throw ShareError.unsupported }
    } catch {
      // Never enable Save for a partially loaded share; do not silently lose its image/text.
      url = nil; text = ""; image = nil; preview = nil
      self.error = error.localizedDescription
    }
  }

  func save() {
    guard canSave else { return }
    saving = true
    error = nil
    let capturedAt = CaptureStore.localStamp()
    let sharedURL = url, sharedText = text, sharedImage = image, mimeType = imageType
    let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
    Task {
      do {
        // Encode once, off the main thread. Avoid a 20 MB JSON String roundtrip
        // and a second full parse when sharing an image near the 15 MB limit.
        let id = try await Task.detached {
          var payload: [String: Any] = ["capturedAt": capturedAt, "via": "share"]
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
        try? CaptureDelivery.shared.start(id: id)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        context?.completeRequest(returningItems: nil)
      } catch {
        saving = false
        self.error = "Couldn’t save on this iPhone. \(error.localizedDescription) Try again."
      }
    }
  }

  func cancel() { context?.completeRequest(returningItems: nil) }

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
            Text("Saved on this iPhone first. Sent when your Mac is back.")
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
