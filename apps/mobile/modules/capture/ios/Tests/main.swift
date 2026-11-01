// Standalone tests for ios/Shared, compiled with it by run.sh (no Xcode project).
// Scratch directories go under $CAPTURE_TEST_DIR (run.sh: apps/mobile/.expo).
// The binary doubles as a child process for the cross-process cases:
//   capture-tests claim <dir> <id>    exits 0 if it won the claim, 1 if not
//   capture-tests die-locked <dir>    SIGKILLs itself while holding the lock
//   capture-tests claim-read <dir> <id>  claims (win or lose), then prints the
//                                     payload's id as read; exits 4 on failure
//   capture-tests enqueue-file <dir> <file>  queues the file and prints the
//                                     process's peak resident bytes; exits 5 on failure
import Foundation

let arguments = CommandLine.arguments
if arguments.count >= 3 {
  let store = CaptureStore(directory: URL(fileURLWithPath: arguments[2]))
  switch arguments[1] {
  case "claim":
    exit((try? store.claim(arguments[3])) == true ? 0 : 1)
  case "claim-read":
    _ = try? store.claim(arguments[3])
    guard let json = try? store.read(arguments[3]),
          let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
          let id = object["id"] as? String
    else { exit(4) }
    print(id)
    exit(0)
  case "enqueue-file":
    let fields: [String: Any] = ["capturedAt": "2026-10-29T14:05", "via": "share", "fileType": "application/pdf", "fileName": "a.pdf"]
    guard (try? store.enqueue(fields: fields, file: URL(fileURLWithPath: arguments[3]))) != nil else { exit(5) }
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    print(usage.ru_maxrss) // bytes on Darwin
    exit(0)
  case "die-locked":
    _ = try? store.withLock { kill(getpid(), SIGKILL) }
    exit(2)
  default:
    exit(3)
  }
}

var failures = 0
var current = ""

func check(_ condition: @autoclosure () throws -> Bool, _ message: String, line: Int = #line) {
  do {
    if try !condition() {
      failures += 1
      print("  FAIL \(current) (line \(line)): \(message)")
    }
  } catch {
    failures += 1
    print("  FAIL \(current) (line \(line)): \(message) threw \(error)")
  }
}

func throwsError(_ expected: CaptureError, _ body: () throws -> Void) -> Bool {
  do { try body(); return false } catch { return (error as? CaptureError) == expected }
}

func test(_ name: String, _ body: (URL) throws -> Void) {
  current = name
  let before = failures
  let scratch = ProcessInfo.processInfo.environment["CAPTURE_TEST_DIR"]
    .map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.temporaryDirectory
  let dir = scratch
    .appendingPathComponent("capture-tests-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: dir) }
  do { try body(dir) } catch {
    failures += 1
    print("  FAIL \(name): threw \(error)")
  }
  if failures == before { print("ok   \(name)") }
}

func summaries(_ store: CaptureStore) throws -> [[String: String]] {
  try JSONSerialization.jsonObject(with: Data(store.pending().utf8)) as! [[String: String]]
}

func names(_ dir: URL) -> [String] {
  ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).sorted()
}

func runChild(_ args: [String]) throws -> Process {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
  process.arguments = args
  try process.run()
  return process
}

// Carries its own capture id (KI-10), so it is queued byte for byte.
let suppliedID = "0f5e1c2a-9b3d-4e8f-a1b2-c3d4e5f60718"
let payload = #"{"id":"\#(suppliedID)","url":"https://example.com/a","note":"é ✨","capturedAt":"2026-10-29T14:05","via":"share"}"#
// Without one, as callers queued before KI-10 (and may still) do.
let bare = #"{"url":"https://example.com/a","note":"é ✨","capturedAt":"2026-10-29T14:05","via":"share"}"#

func isUUID(_ value: String?) -> Bool {
  guard let value, value.count == 36 else { return false }
  return UUID(uuidString: value) != nil
}

/// The `id` fields at the top level of a payload, as JSON sees them.
func payloadID(_ json: String) -> String? {
  (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])?["id"] as? String
}

func fileBytes(_ store: CaptureStore, _ id: String) throws -> Data {
  try Data(contentsOf: store.payloadURL(id))
}

func meta(_ dir: URL, _ id: String) throws -> [String: String] {
  try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("captures/\(id)/meta.json"))) as! [String: String]
}

/// A capture as the queue committed it before KI-10: payload verbatim, meta
/// with capturedAt only.
func legacy(_ dir: URL, _ body: String, capturedAt: String = "2026-10-29T14:05", id: String = CaptureStore.newID(Date())) throws -> String {
  let capture = dir.appendingPathComponent("captures/\(id)", isDirectory: true)
  try FileManager.default.createDirectory(at: capture, withIntermediateDirectories: true)
  try Data(body.utf8).write(to: capture.appendingPathComponent("payload.json"))
  try JSONSerialization.data(withJSONObject: ["capturedAt": capturedAt]).write(to: capture.appendingPathComponent("meta.json"))
  return id
}

test("enqueue writes one committed directory per capture, read returns it verbatim") { dir in
  let store = CaptureStore(directory: dir)
  let id = try store.enqueue(payload)
  let captures = dir.appendingPathComponent("captures")
  check(names(captures) == [id], "only the committed capture, no temp files: \(names(captures))")
  check(names(captures.appendingPathComponent(id)) == ["meta.json", "payload.json"], "payload and meta")
  check(try store.read(id) == payload, "read is verbatim")
  check(try Data(contentsOf: store.payloadURL(id)) == Data(payload.utf8), "payload file is the upload body")
}

test("trusted Data enqueue writes the bytes as given, within the size bound") { dir in
  let store = CaptureStore(directory: dir)
  let id = try store.enqueue(Data(payload.utf8), capturedAt: "2026-10-29T14:05")
  check(try store.read(id) == payload, "verbatim")
  check(try summaries(store) == [["id": id, "capturedAt": "2026-10-29T14:05"]], "listed with its capturedAt")
  let big = Data(count: CaptureStore.maxPayloadBytes + 1)
  check(throwsError(.tooLarge) { _ = try store.enqueue(big, capturedAt: "x") }, "too large")
  check(try summaries(store).count == 1, "nothing else queued")
}

test("pending lists metadata only, oldest first") { dir in
  var clock = Date(timeIntervalSince1970: 1_800_000_000)
  let store = CaptureStore(directory: dir, now: { clock })
  let first = try store.enqueue(payload)
  clock += 0.001
  let second = try store.enqueue(#"{"text":"later","capturedAt":"2026-10-29T14:06","via":"phone"}"#)
  let items = try summaries(store)
  check(items == [
    ["id": first, "capturedAt": "2026-10-29T14:05"],
    ["id": second, "capturedAt": "2026-10-29T14:06"],
  ], "\(items)")
}

test("enqueue rejects what isn't a capture and leaves nothing behind") { dir in
  let store = CaptureStore(directory: dir)
  check(throwsError(.invalidPayload) { _ = try store.enqueue("not json") }, "not JSON")
  check(throwsError(.invalidPayload) { _ = try store.enqueue("[1]") }, "not an object")
  check(throwsError(.invalidPayload) { _ = try store.enqueue(#"{"url":"x"}"#) }, "no capturedAt")
  check(try store.pending() == "[]", "nothing queued")
  check(names(dir.appendingPathComponent("captures")).isEmpty, "no files")
}

test("an interrupted write is invisible and swept once stale") { dir in
  var clock = Date()
  let store = CaptureStore(directory: dir, now: { clock })
  let captures = dir.appendingPathComponent("captures")
  let tmp = captures.appendingPathComponent(".tmp-crashed")
  try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
  try Data("{\"capturedAt\":".utf8).write(to: tmp.appendingPathComponent("payload.json"))
  let trash = captures.appendingPathComponent(".trash-crashed")
  try FileManager.default.createDirectory(at: trash, withIntermediateDirectories: true)
  check(try store.pending() == "[]", "half-written capture isn't listed")
  check(names(captures) == [".tmp-crashed"], "trash swept at once, fresh temp kept: \(names(captures))")
  clock += 2 * 3600
  _ = try store.pending()
  check(names(captures).isEmpty, "stale temp swept")
}

test("claim leases, a second claim is refused, release and acknowledge settle") { dir in
  let store = CaptureStore(directory: dir)
  let id = try store.enqueue(payload)
  check(try store.claim(id), "first claim wins")
  check(try !store.claim(id), "second claim refused while leased")
  check(try summaries(store).map { $0["id"] } == [id], "pending still lists a leased capture")
  try store.release(id)
  try store.release(id) // idempotent
  check(try store.claim(id), "claimable after release")
  try store.acknowledge(id)
  try store.acknowledge(id) // idempotent
  check(try store.pending() == "[]", "gone after acknowledge")
  check(try !store.claim(id), "nothing to claim")
  check(throwsError(.notFound) { _ = try store.read(id) }, "read after acknowledge")
  check(names(dir.appendingPathComponent("captures")).isEmpty, "no trash left")
}

test("a lease from a sender that died expires after 120 s") { dir in
  var clock = Date(timeIntervalSince1970: 1_800_000_000)
  let store = CaptureStore(directory: dir, now: { clock })
  let id = try store.enqueue(payload)
  check(try store.claim(id), "claimed, then the claimer crashed")
  clock += 119
  check(try !store.claim(id), "still leased at 119 s")
  clock += 2
  check(try store.claim(id), "recovered after expiry")
}

test("a lease dated far ahead (clock set back) doesn't pin a capture") { dir in
  var clock = Date(timeIntervalSince1970: 1_800_000_000)
  let store = CaptureStore(directory: dir, now: { clock })
  let id = try store.enqueue(payload)
  check(try store.claim(id), "claimed")
  clock -= 3600
  check(try store.claim(id), "lease beyond now + 120 s is ignored")
}

test("ids are validated before touching paths") { dir in
  let store = CaptureStore(directory: dir)
  check(throwsError(.invalidID) { _ = try store.claim("../x") }, "traversal")
  check(throwsError(.invalidID) { _ = try store.read(".lock") }, "dot file")
  check(throwsError(.invalidID) { try store.acknowledge("") }, "empty")
}

test("damaged captures are kept aside, never deleted or sent") { dir in
  let store = CaptureStore(directory: dir)
  let good = try store.enqueue(payload)
  let badPayload = try store.enqueue(payload)
  try Data("{oops".utf8).write(to: store.payloadURL(badPayload))
  let badMeta = try store.enqueue(payload)
  try Data("garbage".utf8).write(to: dir.appendingPathComponent("captures/\(badMeta)/meta.json"))

  check(try summaries(store).map { $0["id"]! } == [good, badPayload], "bad meta dropped from pending")
  check(throwsError(.malformed) { _ = try store.read(badPayload) }, "bad payload refuses to read")
  check(try summaries(store).map { $0["id"]! } == [good], "only the good one left")
  let malformed = dir.appendingPathComponent("malformed")
  check(names(malformed) == [badPayload, badMeta].sorted(), "both retained: \(names(malformed))")
  check(try String(contentsOf: malformed.appendingPathComponent("\(badPayload)/payload.json"), encoding: .utf8) == "{oops", "bytes kept")
  check(try !store.claim(badPayload), "not claimable")
}

test("no App Group means a clear error") { _ in
  let store = CaptureStore(directory: nil)
  check(throwsError(.noAppGroup) { _ = try store.enqueue(payload) }, "enqueue")
  check(throwsError(.noAppGroup) { _ = try store.pending() }, "pending")
}

test("exactly one of many processes wins a claim") { dir in
  let store = CaptureStore(directory: dir)
  let id = try store.enqueue(payload)
  let children = try (0..<8).map { _ in try runChild(["claim", dir.path, id]) }
  children.forEach { $0.waitUntilExit() }
  let winners = children.filter { $0.terminationStatus == 0 }.count
  check(winners == 1, "\(winners) winners")
}

test("a process killed while holding the lock doesn't wedge the queue") { dir in
  let store = CaptureStore(directory: dir)
  let id = try store.enqueue(payload)
  let child = try runChild(["die-locked", dir.path])
  child.waitUntilExit()
  check(child.terminationReason == .uncaughtSignal, "child died holding the lock")
  check(try store.claim(id), "lock is free again")
}

test("threads in one process exclude each other too") { dir in
  let store = CaptureStore(directory: dir)
  let id = try store.enqueue(payload)
  let wins = NSLock()
  var count = 0
  DispatchQueue.concurrentPerform(iterations: 16) { _ in
    if (try? store.claim(id)) == true { wins.lock(); count += 1; wins.unlock() }
  }
  check(count == 1, "\(count) winners")
}

test("localStamp is local minutes") { _ in
  var parts = DateComponents()
  (parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second) = (2026, 3, 7, 9, 4, 59)
  let date = Calendar(identifier: .gregorian).date(from: parts)!
  check(CaptureStore.localStamp(date) == "2026-03-07T09:04", CaptureStore.localStamp(date))
}

test("pairing JSON is validated") { _ in
  let pairing = try CapturePairing(json: #"{"url":"https://mac.tail.ts.net","token":"t0k"}"#)
  check(pairing == CapturePairing(url: "https://mac.tail.ts.net", token: "t0k"), "parsed")
  check(try CapturePairing(json: pairing.json) == pairing, "round-trips")
  check(throwsError(.invalidPairing) { _ = try CapturePairing(json: #"{"url":"ftp://x","token":"t"}"#) }, "scheme")
  check(throwsError(.invalidPairing) { _ = try CapturePairing(json: #"{"url":"https://x"}"#) }, "token")
  check(throwsError(.invalidPairing) { _ = try CapturePairing(json: "null") }, "null")
  check(try CapturePairing(json: #"{"url":"http://100.64.0.1:4317/","token":"t"}"#).url == "http://100.64.0.1:4317/", "origin with port")
  for bad in ["http:/foo", "https://", "https://u:p@mac.ts.net", "https://mac.ts.net/v1", "https://mac.ts.net?x=1", "https://mac.ts.net#f", "mac.ts.net"] {
    check(throwsError(.invalidPairing) { _ = try CapturePairing(json: #"{"url":"\#(bad)","token":"t"}"#) }, "rejects \(bad)")
  }
}

test("delivery request targets POST /v1/clips with the token") { _ in
  let request = try CaptureDelivery.request(for: CapturePairing(url: "https://mac.tail.ts.net/", token: "t0k"))
  check(request.url?.absoluteString == "https://mac.tail.ts.net/v1/clips", "\(String(describing: request.url))")
  check(request.httpMethod == "POST", "method")
  check(request.value(forHTTPHeaderField: "Authorization") == "Bearer t0k", "auth")
  check(request.value(forHTTPHeaderField: "Content-Type") == "application/json", "content type")
  check(request.timeoutInterval == 8, "request timeout")
}

test("delivery succeeds only on 2xx with {path: string}") { _ in
  let path = Data(#"{"path":"inspiration/a.md"}"#.utf8)
  check(CaptureDelivery.delivered(status: 200, body: path, error: nil), "200 + path")
  check(CaptureDelivery.delivered(status: 201, body: path, error: nil), "201 + path")
  check(!CaptureDelivery.delivered(status: 200, body: Data("{}".utf8), error: nil), "no path")
  check(!CaptureDelivery.delivered(status: 200, body: Data(#"{"path":1}"#.utf8), error: nil), "path not a string")
  check(!CaptureDelivery.delivered(status: 200, body: Data("<html>".utf8), error: nil), "not JSON")
  check(!CaptureDelivery.delivered(status: 401, body: path, error: nil), "401")
  check(!CaptureDelivery.delivered(status: 502, body: path, error: nil), "502")
  check(!CaptureDelivery.delivered(status: nil, body: Data(), error: URLError(.timedOut)), "timeout")
  check(!CaptureDelivery.delivered(status: 200, body: path, error: URLError(.cancelled)), "error wins")
}

test("a finished upload acknowledges on success and releases its own lease on failure") { dir in
  let store = CaptureStore(directory: dir)
  let delivery = CaptureDelivery(identifier: "test", store: store, pairing: { nil })
  let sent = try store.enqueue(payload)
  let failed = try store.enqueue(payload)
  check(try store.claim(sent, owner: "task-a") && store.claim(failed, owner: "task-b"), "both claimed")
  delivery.complete(task: "\(sent) task-a", status: 200, body: Data(#"{"path":"inspiration/a.md"}"#.utf8), error: nil)
  delivery.complete(task: "\(failed) task-b", status: 500, body: Data(), error: nil)
  check(try summaries(store).map { $0["id"]! } == [failed], "sent one removed, failed one kept")
  check(try store.claim(failed), "failed one released for retry")
}

test("400, 413 and 422 preserve rejected captures without automatic retry") { dir in
  let store = CaptureStore(directory: dir)
  let delivery = CaptureDelivery(identifier: "test", store: store, pairing: { nil })
  for status in [400, 413, 422] {
    let id = try store.enqueue(payload)
    check(try store.claim(id, owner: "task"), "claimed")
    delivery.complete(task: "\(id) task", status: status, body: Data(), error: nil)
    let reopened = CaptureStore(directory: dir)
    check(try reopened.read(id) == payload, "original bytes preserved")
    check(try !reopened.claim(id), "no retry after reopening")
    check(try summaries(reopened).first { $0["id"] == id }?["error"] != nil, "visible rejection")
  }
  let valid = try store.enqueue(payload)
  check(try store.claim(valid), "later captures aren't blocked")
}

test("response bodies are kept to 64 KiB") { dir in
  let delivery = CaptureDelivery(identifier: "test", store: CaptureStore(directory: dir), pairing: { nil })
  let session = URLSession(configuration: .ephemeral)
  let task = session.dataTask(with: URL(string: "http://127.0.0.1:9/")!)
  delivery.urlSession(session, dataTask: task, didReceive: Data(count: 60 * 1024))
  delivery.urlSession(session, dataTask: task, didReceive: Data(count: 60 * 1024))
  check((delivery.bodies[task.taskIdentifier]?.count ?? 0) == CaptureDelivery.maxResponseBody, "\((delivery.bodies[task.taskIdentifier]?.count ?? 0))")
  session.invalidateAndCancel()
}

test("a finished task that isn't ours is ignored") { dir in
  let store = CaptureStore(directory: dir)
  let id = try store.enqueue(payload)
  let delivery = CaptureDelivery(identifier: "test", store: store, pairing: { nil })
  delivery.complete(task: nil, status: 200, body: Data(#"{"path":"p"}"#.utf8), error: nil)
  delivery.complete(task: id, status: 200, body: Data(#"{"path":"p"}"#.utf8), error: nil)
  check(try summaries(store).count == 1, "still queued")
}

test("release only drops the caller's own lease") { dir in
  let store = CaptureStore(directory: dir)
  let id = try store.enqueue(payload)
  check(try store.claim(id, owner: "extension-task"), "delivery leased it")
  try store.release(id) // the app's JS, finally-releasing after a refused claim
  check(try !store.claim(id), "delivery's lease survives")
  try store.release(id, owner: "extension-task")
  check(try store.claim(id), "owner's release frees it")
}

test("a late failure after the lease lapsed doesn't free the next sender's lease") { dir in
  var clock = Date(timeIntervalSince1970: 1_800_000_000)
  let store = CaptureStore(directory: dir, now: { clock })
  let delivery = CaptureDelivery(identifier: "test", store: store, pairing: { nil })
  let id = try store.enqueue(payload)
  check(try store.claim(id, owner: "slow-task"), "background task leased it")
  clock += 121
  check(try store.claim(id), "the app's outbox takes it over")
  delivery.complete(task: "\(id) slow-task", status: nil, body: Data(), error: URLError(.timedOut))
  check(try !store.claim(id, owner: "third"), "the app's lease stands")
  delivery.complete(task: "\(id) slow-task", status: 200, body: Data(#"{"path":"p"}"#.utf8), error: nil)
  check(try store.pending() == "[]", "a late success still removes the delivered capture")
}

test("a damaged lease file counts as expired") { dir in
  let store = CaptureStore(directory: dir)
  let id = try store.enqueue(payload)
  try Data("junk".utf8).write(to: dir.appendingPathComponent("captures/\(id)/lease"))
  check(try store.claim(id), "claimable")
}

test("captures over the size bound are refused up front") { dir in
  let store = CaptureStore(directory: dir)
  let filler = String(repeating: "a", count: CaptureStore.maxPayloadBytes)
  check(throwsError(.tooLarge) { _ = try store.enqueue(#"{"capturedAt":"x","text":"\#(filler)"}"#) }, "too large")
  // The bound covers what is committed, so leave room for a generated id too.
  let fits = String(repeating: "a", count: CaptureStore.maxPayloadBytes - 128)
  check(try !store.enqueue(#"{"capturedAt":"x","text":"\#(fits)"}"#).isEmpty, "just under fits")
  let edge = String(repeating: "a", count: CaptureStore.maxPayloadBytes - 29 - 20)
  let body = #"{"capturedAt":"x","text":"\#(edge)"}"#
  check(body.utf8.count < CaptureStore.maxPayloadBytes, "fits only without an id")
  check(throwsError(.tooLarge) { _ = try store.enqueue(body) }, "too large once its id is added")
}

test("each launch uploads on its own session identifier") { _ in
  let prefix = CaptureDelivery.sessionIdentifierPrefix
  check(prefix == "dev.phalasiya.kintsugi.share.upload.", prefix)
  let shared = CaptureDelivery.shared.identifier
  check(shared.hasPrefix(prefix) && UUID(uuidString: String(shared.dropFirst(prefix.count))) != nil, shared)
  check(CaptureDelivery.isSessionIdentifier(shared), "shared is ours")
  check(CaptureDelivery.isSessionIdentifier(prefix + "0F5E…"), "any launch's is ours")
  check(!CaptureDelivery.isSessionIdentifier("dev.phalasiya.kintsugi.share.upload"), "old fixed id")
  check(!CaptureDelivery.isSessionIdentifier(prefix), "bare prefix")
  check(!CaptureDelivery.isSessionIdentifier("com.other.app.upload"), "someone else's")
}

test("reconnect answers other sessions at once and registers nothing") { _ in
  var called = false
  CaptureDelivery.reconnect(identifier: "com.other.app.upload") { called = true }
  check(called, "handler called synchronously")
  check(CaptureDelivery.reconnected.identifiers.isEmpty, "\(CaptureDelivery.reconnected.identifiers)")
}

test("a reconnected delivery is kept per identifier until its events finish") { dir in
  let registry = CaptureDelivery.reconnected
  let id = CaptureDelivery.sessionIdentifierPrefix + "launch-a"
  let make = { (id: String) in { CaptureDelivery(identifier: id, store: CaptureStore(directory: dir), pairing: { nil }) } }
  let delivery = registry.delivery(for: id, make: make(id))
  check(registry.delivery(for: id, make: make(id)) === delivery, "same instance for the same identifier")
  let otherID = CaptureDelivery.sessionIdentifierPrefix + "launch-b"
  let other = registry.delivery(for: otherID, make: make(otherID))
  check(other !== delivery, "another launch gets its own")
  registry.remove(other)

  var finished = false
  delivery.finishEvents = { finished = true }
  let session = URLSession(configuration: .ephemeral)
  delivery.urlSessionDidFinishEvents(forBackgroundURLSession: session)
  check(registry.identifiers.isEmpty, "released once its events finished: \(registry.identifiers)")
  RunLoop.main.run(until: Date().addingTimeInterval(0.2))
  check(finished, "system completion handler called on the main queue")
  check(registry.delivery(for: id, make: make(id)) !== delivery, "a later relaunch reconnects afresh")
  registry.remove(registry.delivery(for: id, make: make(id)))
  check(registry.identifiers.isEmpty, "\(registry.identifiers)")
}

test("the extension's own session isn't invalidated by finished events") { dir in
  let delivery = CaptureDelivery(identifier: "test", store: CaptureStore(directory: dir), pairing: { nil })
  let session = URLSession(configuration: .ephemeral)
  delivery.urlSessionDidFinishEvents(forBackgroundURLSession: session) // no handler: not reconnected
  var stillUsable = false
  session.getAllTasks { _ in stillUsable = true }
  RunLoop.main.run(until: Date().addingTimeInterval(0.2))
  check(stillUsable, "session left alone")
  session.invalidateAndCancel()
}

test("start refuses a leased capture and releases when unpaired") { dir in
  let store = CaptureStore(directory: dir)
  let id = try store.enqueue(payload)
  let unpaired = CaptureDelivery(identifier: "test", store: store, pairing: { nil })
  check(throwsError(.unpaired) { try unpaired.start(id: id) }, "unpaired")
  check(try store.claim(id), "released after the failed start")
  check(throwsError(.busy) { try unpaired.start(id: id) }, "busy while leased elsewhere")
  check(try !store.claim(id), "the other sender's lease is untouched")
}

// MARK: - Capture ids (KI-10)

test("both enqueues give an id-less capture one UUID, spliced in front, rest verbatim") { dir in
  let store = CaptureStore(directory: dir)
  let fromString = try store.enqueue(bare)
  let fromData = try store.enqueue(Data(bare.utf8), capturedAt: "2026-10-29T14:05")
  var seen: [String] = []
  for queueID in [fromString, fromData] {
    let json = try store.read(queueID)
    let captureID = payloadID(json)
    check(isUUID(captureID), "a UUID id: \(json.prefix(60))")
    check(captureID == captureID?.lowercased(), "generated lowercase")
    check(captureID != queueID && !json.contains(queueID), "the queue id never stands in for the capture id")
    check(json == #"{"id":"\#(captureID ?? "")","# + bare.dropFirst(), "only the id was added")
    check(try fileBytes(store, queueID) == Data(json.utf8), "the upload body carries it")
    check(try store.captureID(queueID) == captureID, "captureID agrees")
    check(try meta(dir, queueID) == ["capturedAt": "2026-10-29T14:05", "captureId": captureID ?? ""], "meta records it")
    seen.append(captureID ?? "")
  }
  check(Set(seen).count == 2, "each capture gets its own")
  check(try summaries(store).map { $0.keys.sorted() } == [["capturedAt", "id"], ["capturedAt", "id"]], "pending is unchanged in shape")
}

test("a supplied UUID is kept byte for byte, in either case, by both enqueues") { dir in
  let store = CaptureStore(directory: dir)
  let upper = suppliedID.uppercased()
  let shouting = payload.replacingOccurrences(of: suppliedID, with: upper)
  let spaced = "\n { \"capturedAt\" : \"2026-10-29T14:05\" , \"id\" : \"\(suppliedID)\" }\n"
  for (body, expected) in [(payload, suppliedID), (shouting, upper), (spaced, suppliedID)] {
    for queueID in [try store.enqueue(body), try store.enqueue(Data(body.utf8), capturedAt: "2026-10-29T14:05")] {
      check(try fileBytes(store, queueID) == Data(body.utf8), "verbatim: \(body.prefix(40))")
      check(try store.captureID(queueID) == expected, "kept as given")
    }
  }
}

test("a null id counts as missing and is replaced in place") { dir in
  let store = CaptureStore(directory: dir)
  let body = #"{"capturedAt":"2026-10-29T14:05","id":null,"via":"phone"}"#
  for queueID in [try store.enqueue(body), try store.enqueue(Data(body.utf8), capturedAt: "2026-10-29T14:05")] {
    let json = try store.read(queueID)
    let captureID = try store.captureID(queueID) ?? ""
    check(isUUID(captureID), json)
    check(json == #"{"capturedAt":"2026-10-29T14:05","id":"\#(captureID)","via":"phone"}"#, json)
  }
}

test("ids that aren't hyphenated UUIDs are refused by both enqueues, leaving nothing") { dir in
  let store = CaptureStore(directory: dir)
  let bad = [
    #""not-a-uuid""#, #""""#, "42", "true", #"{"id":"x"}"#, #"["\#(suppliedID)"]"#,
    #""\#(suppliedID.replacingOccurrences(of: "-", with: ""))""#,
    #""{\#(suppliedID)}""#, #""urn:uuid:\#(suppliedID)""#, #"" \#(suppliedID)""#,
    #""\#(suppliedID.dropLast())g""#,
  ]
  for value in bad {
    let body = #"{"capturedAt":"2026-10-29T14:05","id":\#(value)}"#
    check(throwsError(.invalidPayload) { _ = try store.enqueue(body) }, "String: \(value)")
    check(throwsError(.invalidPayload) { _ = try store.enqueue(Data(body.utf8), capturedAt: "2026-10-29T14:05") }, "Data: \(value)")
  }
  // An escaped key is still `id`; two ids are ambiguous even if both are valid.
  let escaped = #"{"capturedAt":"2026-10-29T14:05","\u0069d":"nope"}"#
  check(throwsError(.invalidPayload) { _ = try store.enqueue(Data(escaped.utf8), capturedAt: "2026-10-29T14:05") }, "escaped key")
  let twice = #"{"id":"\#(suppliedID)","capturedAt":"2026-10-29T14:05","id":"\#(suppliedID)"}"#
  check(throwsError(.invalidPayload) { _ = try store.enqueue(twice) }, "duplicate id")
  check(try store.pending() == "[]", "nothing queued")
  check(names(dir.appendingPathComponent("captures")).isEmpty, "no files")
}

test("the trusted Data enqueue checks its structure and capturedAt cheaply") { dir in
  let store = CaptureStore(directory: dir)
  for body in ["", "[]", "{", #"{"capturedAt":"2026-10-29T14:05"} x"#, #"{"capturedAt":"2026-10-29T14:05",}"#] {
    check(throwsError(.invalidPayload) { _ = try store.enqueue(Data(body.utf8), capturedAt: "2026-10-29T14:05") }, "structure: \(body)")
  }
  check(throwsError(.invalidPayload) { _ = try store.enqueue(Data(bare.utf8), capturedAt: "2026-10-29T14:06") }, "capturedAt differs")
  check(throwsError(.invalidPayload) { _ = try store.enqueue(Data(#"{"via":"share"}"#.utf8), capturedAt: "x") }, "no capturedAt")
  check(try store.pending() == "[]", "nothing queued")
}

test("only top-level id keys count; nested ones and lookalikes in strings are left alone") { dir in
  let store = CaptureStore(directory: dir)
  let body = #"{"capturedAt":"2026-10-29T14:05","text":"\"id\":\"x\" {[ \\","extra":{"id":"nested","list":[{"id":1},"]}"]},"n":-1.5e3,"ok":true,"none":null}"#
  check((try? JSONSerialization.jsonObject(with: Data(body.utf8))) != nil, "fixture is JSON")
  for queueID in [try store.enqueue(body), try store.enqueue(Data(body.utf8), capturedAt: "2026-10-29T14:05")] {
    let json = try store.read(queueID)
    let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    check(isUUID(object["id"] as? String), "top-level id added")
    check(((object["extra"] as? [String: Any])?["id"] as? String) == "nested", "nested id untouched")
    check(json.hasSuffix(String(body.dropFirst())), "rest verbatim")
  }
}

test("a 15 MiB image payload gets its id without a re-encode") { dir in
  let store = CaptureStore(directory: dir)
  let image = Data(count: 15 * 1024 * 1024).base64EncodedString()
  let built = try JSONSerialization.data(withJSONObject: [
    "capturedAt": "2026-10-29T14:05", "via": "share", "image": image, "imageType": "image/png",
  ])
  let started = Date()
  let queueID = try store.enqueue(built, capturedAt: "2026-10-29T14:05")
  let elapsed = Date().timeIntervalSince(started)
  let written = try fileBytes(store, queueID)
  let captureID = try store.captureID(queueID) ?? ""
  check(isUUID(captureID), "id")
  check(written == Data(#"{"id":"\#(captureID)","#.utf8) + built.dropFirst(), "spliced, not re-encoded")
  print("     (15 MiB image enqueue: \(Int(elapsed * 1000)) ms)")
}

test("one id across reopen, claim, release, retry and read") { dir in
  let store = CaptureStore(directory: dir)
  let queueID = try store.enqueue(bare)
  let first = try fileBytes(store, queueID)
  let captureID = payloadID(try store.read(queueID))
  check(isUUID(captureID), "has one")
  for attempt in 0..<3 {
    let reopened = CaptureStore(directory: dir) // as after a relaunch, or in the other process
    check(try reopened.claim(queueID), "claim \(attempt)")
    check(payloadID(try reopened.read(queueID)) == captureID, "same id on attempt \(attempt)")
    try reopened.release(queueID)
  }
  check(try fileBytes(store, queueID) == first, "the payload was never rewritten")
}

test("retryable statuses release the capture to be resent with the same id; 400/413/422 keep it rejected") { dir in
  let store = CaptureStore(directory: dir)
  let delivery = CaptureDelivery(identifier: "test", store: store, pairing: { nil })
  for status in [408, 429, 500, 502, 503, 504, 401, 409] {
    let queueID = try store.enqueue(bare)
    let bytes = try fileBytes(store, queueID)
    check(try store.claim(queueID, owner: "task"), "claimed")
    delivery.complete(task: "\(queueID) task", status: status, body: Data(#"{"error":"later"}"#.utf8), error: nil)
    check(try summaries(store).first { $0["id"] == queueID }?["error"] == nil, "\(status) isn't a rejection")
    check(try CaptureStore(directory: dir).claim(queueID), "\(status) released for retry")
    check(try fileBytes(store, queueID) == bytes, "\(status) retries the same bytes, the same id")
    try store.acknowledge(queueID)
  }
  let offline = try store.enqueue(bare)
  let captureID = try store.captureID(offline)
  check(try store.claim(offline, owner: "task"), "claimed")
  delivery.complete(task: "\(offline) task", status: nil, body: Data(), error: URLError(.notConnectedToInternet))
  check(try store.claim(offline) && store.captureID(offline) == captureID, "network failure retries with the same id")
  for status in [400, 413, 422] {
    let queueID = try store.enqueue(bare)
    let bytes = try fileBytes(store, queueID)
    check(try store.claim(queueID, owner: "task"), "claimed")
    delivery.complete(task: "\(queueID) task", status: status, body: Data(), error: nil)
    check(try !CaptureStore(directory: dir).claim(queueID), "\(status) not retried")
    check(try fileBytes(store, queueID) == bytes, "\(status) kept, id included")
  }
}

test("a legacy capture without an id gets one, once, before it is claimed") { dir in
  let store = CaptureStore(directory: dir)
  let queueID = try legacy(dir, bare)
  check(try summaries(store) == [["id": queueID, "capturedAt": "2026-10-29T14:05"]], "listed as before")
  check(try store.claim(queueID), "claimable")
  let migrated = try String(decoding: fileBytes(store, queueID), as: UTF8.self)
  let captureID = payloadID(migrated)
  check(isUUID(captureID) && captureID != queueID, "persisted a UUID before the lease: \(migrated.prefix(60))")
  check(migrated == #"{"id":"\#(captureID ?? "")","# + bare.dropFirst(), "only the id was added")
  check(try meta(dir, queueID)["captureId"] == captureID, "recorded")
  try store.release(queueID)
  let reopened = CaptureStore(directory: dir)
  check(try reopened.claim(queueID) && payloadID(reopened.read(queueID)) == captureID, "kept after reopening")
  check(names(dir.appendingPathComponent("captures/\(queueID)")) == ["lease", "meta.json", "payload.json"], "no temp files: \(names(dir.appendingPathComponent("captures/\(queueID)")))")
}

test("a legacy capture is given its id by read and by the native upload's claim") { dir in
  let store = CaptureStore(directory: dir)
  let read = try legacy(dir, bare, id: "1700000000000-aaaaaaaaaaaa")
  check(isUUID(payloadID(try store.read(read))), "read hands over a payload with an id")
  check(payloadID(try store.read(read)) == payloadID(try store.read(read)), "the same each time")

  let uploaded = try legacy(dir, bare, id: "1700000000000-bbbbbbbbbbbb")
  let delivery = CaptureDelivery(identifier: "test", store: store, pairing: { nil })
  check(throwsError(.unpaired) { try delivery.start(id: uploaded) }, "start stops before uploading")
  let body = try String(decoding: Data(contentsOf: store.payloadURL(uploaded)), as: UTF8.self)
  check(isUUID(payloadID(body)), "the file start would upload already has its id")
  check(try store.captureID(uploaded) == payloadID(body), "and keeps it")
}

test("a legacy payload that already has a UUID keeps it and its bytes") { dir in
  let store = CaptureStore(directory: dir)
  let queueID = try legacy(dir, payload)
  check(try store.claim(queueID), "claimable")
  check(try fileBytes(store, queueID) == Data(payload.utf8), "payload untouched")
  check(try meta(dir, queueID)["captureId"] == suppliedID, "recorded")
}

test("a crash between the payload and meta writes keeps the id already written") { dir in
  let store = CaptureStore(directory: dir)
  let other = "11111111-2222-4333-8444-555555555555"
  // payload.json carries an id, meta.json doesn't record it yet.
  let queueID = try legacy(dir, #"{"id":"\#(other)","capturedAt":"2026-10-29T14:05"}"#)
  check(try store.claim(queueID), "claimable")
  check(try store.captureID(queueID) == other, "not replaced")
  check(try meta(dir, queueID)["captureId"] == other, "now recorded")
}

test("a legacy capture with an invalid id is kept rejected, not re-identified") { dir in
  let store = CaptureStore(directory: dir)
  let body = #"{"id":"0001","capturedAt":"2026-10-29T14:05"}"#
  let queueID = try legacy(dir, body)
  check(try !store.claim(queueID), "not claimable")
  check(try store.read(queueID) == body, "still readable, bytes kept")
  check(try store.captureID(queueID) == nil, "no id")
  check(try summaries(store).first?["error"] != nil, "visible rejection")
}

test("a legacy capture keeps its historical rejection and stays unclaimed") { dir in
  let store = CaptureStore(directory: dir)
  let queueID = try legacy(dir, bare)
  let reason = "The Mac rejected this capture (HTTP 422). Its contents are preserved on this iPhone."
  try Data(reason.utf8).write(to: dir.appendingPathComponent("captures/\(queueID)/rejection"))
  check(try !store.claim(queueID), "rejected captures aren't claimed")
  check(try fileBytes(store, queueID) == Data(bare.utf8), "claim refused before touching it")
  check(isUUID(payloadID(try store.read(queueID))), "read gives it an id for whoever resends it")
  check(try summaries(store).first?["error"] == reason, "rejection kept verbatim")
  check(try !store.claim(queueID), "still not claimed")
}

test("a damaged legacy capture is set aside when claimed") { dir in
  let store = CaptureStore(directory: dir)
  let queueID = try legacy(dir, "{oops")
  check(try !store.claim(queueID), "not claimable")
  check(names(dir.appendingPathComponent("malformed")) == [queueID], "kept aside")
  check(try String(contentsOf: dir.appendingPathComponent("malformed/\(queueID)/payload.json"), encoding: .utf8) == "{oops", "bytes kept")
}

test("processes and threads racing for a legacy capture all see one id") { dir in
  let store = CaptureStore(directory: dir)
  let queueID = try legacy(dir, bare)
  let children = try (0..<8).map { _ -> (Process, Pipe) in
    let pipe = Pipe()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = ["claim-read", dir.path, queueID]
    process.standardOutput = pipe
    try process.run()
    return (process, pipe)
  }
  let lock = NSLock()
  var threadIDs: [String?] = []
  DispatchQueue.concurrentPerform(iterations: 8) { _ in
    let id = try? store.captureID(queueID)
    lock.lock(); threadIDs.append(id ?? nil); lock.unlock()
  }
  var printed: [String] = []
  for (process, pipe) in children {
    let output = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    check(process.terminationStatus == 0, "child read a payload with an id")
    printed.append(String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
  }
  let all = Set(printed + threadIDs.map { $0 ?? "nil" })
  check(all.count == 1 && isUUID(all.first), "one id: \(all)")
  check(payloadID(try store.read(queueID)) == all.first, "and it is the persisted one")
  let leases = names(dir.appendingPathComponent("captures/\(queueID)")).filter { $0 == "lease" }
  check(leases.count == 1, "one claim won")
}

// MARK: - Files (KI-35)

func object(_ json: String) -> [String: Any] {
  (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]) ?? [:]
}

func scratchFile(_ dir: URL, _ bytes: Data, name: String = "Paper.pdf") throws -> URL {
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let url = dir.appendingPathComponent(name)
  try bytes.write(to: url)
  return url
}

let fileFields: [String: Any] = [
  "id": "1f0c2b7e-5d3a-4c8e-9b1a-2e6f7d8c9a0b", "capturedAt": "2026-10-29T14:05", "via": "share",
  "fileType": "application/pdf", "fileName": "Paper \"final\".pdf", "note": "é ✨",
]

test("a file is base64-encoded into the payload a chunk at a time, at every boundary") { dir in
  let store = CaptureStore(directory: dir)
  let chunk = CaptureStore.fileChunkBytes
  for size in [0, 1, 2, 3, 4, chunk - 1, chunk, chunk + 1, chunk * 2 + 2] {
    let bytes = Data((0..<size).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) })
    let file = try scratchFile(dir.appendingPathComponent("in-\(size)"), bytes)
    let id = try store.enqueue(fields: fileFields, file: file)
    let payload = object(try store.read(id))
    check(payload["file"] as? String == bytes.base64EncodedString(), "file round-trips at \(size) bytes")
    check(payload["id"] as? String == fileFields["id"] as? String, "id kept at \(size)")
    check(payload["fileName"] as? String == "Paper \"final\".pdf" && payload["note"] as? String == "é ✨", "fields kept")
    check(payload.count == fileFields.count + 1, "no other fields")
    check(try store.captureID(id) == fileFields["id"] as? String, "meta records the id")
    check(try store.carriesFile(id), "meta records the file")
    try store.acknowledge(id)
  }
  check(try store.pending() == "[]", "all settled")
}

test("file captures are listed as such; others aren't") { dir in
  let store = CaptureStore(directory: dir)
  let plain = try store.enqueue(payload)
  let file = try store.enqueue(fields: fileFields, file: try scratchFile(dir.appendingPathComponent("in"), Data("%PDF-1.7".utf8)))
  let viaJS = try store.enqueue(#"{"capturedAt":"2026-10-29T14:06","file":"JVBERi0=","fileType":"application/pdf","fileName":"a.pdf","via":"share"}"#)
  let items = try JSONSerialization.jsonObject(with: Data(store.pending().utf8)) as! [[String: Any]]
  let flagged = Dictionary(uniqueKeysWithValues: items.map { ($0["id"] as! String, $0["file"] as? Bool) })
  check(flagged[plain] == .some(nil), "a URL capture has no file flag")
  check(flagged[file] == .some(true) && flagged[viaJS] == .some(true), "both file enqueues are flagged: \(flagged)")
  check(try !store.carriesFile(plain) && store.carriesFile(viaJS), "carriesFile agrees")
}

test("a file enqueue generates a missing id and refuses bad fields, leaving nothing") { dir in
  let store = CaptureStore(directory: dir)
  let file = try scratchFile(dir.appendingPathComponent("in"), Data("%PDF-1.7".utf8))
  var fields = fileFields
  fields["id"] = nil
  let id = try store.enqueue(fields: fields, file: file)
  check(isUUID(payloadID(try store.read(id))), "generated")
  try store.acknowledge(id)
  for bad: [String: Any] in [
    fileFields.merging(["id": "not-a-uuid"]) { $1 },
    fileFields.merging(["file": "x"]) { $1 },
    fileFields.filter { $0.key != "capturedAt" },
  ] {
    check(throwsError(.invalidPayload) { _ = try store.enqueue(fields: bad, file: file) }, "refused: \(bad.keys.sorted())")
  }
  check(throwsError(.invalidPayload) { _ = try store.enqueue(fields: fileFields, file: dir) }, "a folder isn't a file")
  check(try store.pending() == "[]", "nothing queued")
  check(names(dir.appendingPathComponent("captures")).isEmpty, "no temp files")
}

test("files over 50 MiB are refused before reading them") { dir in
  let store = CaptureStore(directory: dir)
  let file = try scratchFile(dir.appendingPathComponent("in"), Data())
  let handle = try FileHandle(forWritingTo: file)
  try handle.truncate(atOffset: UInt64(CaptureStore.maxFileBytes + 1)) // sparse
  try handle.close()
  check(throwsError(.tooLarge) { _ = try store.enqueue(fields: fileFields, file: file) }, "too large")
  check(names(dir.appendingPathComponent("captures")).isEmpty, "nothing written")
  let big = Data(count: CaptureStore.maxPayloadBytes + 1)
  check(throwsError(.tooLarge) { _ = try store.enqueue(big, capturedAt: "x") }, "the 22 MiB bound still holds without a file")
}

test("a 50 MiB file streams into a payload within the Mac's limit") { dir in
  let store = CaptureStore(directory: dir)
  let file = try scratchFile(dir.appendingPathComponent("in"), Data(count: CaptureStore.maxFileBytes))
  let started = Date()
  let id = try store.enqueue(fields: fileFields, file: file)
  let elapsed = Date().timeIntervalSince(started)
  let size = try store.payloadURL(id).resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
  check(size > CaptureStore.maxFileBytes / 3 * 4 && size <= CaptureStore.maxFilePayloadBytes, "size \(size)")
  check(CapturePayload.scan(try Data(contentsOf: store.payloadURL(id), options: .alwaysMapped))?.capturedAt == "2026-10-29T14:05", "one well-formed object")
  print("     (50 MiB file enqueue: \(Int(elapsed * 1000)) ms)")
  // In a fresh process, so earlier tests' allocations don't count: the file
  // and its encoding never sit whole in memory (the extension's limit is ~120 MB).
  let pipe = Pipe()
  let child = Process()
  child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
  child.arguments = ["enqueue-file", dir.path, file.path]
  child.standardOutput = pipe
  try child.run()
  let output = pipe.fileHandleForReading.readDataToEndOfFile()
  child.waitUntilExit()
  let peak = Int(String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)) ?? .max
  check(child.terminationStatus == 0 && peak < 32 * 1024 * 1024, "peak resident \(peak) bytes")
  print("     (50 MiB file enqueue peak resident: \(peak / 1024 / 1024) MiB)")
}

test("the extension's upload leaves file captures to the app") { dir in
  let store = CaptureStore(directory: dir)
  let id = try store.enqueue(fields: fileFields, file: try scratchFile(dir.appendingPathComponent("in"), Data("%PDF-1.7".utf8)))
  let delivery = CaptureDelivery(identifier: "test", store: store, pairing: { CapturePairing(url: "http://127.0.0.1:9", token: "t") })
  check(throwsError(.needsApp) { try delivery.start(id: id) }, "needs the app")
  check(try store.claim(id), "left unclaimed for the app")
}

print(failures == 0 ? "\nall passed" : "\n\(failures) failure(s)")
exit(failures == 0 ? 0 : 1)
