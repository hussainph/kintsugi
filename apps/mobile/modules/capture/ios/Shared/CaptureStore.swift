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
  case io(String)

  public var errorDescription: String? {
    switch self {
    case .noAppGroup: return "The capture App Group isn't available."
    case .invalidPayload: return "A capture must be a JSON object with a capturedAt string."
    case .tooLarge: return "That capture is too large to send to the Mac."
    case .invalidID: return "That isn't a capture id."
    case .notFound: return "That capture isn't queued any more."
    case .malformed: return "That capture is damaged and was set aside."
    case .busy: return "That capture is already being delivered."
    case .unpaired: return "This phone isn't paired with a Mac."
    case .invalidPairing: return "The pairing must be a JSON object with url and token strings."
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
///     <root>/captures/<id>/meta.json       {"capturedAt": …}, for cheap listing
///     <root>/captures/<id>/lease           "<expiry epoch s>\n<owner>" while claimed
///     <root>/captures/.tmp-* / .trash-*    in-flight writes and removals
///     <root>/malformed/<id>/               damaged captures, kept, never sent
///
/// Ids sort oldest first. A sender claims a capture (a 120 s lease), reads it,
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

  /// Durably queues one capture and returns its id, after checking that it
  /// is a JSON object with a `capturedAt` string.
  public func enqueue(_ payloadJSON: String) throws -> String {
    let payload = Data(payloadJSON.utf8)
    guard payload.count <= Self.maxPayloadBytes else { throw CaptureError.tooLarge }
    guard let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
          let capturedAt = object["capturedAt"] as? String
    else { throw CaptureError.invalidPayload }
    return try enqueue(payload, capturedAt: capturedAt)
  }

  /// Durably queues a payload the caller built itself (trusted: the JSON is
  /// not parsed again), whose `capturedAt` field is `capturedAt`.
  public func enqueue(_ payload: Data, capturedAt: String) throws -> String {
    guard payload.count <= Self.maxPayloadBytes else { throw CaptureError.tooLarge }
    let meta = try JSONSerialization.data(withJSONObject: ["capturedAt": capturedAt])

    let captures = try capturesDirectory()
    let id = Self.newID(now())
    let tmp = captures.appendingPathComponent(".tmp-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: false, attributes: Self.protection)
    do {
      try Self.write(payload, to: tmp.appendingPathComponent("payload.json"), durable: true)
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
  /// `{id, capturedAt}`. Payloads stay on disk; `read` loads one.
  public func pending() throws -> String {
    let captures = try capturesDirectory()
    sweep(captures)
    var items: [[String: String]] = []
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
      var item = ["id": id, "capturedAt": capturedAt]
      if let rejection = try? String(contentsOf: dir.appendingPathComponent("rejection"), encoding: .utf8) {
        item["error"] = rejection
      }
      items.append(item)
    }
    let data = try JSONSerialization.data(withJSONObject: items)
    return String(decoding: data, as: UTF8.self)
  }

  /// One capture's payload JSON, exactly as queued.
  public func read(_ id: String) throws -> String {
    let url = try payloadURL(id)
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

  /// Leases a capture to this process for `leaseDuration`. False when it is
  /// gone or holds a live lease (this process's included).
  public func claim(_ id: String) throws -> Bool {
    try claim(id, owner: Self.processOwner)
  }

  func claim(_ id: String, owner: String) throws -> Bool {
    let dir = try captureDirectory(id)
    return try withLock {
      guard Self.exists(dir), !Self.exists(dir.appendingPathComponent("rejection")) else { return false }
      let lease = dir.appendingPathComponent("lease")
      if liveLease(lease) != nil { return false }
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
    let malformed = try rootDirectory().appendingPathComponent("malformed", isDirectory: true)
    try withLock {
      guard Self.exists(dir) else { return }
      try FileManager.default.createDirectory(at: malformed, withIntermediateDirectories: true, attributes: Self.protection)
      var target = malformed.appendingPathComponent(id, isDirectory: true)
      if Self.exists(target) {
        target = malformed.appendingPathComponent("\(id)-\(UUID().uuidString)", isDirectory: true)
      }
      try Self.rename(dir, target)
    }
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
    let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent)-\(UUID().uuidString)")
    let fd = open(tmp.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw posixError("open") }
    var committed = false
    defer { if !committed { unlink(tmp.path) } }
    do {
      defer { close(fd) }
      try data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
        var offset = 0
        while offset < buffer.count {
          let written = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
          if written < 0 {
            if errno == EINTR { continue }
            throw posixError("write")
          }
          offset += written
        }
      }
      // fsync(2) on Darwin may leave data in the drive cache; F_FULLFSYNC doesn't.
      if durable && fcntl(fd, F_FULLFSYNC) != 0 && fsync(fd) != 0 { throw posixError("fsync") }
    }
    try rename(tmp, url)
    committed = true
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
