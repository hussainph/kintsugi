// Standalone tests for ios/Shared, compiled with it by run.sh (no Xcode project).
// Scratch directories go under $CAPTURE_TEST_DIR (run.sh: apps/mobile/.expo).
// The binary doubles as a child process for the cross-process cases:
//   capture-tests claim <dir> <id>    exits 0 if it won the claim, 1 if not
//   capture-tests die-locked <dir>    SIGKILLs itself while holding the lock
import Foundation

let arguments = CommandLine.arguments
if arguments.count >= 3 {
  let store = CaptureStore(directory: URL(fileURLWithPath: arguments[2]))
  switch arguments[1] {
  case "claim":
    exit((try? store.claim(arguments[3])) == true ? 0 : 1)
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

let payload = #"{"url":"https://example.com/a","note":"é ✨","capturedAt":"2026-10-29T14:05","via":"share"}"#

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
  let fits = String(repeating: "a", count: CaptureStore.maxPayloadBytes - 64)
  check(try !store.enqueue(#"{"capturedAt":"x","text":"\#(fits)"}"#).isEmpty, "just under fits")
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

print(failures == 0 ? "\nall passed" : "\n\(failures) failure(s)")
exit(failures == 0 ? 0 : 1)
