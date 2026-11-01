import Foundation

/// Errors from the capture queue, its delivery and the shared pairing.
public enum CaptureError: Error, LocalizedError, Equatable {
  case noAppGroup
  case invalidPayload
  case tooLarge
  case invalidID
  case notFound
  case malformed
  case busy
  case unpaired
  case invalidPairing
  case needsApp
  case io(String)

  public var errorDescription: String? {
    switch self {
    case .noAppGroup: return "The capture App Group isn't available."
    case .invalidPayload: return "A capture must be a JSON object with a capturedAt string and, if it has an id, a UUID."
    case .tooLarge: return "That capture is too large to send to the Mac."
    case .invalidID: return "That isn't a capture id."
    case .notFound: return "That capture isn't queued any more."
    case .malformed: return "That capture is damaged and was set aside."
    case .busy: return "That capture is already being delivered."
    case .unpaired: return "This phone isn't paired with a Mac."
    case .invalidPairing: return "The pairing must be a JSON object with url and token strings."
    case .needsApp: return "Kintsugi sends files itself, once it knows your Mac can take them."
    case .io(let message): return message
    }
  }
}

/// Captures waiting for the Mac, shared by the app and the share extension
/// through the App Group container. Each capture is its own directory,
/// committed by one atomic rename, so a crash never leaves half a capture and
/// no write rewrites another capture:
///
///     <root>/.lock                         flock(2) guarding leases and removals
///     <root>/captures/<id>/payload.json    the POST /v1/clips body, verbatim
///     <root>/captures/<id>/meta.json       {"capturedAt": …, "captureId": …, "file": true?}, for cheap listing
///     <root>/captures/<id>/rejection       why the Mac refused it, if it did
///     <root>/captures/<id>/lease           "<expiry epoch s>\n<owner>" while claimed
///     <root>/captures/.tmp-* / .trash-*    in-flight writes and removals
///     <root>/malformed/<id>/               damaged captures, kept, never sent
///
/// Ids sort oldest first. They name queue directories only: the capture's own
/// identity is the UUID `id` field inside payload.json (KI-10), which the Mac
/// deduplicates on. Every payload is committed carrying one, so every delivery
/// attempt, from any process, sends the same id; meta.json's `captureId`
/// records that the payload has been checked. Captures queued before ids
/// existed get theirs once, under the lock, the first time they are claimed or
/// read (before any upload), and keep it from then on.
///
/// A sender claims a capture (a 120 s lease), reads it,
/// sends it, then acknowledges (removes) or releases it. A lease left by a
/// process that died simply expires. A lease has an owner, and release only
/// drops the caller's own lease, so a late failure can't free a capture that
/// another sender has since claimed.
///
/// Everything is created `completeUntilFirstUserAuthentication` (new files
/// inherit their directory's class), so background deliveries can read it
/// while the phone is locked.
public final class CaptureStore: @unchecked Sendable {
  public static let appGroup = "group.dev.phalasiya.kintsugi.capture"
  public static let leaseDuration: TimeInterval = 120
  /// A 15 MiB image as base64 (20 MiB) plus text, as `POST /v1/clips` accepts.
  public static let maxPayloadBytes = 22 * 1024 * 1024
  /// A PDF or EPUB, as `POST /v1/clips` accepts from API 4 (`MAX_CLIP_FILE_BYTES` in core).
  public static let maxFileBytes = 50 * 1024 * 1024
  /// A payload carrying a file: 50 MiB as base64 (66.7 MiB) plus its other
  /// fields, within the Mac's clip body limit.
  public static let maxFilePayloadBytes = 70 * 1024 * 1024
  /// Bytes of a file encoded at a time (a multiple of 3, so chunks
  /// concatenate into one base64 string without padding between them).
  static let fileChunkBytes = 3 * 64 * 1024
  /// Owner of the leases this process takes through `claim`.
  static let processOwner = UUID().uuidString
  static var protection: [FileAttributeKey: Any] {
    [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
  }

  let root: URL?
  let now: () -> Date

  /// The store in the App Group container. Methods throw `noAppGroup` when the
  /// process lacks the App Group entitlement.
  public convenience init() {
    let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup)
    self.init(directory: container?.appendingPathComponent("Captures", isDirectory: true))
  }

  public init(directory: URL?, now: @escaping () -> Date = Date.init) {
    root = directory
    self.now = now
  }

  // MARK: - Queue

  /// Durably queues one capture and returns its queue id, after checking that
  /// it is a JSON object with a `capturedAt` string. A valid UUID `id` is kept
  /// (and the bytes with it); a missing or null one is generated here, once.
  /// Any other `id` is refused as `invalidPayload`.
  /// A payload with a `file` field may be up to `maxFilePayloadBytes`, and is
  /// listed with `file: true` (see `pending`).
  public func enqueue(_ payloadJSON: String) throws -> String {
    let payload = Data(payloadJSON.utf8)
    guard payload.count <= Self.maxFilePayloadBytes else { throw CaptureError.tooLarge }
    guard let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
          let capturedAt = object["capturedAt"] as? String
    else { throw CaptureError.invalidPayload }
    return try enqueue(payload, capturedAt: capturedAt, file: object["file"] != nil)
  }

  /// Durably queues a payload the caller built itself (trusted: it is not
  /// parsed as a whole again), whose `capturedAt` field is `capturedAt`. Its
  /// top-level keys are scanned in place for `id` and `capturedAt`, without
  /// copying the payload: a valid UUID `id` is kept byte for byte, a missing
  /// or null one is generated once and written into the payload as it is
  /// committed, and anything else (a non-UUID `id`, a repeated `id`, a
  /// different or missing `capturedAt`) throws `invalidPayload`.
  /// `file` says the payload carries a `file` field: it may then be up to
  /// `maxFilePayloadBytes`, and is listed as such.
  public func enqueue(_ payload: Data, capturedAt: String, file: Bool = false) throws -> String {
    let limit = file ? Self.maxFilePayloadBytes : Self.maxPayloadBytes
    guard payload.count <= limit else { throw CaptureError.tooLarge }
    guard let fields = CapturePayload.scan(payload), fields.capturedAt == capturedAt,
          let identified = CapturePayload.identified(payload, fields)
    else { throw CaptureError.invalidPayload }
    // The bound holds for what is committed, a generated id included.
    guard identified.segments.reduce(0, { $0 + $1.count }) <= limit else { throw CaptureError.tooLarge }
    let meta = try Self.meta(capturedAt: capturedAt, captureID: identified.captureID, file: file)
    return try commit(meta: meta) { url in
      try Self.write(identified.segments, to: url, durable: true)
    }
  }

  /// Durably queues a capture carrying a file (a PDF or EPUB of at most
  /// `maxFileBytes`) and returns its queue id. The file is base64-encoded
  /// straight into payload.json a chunk at a time, so neither its bytes nor
  /// their encoding is ever whole in memory: a 50 MiB file stays well inside
  /// the share extension's memory limit. `fields` are the payload's other
  /// top-level fields and must carry a `capturedAt` string and no `file`; a
  /// UUID `id` is kept, a missing or null one is generated here, and any
  /// other `id` throws `invalidPayload`. The file goes in as `file`.
  public func enqueue(fields: [String: Any], file: URL) throws -> String {
    var fields = fields
    guard let capturedAt = fields["capturedAt"] as? String, fields["file"] == nil,
          JSONSerialization.isValidJSONObject(fields)
    else { throw CaptureError.invalidPayload }
    let captureID: String
    switch fields["id"] {
    case nil, is NSNull:
      captureID = CapturePayload.newUUID()
      fields["id"] = captureID
    case let value as String where CapturePayload.isUUID(value):
      captureID = value
    default:
      throw CaptureError.invalidPayload
    }
    let values = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    guard values.isRegularFile == true, let size = values.fileSize else { throw CaptureError.invalidPayload }
    guard size <= Self.maxFileBytes else { throw CaptureError.tooLarge }
    var head = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    guard head.last == UInt8(ascii: "}") else { throw CaptureError.invalidPayload }
    head.removeLast()
    head.append(Data(#","file":""#.utf8))
    let tail = Data(#""}"#.utf8)
    guard head.count + (size + 2) / 3 * 4 + tail.count <= Self.maxFilePayloadBytes else { throw CaptureError.tooLarge }
    let meta = try Self.meta(capturedAt: capturedAt, captureID: captureID, file: true)
    let reader = try FileHandle(forReadingFrom: file)
    defer { try? reader.close() }
    return try commit(meta: meta) { url in
      try Self.write(to: url, durable: true) { fd in
        try Self.writeAll(fd, head)
        var carry = Data() // bytes past the last multiple of 3, encoded with the next chunk
        var total = 0
        while true {
          let more = try autoreleasepool { () throws -> Bool in
            guard let chunk = try reader.read(upToCount: Self.fileChunkBytes), !chunk.isEmpty else { return false }
            total += chunk.count
            // The file changed under us: refuse rather than exceed the bound.
            guard total <= Self.maxFileBytes else { throw CaptureError.tooLarge }
            let bytes = carry.isEmpty ? chunk : carry + chunk
            let whole = bytes.count / 3 * 3
            try Self.writeAll(fd, bytes.prefix(whole).base64EncodedData())
            carry = Data(bytes.suffix(from: bytes.startIndex + whole))
            return true
          }
          if !more { break }
        }
        if !carry.isEmpty { try Self.writeAll(fd, carry.base64EncodedData()) }
        try Self.writeAll(fd, tail)
      }
    }
  }

  /// Whether a capture carries a file (its meta.json says so). Files are
  /// delivered by the app, which checks the Mac's API version first.
  public func carriesFile(_ id: String) throws -> Bool {
    let dir = try captureDirectory(id)
    guard let meta = try? Data(contentsOf: dir.appendingPathComponent("meta.json")),
          let object = try? JSONSerialization.jsonObject(with: meta) as? [String: Any]
    else { return false }
    return object["file"] as? Bool == true
  }

  /// Commits a new capture directory: its payload (written by `payload` to
  /// the URL given) and `meta`, made visible by one atomic rename.
  private func commit(meta: Data, payload: (URL) throws -> Void) throws -> String {
    let captures = try capturesDirectory()
    let id = Self.newID(now())
    let tmp = captures.appendingPathComponent(".tmp-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: false, attributes: Self.protection)
    do {
      try payload(tmp.appendingPathComponent("payload.json"))
      try Self.write(meta, to: tmp.appendingPathComponent("meta.json"), durable: true)
      try Self.syncDirectory(tmp)
      try Self.rename(tmp, captures.appendingPathComponent(id, isDirectory: true))
      try Self.syncDirectory(captures)
    } catch {
      try? FileManager.default.removeItem(at: tmp)
      throw error
    }
    return id
  }

  /// Every queued capture, oldest first, leased or not, as a JSON array of
  /// `{id, capturedAt, error?, file?}` (`file: true` when it carries a PDF or
  /// EPUB). Payloads stay on disk; `read` loads one.
  public func pending() throws -> String {
    let captures = try capturesDirectory()
    sweep(captures)
    var items: [[String: Any]] = []
    for id in try Self.list(captures).filter(Self.isID).sorted() {
      let dir = captures.appendingPathComponent(id, isDirectory: true)
      guard let meta = try? Data(contentsOf: dir.appendingPathComponent("meta.json")) else {
        // Removed meanwhile, or unreadable for now (data protection): skip.
        continue
      }
      guard let object = try? JSONSerialization.jsonObject(with: meta) as? [String: Any],
            let capturedAt = object["capturedAt"] as? String
      else {
        try? quarantine(id)
        continue
      }
      var item: [String: Any] = ["id": id, "capturedAt": capturedAt]
      if object["file"] as? Bool == true { item["file"] = true }
      if let rejection = try? String(contentsOf: dir.appendingPathComponent("rejection"), encoding: .utf8) {
        item["error"] = rejection
      }
      items.append(item)
    }
    let data = try JSONSerialization.data(withJSONObject: items)
    return String(decoding: data, as: UTF8.self)
  }

  /// One capture's payload JSON, exactly as queued (a capture queued before
  /// ids existed gets its `id` first, as `claim` does).
  public func read(_ id: String) throws -> String {
    let dir = try captureDirectory(id)
    let ready: Bool = try withLock {
      guard Self.exists(dir) else { throw CaptureError.notFound }
      switch try identifyLocked(id, dir: dir) {
      case .identified, .invalid: return true // an invalid one is kept rejected, still readable
      case .damaged: return false
      }
    }
    guard ready else { throw CaptureError.malformed }
    let url = dir.appendingPathComponent("payload.json")
    let data: Data
    do {
      data = try Data(contentsOf: url)
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
      throw CaptureError.notFound
    }
    guard (try? JSONSerialization.jsonObject(with: data)) is [String: Any],
          let json = String(data: data, encoding: .utf8)
    else {
      try quarantine(id)
      throw CaptureError.malformed
    }
    return json
  }

  /// The capture's UUID `id` (the one every delivery sends), giving a capture
  /// queued before ids existed its own first. Nil for a capture kept rejected
  /// because its `id` isn't a UUID; throws `malformed` for a damaged one.
  public func captureID(_ id: String) throws -> String? {
    let dir = try captureDirectory(id)
    let result = try withLock { () throws -> Identification in
      guard Self.exists(dir) else { throw CaptureError.notFound }
      return try identifyLocked(id, dir: dir)
    }
    switch result {
    case .identified(let captureID): return captureID
    case .invalid: return nil
    case .damaged: throw CaptureError.malformed
    }
  }

  /// Leases a capture to this process for `leaseDuration`. False when it is
  /// gone, rejected, damaged (set aside) or holds a live lease (this
  /// process's included). Before leasing, a capture queued before ids existed
  /// is given its persisted `id`, so whatever the claimer then reads or
  /// uploads from payload.json already carries it.
  public func claim(_ id: String) throws -> Bool {
    try claim(id, owner: Self.processOwner)
  }

  func claim(_ id: String, owner: String) throws -> Bool {
    let dir = try captureDirectory(id)
    return try withLock {
      guard Self.exists(dir), !Self.exists(dir.appendingPathComponent("rejection")) else { return false }
      let lease = dir.appendingPathComponent("lease")
      if liveLease(lease) != nil { return false }
      guard case .identified = try identifyLocked(id, dir: dir) else { return false }
      let text = "\(now().timeIntervalSince1970 + Self.leaseDuration)\n\(owner)"
      try Self.write(Data(text.utf8), to: lease, durable: false)
      return true
    }
  }

  /// Removes a delivered capture. Idempotent.
  public func acknowledge(_ id: String) throws {
    let dir = try captureDirectory(id)
    let trash = dir.deletingLastPathComponent()
      .appendingPathComponent(".trash-\(UUID().uuidString)", isDirectory: true)
    let moved: Bool = try withLock {
      guard Self.exists(dir) else { return false }
      try Self.rename(dir, trash)
      return true
    }
    if moved { try? FileManager.default.removeItem(at: trash) }
  }

  /// Preserves a rejected capture in place, visible in pending(), but excludes
  /// it from automatic claims. Never delete bytes because the server rejected them.
  public func reject(_ id: String, reason: String) throws {
    let dir = try captureDirectory(id)
    try withLock {
      guard Self.exists(dir) else { return }
      try Self.write(Data(reason.prefix(512).utf8), to: dir.appendingPathComponent("rejection"), durable: true)
      try Self.syncDirectory(dir)
    }
  }

  /// Gives up this process's lease so the capture can be sent again. Leaves
  /// another owner's lease alone. Idempotent.
  public func release(_ id: String) throws {
    try release(id, owner: Self.processOwner)
  }

  func release(_ id: String, owner: String) throws {
    let lease = try captureDirectory(id).appendingPathComponent("lease")
    try withLock {
      guard liveLease(lease) == owner else { return }
      if unlink(lease.path) != 0 && errno != ENOENT { throw Self.posixError("unlink") }
    }
  }

  /// Where a capture's payload lives, for a background upload from file.
  public func payloadURL(_ id: String) throws -> URL {
    try captureDirectory(id).appendingPathComponent("payload.json")
  }

  /// Local time as `2026-10-29T09:14`, as captures record it.
  public static func localStamp(_ date: Date = Date()) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.timeZone = .current
    formatter.dateFormat = "yyyy-MM-dd'T'HH:mm"
    return formatter.string(from: date)
  }

  // MARK: - Internals

  /// The owner of the unexpired lease in `file`, if any. A lease dated beyond
  /// a full term ahead (the clock was set back) counts as expired.
  func liveLease(_ file: URL) -> String? {
    guard let text = try? String(contentsOf: file, encoding: .utf8) else { return nil }
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
    let now = self.now().timeIntervalSince1970
    guard lines.count == 2, let expires = TimeInterval(lines[0]),
          expires > now, expires <= now + Self.leaseDuration + 1
    else { return nil }
    return String(lines[1])
  }

  /// Moves a damaged capture aside, keeping it for inspection.
  func quarantine(_ id: String) throws {
    let dir = try captureDirectory(id)
    try withLock { try quarantineLocked(id, dir: dir) }
  }

  /// `quarantine`, for a caller already holding the lock (flock(2) on a fresh
  /// descriptor would wait for itself).
  func quarantineLocked(_ id: String, dir: URL) throws {
    guard Self.exists(dir) else { return }
    let malformed = try rootDirectory().appendingPathComponent("malformed", isDirectory: true)
    try FileManager.default.createDirectory(at: malformed, withIntermediateDirectories: true, attributes: Self.protection)
    var target = malformed.appendingPathComponent(id, isDirectory: true)
    if Self.exists(target) {
      target = malformed.appendingPathComponent("\(id)-\(UUID().uuidString)", isDirectory: true)
    }
    try Self.rename(dir, target)
  }

  enum Identification: Equatable {
    /// payload.json carries this UUID `id`, and meta.json records it.
    case identified(String)
    /// payload.json's `id` isn't a UUID: kept, and marked rejected.
    case invalid
    /// Damaged, and now set aside in malformed/.
    case damaged
  }

  /// Makes sure the committed capture in `dir` carries a persisted UUID `id`.
  /// Must hold the lock. Cheap when meta.json already records it (every
  /// capture queued with ids does). Otherwise, once per legacy capture: scans
  /// payload.json (memory-mapped, not copied), atomically rewrites it with a
  /// new `id` first if it has none (an existing valid one is kept), then
  /// records it in meta.json. A crash between the two writes is repaired by
  /// the next call finding the `id` in the payload, so the UUID never changes.
  func identifyLocked(_ id: String, dir: URL) throws -> Identification {
    let metaURL = dir.appendingPathComponent("meta.json")
    let payloadURL = dir.appendingPathComponent("payload.json")
    let meta: Data
    do {
      meta = try Data(contentsOf: metaURL)
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
      try quarantineLocked(id, dir: dir)
      return .damaged
    } catch {
      throw CaptureError.io("read meta: \(error.localizedDescription)")
    }
    guard let object = try? JSONSerialization.jsonObject(with: meta) as? [String: Any],
          let capturedAt = object["capturedAt"] as? String
    else {
      try quarantineLocked(id, dir: dir)
      return .damaged
    }
    if let recorded = object["captureId"] as? String, CapturePayload.isUUID(recorded) {
      return .identified(recorded)
    }

    let payload: Data
    do {
      payload = try Data(contentsOf: payloadURL, options: .alwaysMapped)
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
      try quarantineLocked(id, dir: dir)
      return .damaged
    } catch {
      throw CaptureError.io("read payload: \(error.localizedDescription)")
    }
    guard let fields = CapturePayload.scan(payload) else {
      try quarantineLocked(id, dir: dir)
      return .damaged
    }
    guard let identified = CapturePayload.identified(payload, fields) else {
      let rejection = dir.appendingPathComponent("rejection")
      if !Self.exists(rejection) {
        try Self.write(Data("This capture's id isn't a UUID, so it can't be sent. Its contents are preserved on this iPhone.".utf8), to: rejection, durable: true)
        try Self.syncDirectory(dir)
      }
      return .invalid
    }
    if identified.inserted {
      try Self.write(identified.segments, to: payloadURL, durable: true)
      // Commit the payload rename before its metadata can claim it is identified.
      try Self.syncDirectory(dir)
    }
    let file = object["file"] as? Bool == true
    try Self.write(Self.meta(capturedAt: capturedAt, captureID: identified.captureID, file: file), to: metaURL, durable: true)
    try Self.syncDirectory(dir)
    return .identified(identified.captureID)
  }

  static func meta(capturedAt: String, captureID: String, file: Bool = false) throws -> Data {
    var meta: [String: Any] = ["capturedAt": capturedAt, "captureId": captureID]
    if file { meta["file"] = true }
    return try JSONSerialization.data(withJSONObject: meta, options: [.sortedKeys])
  }

  /// Removes what crashed processes left: removals always, writes once stale.
  func sweep(_ captures: URL) {
    let staleBefore = now().addingTimeInterval(-3600)
    for name in (try? Self.list(captures)) ?? [] {
      let url = captures.appendingPathComponent(name)
      if name.hasPrefix(".trash-") {
        try? FileManager.default.removeItem(at: url)
      } else if name.hasPrefix(".tmp-"),
                let modified = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
                modified < staleBefore {
        try? FileManager.default.removeItem(at: url)
      }
    }
  }

  /// Runs `body` holding an exclusive flock(2) on `<root>/.lock`. The lock
  /// belongs to this open file description, so it excludes other threads and
  /// other processes alike, and the kernel drops it if the process dies.
  func withLock<T>(_ body: () throws -> T) throws -> T {
    let path = try rootDirectory().appendingPathComponent(".lock").path
    let fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw Self.posixError("open lock") }
    defer { close(fd) }
    while flock(fd, LOCK_EX) != 0 {
      if errno != EINTR { throw Self.posixError("flock") }
    }
    defer { flock(fd, LOCK_UN) }
    return try body()
  }

  func rootDirectory() throws -> URL {
    guard let root else { throw CaptureError.noAppGroup }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: Self.protection)
    return root
  }

  func capturesDirectory() throws -> URL {
    let captures = try rootDirectory().appendingPathComponent("captures", isDirectory: true)
    try FileManager.default.createDirectory(at: captures, withIntermediateDirectories: true, attributes: Self.protection)
    return captures
  }

  func captureDirectory(_ id: String) throws -> URL {
    guard Self.isID(id) else { throw CaptureError.invalidID }
    return try capturesDirectory().appendingPathComponent(id, isDirectory: true)
  }

  /// Milliseconds since 1970, zero-padded so ids sort by time, plus a random tail.
  static func newID(_ date: Date) -> String {
    let ms = UInt64(max(0, date.timeIntervalSince1970 * 1000))
    let tail = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
    return String(format: "%013llu", ms) + "-" + tail
  }

  static func isID(_ id: String) -> Bool {
    !id.isEmpty && id.count <= 64 && !id.hasPrefix(".")
      && id.unicodeScalars.allSatisfy { ($0.isASCII && CharacterSet.alphanumerics.contains($0)) || $0 == "-" }
  }

  static func list(_ dir: URL) throws -> [String] {
    try FileManager.default.contentsOfDirectory(atPath: dir.path)
  }

  static func exists(_ url: URL) -> Bool {
    FileManager.default.fileExists(atPath: url.path)
  }

  /// Writes `data` to a temporary sibling, flushes it, then renames it over
  /// `url`, so readers see the old file or the whole new one.
  static func write(_ data: Data, to url: URL, durable: Bool) throws {
    try write([data], to: url, durable: durable)
  }

  /// `write` for a file made of consecutive `segments` (slices share their
  /// payload's storage, so splicing an `id` in copies nothing large).
  static func write(_ segments: [Data], to url: URL, durable: Bool) throws {
    try write(to: url, durable: durable) { fd in
      for data in segments { try writeAll(fd, data) }
    }
  }

  /// `write` for a file whose bytes `body` writes to the descriptor it is given.
  static func write(to url: URL, durable: Bool, _ body: (Int32) throws -> Void) throws {
    let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent)-\(UUID().uuidString)")
    let fd = open(tmp.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw posixError("open") }
    var committed = false
    defer { if !committed { unlink(tmp.path) } }
    do {
      defer { close(fd) }
      try body(fd)
      // fsync(2) on Darwin may leave data in the drive cache; F_FULLFSYNC doesn't.
      if durable && fcntl(fd, F_FULLFSYNC) != 0 && fsync(fd) != 0 { throw posixError("fsync") }
    }
    try rename(tmp, url)
    committed = true
  }

  static func writeAll(_ fd: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
      guard let base = buffer.baseAddress else { return }
      var offset = 0
      while offset < buffer.count {
        let written = Darwin.write(fd, base + offset, buffer.count - offset)
        if written < 0 {
          if errno == EINTR { continue }
          throw posixError("write")
        }
        offset += written
      }
    }
  }

  static func rename(_ from: URL, _ to: URL) throws {
    if Darwin.rename(from.path, to.path) != 0 { throw posixError("rename") }
  }

  static func syncDirectory(_ dir: URL) throws {
    let fd = open(dir.path, O_RDONLY | O_CLOEXEC)
    guard fd >= 0 else { throw posixError("open directory") }
    defer { close(fd) }
    if fsync(fd) != 0 { throw posixError("fsync directory") }
  }

  static func posixError(_ operation: String) -> CaptureError {
    .io("\(operation): \(String(cString: strerror(errno)))")
  }
}

/// The capture `id` inside a payload, found and added without parsing (or
/// copying) the payload as a whole: a payload can carry a 20 MiB base64 image,
/// and the share extension has little memory to spare. Only the top-level
/// object's keys are read; values are skipped over (strings with memchr), and
/// only short `id` and `capturedAt` values are decoded.
enum CapturePayload {
  /// The top-level keys of interest, by byte offset from the payload's start.
  struct Fields {
    /// Just past the object's opening brace.
    var open: Int
    var isEmpty: Bool
    /// The raw (undecoded) values of every top-level `id` key.
    var ids: [Range<Int>]
    /// `capturedAt`, when it occurs once as a string.
    var capturedAt: String?
  }

  /// A payload with its UUID `id`, as the slices to write in order.
  struct Identified {
    var captureID: String
    var segments: [Data]
    /// Whether `segments` differ from the payload as given.
    var inserted: Bool
  }

  /// The contract's form: hyphenated 8-4-4-4-12 hexadecimal, either case.
  static func isUUID(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard bytes.count == 36 else { return false }
    for (index, byte) in bytes.enumerated() {
      if [8, 13, 18, 23].contains(index) {
        if byte != UInt8(ascii: "-") { return false }
      } else if !(byte >= 0x30 && byte <= 0x39) && !(byte >= 0x41 && byte <= 0x46) && !(byte >= 0x61 && byte <= 0x66) {
        return false
      }
    }
    return true
  }

  static func newUUID() -> String { UUID().uuidString.lowercased() }

  /// The payload's single UUID `id`: kept as is when valid, generated (and
  /// spliced in) when missing or null. Nil for a repeated or non-UUID `id`.
  static func identified(_ payload: Data, _ fields: Fields, newID: () -> String = newUUID) -> Identified? {
    let start = payload.startIndex
    if fields.ids.count > 1 { return nil }
    if let raw = fields.ids.first {
      let value = payload[(start + raw.lowerBound)..<(start + raw.upperBound)]
      if value.elementsEqual("null".utf8) {
        let captureID = newID()
        return Identified(captureID: captureID, segments: [
          payload[start..<(start + raw.lowerBound)],
          Data("\"\(captureID)\"".utf8),
          payload[(start + raw.upperBound)...],
        ], inserted: true)
      }
      guard let captureID = decodeString(value), isUUID(captureID) else { return nil }
      return Identified(captureID: captureID, segments: [payload], inserted: false)
    }
    let captureID = newID()
    return Identified(captureID: captureID, segments: [
      payload[start..<(start + fields.open)],
      Data("\"id\":\"\(captureID)\"\(fields.isEmpty ? "" : ",")".utf8),
      payload[(start + fields.open)...],
    ], inserted: true)
  }

  /// A short JSON string literal's value; nil for anything else.
  static func decodeString(_ literal: Data) -> String? {
    guard literal.count >= 2, literal.count <= 256, literal.first == UInt8(ascii: "\"") else { return nil }
    return (try? JSONSerialization.jsonObject(with: Data(literal), options: .fragmentsAllowed)) as? String
  }

  /// The top-level object's `id` and `capturedAt` keys. Nil unless the payload
  /// is one JSON object (an optional UTF-8 BOM and whitespace aside). Values
  /// are skipped, not validated: callers either validated the JSON already or
  /// built it themselves.
  static func scan(_ payload: Data) -> Fields? {
    payload.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> Fields? in
      guard let base = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return nil }
      let count = buffer.count
      var i = 0

      func skipSpace() {
        while i < count, [0x20, 0x09, 0x0A, 0x0D].contains(base[i]) { i += 1 }
      }
      /// Past the string literal opening at `from`.
      func stringEnd(_ from: Int) -> Int? {
        var j = from + 1
        while j < count {
          guard let found = memchr(base + j, 0x22, count - j) else { return nil }
          let quote = UnsafeRawPointer(base).distance(to: UnsafeRawPointer(found))
          var slashes = 0
          while quote - slashes - 1 > from && base[quote - slashes - 1] == 0x5C { slashes += 1 }
          if slashes % 2 == 0 { return quote + 1 }
          j = quote + 1
        }
        return nil
      }
      /// Past the value starting at `from`.
      func valueEnd(_ from: Int) -> Int? {
        guard from < count else { return nil }
        switch base[from] {
        case 0x22:
          return stringEnd(from)
        case 0x7B, 0x5B:
          var depth = 0
          var j = from
          while j < count {
            switch base[j] {
            case 0x22:
              guard let end = stringEnd(j) else { return nil }
              j = end
              continue
            case 0x7B, 0x5B: depth += 1
            case 0x7D, 0x5D:
              depth -= 1
              if depth == 0 { return j + 1 }
            default: break
            }
            j += 1
          }
          return nil
        default:
          var j = from
          while j < count, ![0x20, 0x09, 0x0A, 0x0D, 0x2C, 0x7D, 0x5D].contains(base[j]) { j += 1 }
          return j > from ? j : nil
        }
      }
      func bytes(_ range: Range<Int>) -> Data { Data(bytes: base + range.lowerBound, count: range.count) }
      /// A key literal's value, when it could be one we look for.
      func key(_ range: Range<Int>) -> String? {
        let inner = (range.lowerBound + 1)..<(range.upperBound - 1)
        if !inner.contains(where: { base[$0] == 0x5C }) {
          return inner.count <= 16 ? String(decoding: bytes(inner), as: UTF8.self) : nil
        }
        return range.count <= 128 ? decodeString(bytes(range)) : nil
      }

      if count >= 3 && base[0] == 0xEF && base[1] == 0xBB && base[2] == 0xBF { i = 3 }
      skipSpace()
      guard i < count, base[i] == 0x7B else { return nil }
      i += 1
      var fields = Fields(open: i, isEmpty: true, ids: [], capturedAt: nil)
      var capturedAts: [Range<Int>] = []
      skipSpace()
      if i < count, base[i] == 0x7D {
        i += 1
      } else {
        fields.isEmpty = false
        while true {
          guard i < count, base[i] == 0x22, let keyEnd = stringEnd(i) else { return nil }
          let name = key(i..<keyEnd)
          i = keyEnd
          skipSpace()
          guard i < count, base[i] == 0x3A else { return nil }
          i += 1
          skipSpace()
          guard let end = valueEnd(i) else { return nil }
          if name == "id" { fields.ids.append(i..<end) }
          if name == "capturedAt" { capturedAts.append(i..<end) }
          i = end
          skipSpace()
          guard i < count else { return nil }
          if base[i] == 0x7D { i += 1; break }
          guard base[i] == 0x2C else { return nil }
          i += 1
          skipSpace()
        }
      }
      skipSpace()
      guard i == count else { return nil }
      if capturedAts.count == 1 { fields.capturedAt = decodeString(bytes(capturedAts[0])) }
      return fields
    }
  }
}
