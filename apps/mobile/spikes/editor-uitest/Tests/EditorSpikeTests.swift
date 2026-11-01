import XCTest

/// KI-28: drives kintsugi://editor-spike in the installed Kintsugi debug build
/// with real touches and the real software keyboard, saving screenshots and
/// the on-screen metrics line to $SPIKE_OUT (passed as TEST_RUNNER_SPIKE_OUT).
final class EditorSpikeTests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "dev.phalasiya.kintsugi")
  var out: URL!
  var log = ""

  override func setUp() {
    continueAfterFailure = true
    let dir = ProcessInfo.processInfo.environment["SPIKE_OUT"] ?? NSTemporaryDirectory()
    out = URL(fileURLWithPath: dir)
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
  }

  override func tearDown() {
    let file = out.appendingPathComponent("\(name.replacingOccurrences(of: " ", with: "_")).log")
    try? log.write(to: file, atomically: true, encoding: .utf8)
  }

  func note(_ line: String) {
    log += line + "\n"
    print("[spike] \(line)")
  }

  func shot(_ label: String) {
    let png = XCUIScreen.main.screenshot().pngRepresentation
    try? png.write(to: out.appendingPathComponent("\(label).png"))
  }

  var hud: XCUIElement { app.staticTexts["spike-metrics"] }

  func metrics() -> String { hud.exists ? hud.label : "(no hud)" }

  /// Opens the spike screen and waits until the editor has reported in.
  func open(_ doc: String, extra: String = "") {
    let url = URL(string: "kintsugi://editor-spike?doc=\(doc)\(extra)")!
    // Cold start each time so every test gets a fresh screen and WebView.
    app.terminate()
    let started = Date()
    XCUIDevice.shared.system.open(url)
    // A system "Open in Kintsugi?" prompt may appear the first time.
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let openButton = springboard.buttons["Open"]
    if openButton.waitForExistence(timeout: 3) { openButton.tap() }
    XCTAssertTrue(hud.waitForExistence(timeout: 300), "spike screen did not appear")
    let ready = NSPredicate(format: "label CONTAINS 'chars'")
    expectation(for: ready, evaluatedWith: hud)
    // Generous: a cold Metro dev server bundles the DOM component on first open.
    waitForExpectations(timeout: 300)
    note("\(doc): open→ready wall \(Int(Date().timeIntervalSince(started) * 1000))ms (includes deep link + nav)")
    note("\(doc): \(metrics())")
  }

  var editor: XCUIElement { app.webViews.firstMatch }

  func tapEditor(atY y: CGFloat) {
    editor.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y)).tap()
  }

  func waitKeyboard() -> Bool { app.keyboards.firstMatch.waitForExistence(timeout: 10) }

  func testShortDocument() {
    open("short")
    shot("short-01-open")

    // Tap into the body: keyboard, caret, accessory bar, native toolbar.
    tapEditor(atY: 0.45)
    note("keyboard shown: \(waitKeyboard())")
    note("native toolbar shown: \(app.otherElements["spike-toolbar"].waitForExistence(timeout: 3))")
    sleep(1)
    shot("short-02-keyboard")

    // Real keyboard typing; XCUITest types as fast as the keyboard accepts.
    let sentence = "Typed on the phone keyboard, one key at a time. "
    let t0 = Date()
    app.typeText(sentence + sentence)
    let per = Date().timeIntervalSince(t0) * 1000 / Double(sentence.count * 2)
    note("typeText: \(sentence.count * 2) chars, \(String(format: "%.1f", per))ms/char wall (XCUITest-bound)")
    sleep(1)
    note("after typing: \(metrics())")
    shot("short-03-typed")

    // Autocorrect: a common misspelling followed by a space.
    app.typeText("teh quick wrod ")
    sleep(1)
    shot("short-04-autocorrect")

    // Undo / redo through the native toolbar (bridge → CodeMirror history).
    for _ in 0..<3 { app.buttons["spike-undo"].tap() }
    sleep(1)
    shot("short-05-undo3")
    app.buttons["spike-redo"].tap()
    sleep(1)
    shot("short-06-redo1")

    // Toolbar actions that change the document.
    app.typeText("bold")
    app.buttons["spike-link"].tap()
    sleep(1)
    shot("short-07-link-picker")
    app.typeText("Kin")
    sleep(1)
    shot("short-08-link-picker-query")

    // Synthetic per-keystroke bench (200 single-character dispatches).
    app.buttons["spike-bench"].tap()
    let benched = NSPredicate(format: "label CONTAINS 'bench'")
    expectation(for: benched, evaluatedWith: hud)
    waitForExpectations(timeout: 60)
    note("bench: \(metrics())")

    app.buttons["spike-done"].tap()
    sleep(1)
    shot("short-09-done")
  }

  func testSelection() {
    open("short")
    // Long-press a word in the first body paragraph: loupe, selection, menu.
    let word = editor.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.32))
    word.press(forDuration: 1.2)
    sleep(1)
    shot("select-01-longpress")
    note("after long press: \(metrics())")
    // Double-tap selects a word; native handles + edit menu are expected.
    word.doubleTap()
    sleep(1)
    shot("select-02-doubletap")
    app.buttons["spike-done"].tap()
    app.buttons["spike-report"].tap()
    sleep(1)
    note("after double tap: \(metrics())")
    let menu = app.menuItems.allElementsBoundByIndex.map(\.label)
    note("edit menu items: \(menu)")
  }

  func testLongDocument() { longDocument("long") }

  func testHugeDocument() { longDocument("huge") }

  func longDocument(_ doc: String) {
    open(doc)
    shot("\(doc)-01-open")

    // Real touch scrolling: fling up a few times.
    for _ in 0..<6 { editor.swipeUp(velocity: .fast) }
    sleep(1)
    app.buttons["spike-report"].tap()
    sleep(1)
    note("\(doc) after 6 flings: \(metrics())")
    shot("\(doc)-02-flung")

    // Programmatic 4s scroll through the whole document.
    app.buttons["spike-scroll"].tap()
    sleep(6)
    note("\(doc) scroll bench: \(metrics())")

    // Type near the end of a long document.
    app.buttons["spike-focus"].tap()
    _ = waitKeyboard()
    sleep(1)
    app.typeText("Typing at the end of a long document should feel the same. ")
    sleep(1)
    shot("\(doc)-03-typing-end")
    app.buttons["spike-bench"].tap()
    let benched = NSPredicate(format: "label CONTAINS 'bench'")
    expectation(for: benched, evaluatedWith: hud)
    waitForExpectations(timeout: 120)
    sleep(1)
    note("\(doc) bench: \(metrics())")
    shot("\(doc)-04-bench")
    app.buttons["spike-done"].tap()
  }

  /// Autocorrect, predictions and auto-capitalisation turned back on (&ac=1).
  func testAutocorrect() {
    open("short", extra: "&ac=1")
    tapEditor(atY: 0.45)
    _ = waitKeyboard()
    sleep(1)
    shot("ac-01-keyboard")
    app.typeText("\n\nteh quick wrod ")
    sleep(1)
    shot("ac-02-typed")
    app.typeText("i think it works. this is fine ")
    sleep(1)
    shot("ac-03-capitals")
    app.buttons["spike-undo"].tap()
    sleep(1)
    shot("ac-04-undo")
  }

  /// The setup a real phone editor would ship: keyboard text features on,
  /// the WebView's accessory bar off, the native toolbar above the keyboard.
  func testShipConfig() {
    open("long", extra: "&ac=1&acc=0")
    shot("ship-01-open")
    tapEditor(atY: 0.6)
    _ = waitKeyboard()
    sleep(1)
    shot("ship-02-keyboard")
    app.typeText("A sentence typed with predictions on. ")
    sleep(1)
    shot("ship-03-typed")
    app.buttons["spike-undo"].tap()
    sleep(1)
    shot("ship-04-undo")
    app.buttons["spike-bench"].tap()
    let benched = NSPredicate(format: "label CONTAINS 'bench'")
    expectation(for: benched, evaluatedWith: hud)
    waitForExpectations(timeout: 120)
    note("ship bench: \(metrics())")
    app.buttons["spike-done"].tap()
    sleep(1)
    shot("ship-05-done")
  }

  /// Same screen with the WebView's own accessory bar hidden.
  func testNoAccessoryBar() {
    open("short", extra: "&acc=0")
    tapEditor(atY: 0.45)
    _ = waitKeyboard()
    sleep(1)
    shot("noacc-01-keyboard")
  }

  /// Just the screen with the keyboard up, for appearance/width comparisons.
  func testAppearance() {
    open("short")
    shot("appearance-01-open")
    tapEditor(atY: 0.45)
    _ = waitKeyboard()
    sleep(1)
    shot("appearance-02-keyboard")
  }
}
