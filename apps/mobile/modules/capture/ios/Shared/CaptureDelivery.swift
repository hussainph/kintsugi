import Foundation

/// Delivers queued captures to the Mac with a background URLSession, so an
/// upload outlives the share extension that started it. Safe in extensions.
///
/// `start` claims the capture under a lease of its own, then uploads its
/// payload file to `POST /v1/clips`. The capture is acknowledged (removed) only
/// on a 2xx whose body is `{path: string}`; any other ending releases that
/// lease for the app's outbox. The task's description, `"<id> <lease owner>"`,
/// carries both across a relaunch. The 30 s resource timeout ends every task
/// well inside the 120 s lease; a completion that only arrives after the lease
/// lapsed (the app was force-quit, so iOS held the events) can still remove a
/// delivered capture but never frees another sender's lease.
///
/// Each extension launch uploads on a session of its own,
/// `sessionIdentifierPrefix + UUID`, so a session the app reconnected to never
/// collides with the next launch's. Completion reaches whichever process holds
/// the session: the extension if still alive, else the app, relaunched by iOS
/// with `handleEventsForBackgroundURLSession`. The app reconnects to that one
/// identifier only then (`reconnect(identifier:completionHandler:)`) and
/// invalidates the session once its events are settled.
public final class CaptureDelivery: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  public static let sessionIdentifierPrefix = "dev.phalasiya.kintsugi.share.upload."
  public static let requestTimeout: TimeInterval = 8
  public static let resourceTimeout: TimeInterval = 30
  static let maxResponseBody = 64 * 1024

  /// This process's delivery, on a session identifier unique to this launch.
  /// For the extension; the app only reconnects.
  public static let shared = CaptureDelivery(
    identifier: sessionIdentifierPrefix + UUID().uuidString,
    store: CaptureStore(),
    pairing: CapturePairing.load
  )

  /// Deliveries the app reconnected to, by session identifier, kept alive
  /// until their sessions are invalidated.
  static let reconnected = Registry()

  public let identifier: String
  let store: CaptureStore
  let loadPairing: () throws -> CapturePairing?
  private let lock = NSLock()
  private var session: URLSession?
  var finishEvents: (() -> Void)?
  // `session` and `finishEvents` are guarded by `lock`; `bodies` is touched
  // only on the serial delegate `queue`.
  /// Response bodies by task.
  private(set) var bodies: [Int: Data] = [:]
  private let queue: OperationQueue = {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    queue.name = "dev.phalasiya.kintsugi.capture.delivery"
    return queue
  }()

  init(identifier: String, store: CaptureStore, pairing: @escaping () throws -> CapturePairing?) {
    self.identifier = identifier
    self.store = store
    loadPairing = pairing
  }

  /// Claims capture `id` and schedules its upload, returning once the task is
  /// resumed. Throws `busy` when another sender holds it and `unpaired` without
  /// a pairing; on any throw after the claim the capture is released.
  public func start(id: String) throws {
    let owner = UUID().uuidString
    guard try store.claim(id, owner: owner) else { throw CaptureError.busy }
    do {
      guard let pairing = try loadPairing() else { throw CaptureError.unpaired }
      let request = try Self.request(for: pairing)
      let file = try store.payloadURL(id)
      let task = backgroundSession().uploadTask(with: request, fromFile: file)
      task.taskDescription = "\(id) \(owner)"
      task.resume()
    } catch {
      try? store.release(id, owner: owner)
      throw error
    }
  }

  public static func isSessionIdentifier(_ identifier: String) -> Bool {
    identifier.hasPrefix(sessionIdentifierPrefix) && identifier.count > sessionIdentifierPrefix.count
  }

  /// For the app's `handleEventsForBackgroundURLSession`: reconnects to an
  /// extension's session so its finished tasks are settled, then calls
  /// `completionHandler` on the main queue and invalidates the session.
  /// Identifiers that aren't ours get `completionHandler` at once.
  public static func reconnect(identifier: String, completionHandler: @escaping () -> Void) {
    guard isSessionIdentifier(identifier) else {
      completionHandler()
      return
    }
    let delivery = reconnected.delivery(for: identifier) {
      CaptureDelivery(identifier: identifier, store: CaptureStore(), pairing: CapturePairing.load)
    }
    delivery.lock.lock()
    delivery.finishEvents = completionHandler
    delivery.lock.unlock()
    _ = delivery.backgroundSession()
  }

  public static func request(for pairing: CapturePairing) throws -> URLRequest {
    var base = pairing.url
    while base.hasSuffix("/") { base.removeLast() }
    guard let url = URL(string: base + "/v1/clips") else { throw CaptureError.invalidPairing }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: requestTimeout)
    request.httpMethod = "POST"
    request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    return request
  }

  /// Whether the Mac took the clip: a 2xx answer carrying `{path: string}`.
  static func delivered(status: Int?, body: Data, error: Error?) -> Bool {
    guard error == nil, let status, (200..<300).contains(status),
          let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    else { return false }
    return object["path"] is String
  }

  /// Settles a finished upload: removes the capture or releases its lease for a retry.
  func complete(task description: String?, status: Int?, body: Data, error: Error?) {
    let parts = description?.split(separator: " ").map(String.init) ?? []
    guard parts.count == 2 else { return } // not one of ours
    if Self.delivered(status: status, body: body, error: error) {
      try? store.acknowledge(parts[0])
    } else {
      if error == nil, let status, [400, 413, 422].contains(status) {
        try? store.reject(parts[0], reason: "The Mac rejected this capture (HTTP \(status)). Its contents are preserved on this iPhone.")
      }
      try? store.release(parts[0], owner: parts[1])
    }
  }

  private func backgroundSession() -> URLSession {
    lock.lock()
    defer { lock.unlock() }
    if let session { return session }
    let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
    configuration.sharedContainerIdentifier = CaptureStore.appGroup
    configuration.isDiscretionary = false
    configuration.sessionSendsLaunchEvents = true
    configuration.timeoutIntervalForRequest = Self.requestTimeout
    configuration.timeoutIntervalForResource = Self.resourceTimeout
    configuration.urlCache = nil
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    self.session = session
    return session
  }

  // MARK: - URLSessionDataDelegate

  public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    var body = bodies[dataTask.taskIdentifier] ?? Data()
    body.append(data.prefix(max(0, Self.maxResponseBody - body.count)))
    bodies[dataTask.taskIdentifier] = body
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let body = bodies.removeValue(forKey: task.taskIdentifier) ?? Data()
    let status = (task.response as? HTTPURLResponse)?.statusCode
    complete(task: task.taskDescription, status: status, body: body, error: error)
  }

  public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    lock.lock()
    let handler = finishEvents
    finishEvents = nil
    if handler != nil, self.session === session { self.session = nil }
    lock.unlock()
    guard let handler else { return }
    // A reconnected session has nothing left to do: let it go, so the app
    // holds no extension session afterwards. Forget it now, so a later
    // relaunch for this identifier reconnects afresh.
    Self.reconnected.remove(self)
    session.finishTasksAndInvalidate()
    DispatchQueue.main.async(execute: handler)
  }

  public func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
    lock.lock()
    if self.session === session { self.session = nil }
    lock.unlock()
    Self.reconnected.remove(self)
  }

  /// Reconnected deliveries by identifier, guarded by a lock.
  final class Registry: @unchecked Sendable {
    private let lock = NSLock()
    private var deliveries: [String: CaptureDelivery] = [:]

    func delivery(for identifier: String, make: () -> CaptureDelivery) -> CaptureDelivery {
      lock.lock()
      defer { lock.unlock() }
      if let delivery = deliveries[identifier] { return delivery }
      let delivery = make()
      deliveries[identifier] = delivery
      return delivery
    }

    func remove(_ delivery: CaptureDelivery) {
      lock.lock()
      defer { lock.unlock() }
      if deliveries[delivery.identifier] === delivery { deliveries[delivery.identifier] = nil }
    }

    var identifiers: [String] {
      lock.lock()
      defer { lock.unlock() }
      return deliveries.keys.sorted()
    }
  }
}
