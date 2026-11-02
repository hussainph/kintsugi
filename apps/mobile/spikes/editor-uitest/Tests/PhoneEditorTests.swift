import XCTest

/// KI-36: drives the phone editor behind its setting (Home → ⋯ → New editor)
/// in the installed debug build, paired with a scratch `phone_dev_server`
/// vault (see README.md). Screenshots and notes go to $SPIKE_OUT.
final class PhoneEditorTests: XCTestCase {
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

  let started = Date()
  func note(_ line: String) {
    let line = String(format: "%6.1fs ", Date().timeIntervalSince(started)) + line
    log += line + "\n"
    print("[ki36] \(line)")
    let file = out.appendingPathComponent("\(name.replacingOccurrences(of: " ", with: "_")).log")
    try? log.write(to: file, atomically: true, encoding: .utf8)
  }

  func shot(_ label: String) {
    note("shot \(label)")
    let png = XCUIScreen.main.screenshot().pngRepresentation
    try? png.write(to: out.appendingPathComponent("\(label).png"))
  }

  var editor: XCUIElement { app.webViews.firstMatch }

  /// The editor's recent events (development builds; see EditorHost).
  func editorLog(_ step: String) {
    let element = app.descendants(matching: .any)["editor-log"]
    note("log after \(step): \(element.exists ? element.label : "(none)")")
  }
  func toolbar(_ id: String) -> XCUIElement { app.buttons["editor-toolbar-\(id)"] }
  func waitKeyboard() -> Bool { app.keyboards.firstMatch.waitForExistence(timeout: 10) }

  /// Launches to Home (going back from any document it restores).
  func home() {
    note("home")
    app.terminate()
    app.activate()
    // The app reopens the last document; go back from it once it's up.
    _ = app.buttons["New note"].waitForExistence(timeout: 60)
    sleep(5)
    // (Home stays in the tree under a document, so look for the back button.)
    for _ in 0..<3 {
      let back = app.navigationBars.buttons.element(boundBy: 0)
      guard back.exists, back.label != "New note" else { break }
      back.tap()
      sleep(2)
    }
    XCTAssertTrue(app.buttons["New note"].waitForExistence(timeout: 30), "Home did not appear")
  }

  /// Home → ⋯ → New editor, to `on`.
  func setNewEditor(_ on: Bool) {
    note("setNewEditor \(on)")
    let more = app.navigationBars.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'more' OR identifier CONTAINS[c] 'ellipsis'")).firstMatch
    XCTAssertTrue(more.waitForExistence(timeout: 10), "no ⋯ menu: \(app.navigationBars.firstMatch.debugDescription)")
    more.tap()
    sleep(1)
    let item = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'New editor'")).firstMatch
    if !item.waitForExistence(timeout: 5) {
      note("menu: \(app.debugDescription)")
      XCTFail("no New editor item")
      return
    }
    note("menu item: \(item.debugDescription.prefix(400))")
    let selected = item.isSelected || (item.value as? String) == "1"
    // Already right: close the menu by tapping clear of the rows.
    if selected != on { item.tap() } else { tapScreen(x: 60, y: 760) }
    sleep(1)
  }

  /// Opens a document from Home, going into its folder first (KI-29 lists
  /// folders on Home).
  func open(_ title: String, in folder: String? = nil) {
    note("open \(title)")
    // Home's status lines can push the rows down as they arrive.
    sleep(3)
    if let folder {
      let entry = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", folder)).firstMatch
      if entry.waitForExistence(timeout: 10) { entry.tap() }
      sleep(2)
    }
    let row = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 20), "no row \(title)")
    row.tap()
    XCTAssertTrue(editor.waitForExistence(timeout: 60), "editor did not appear")
  }

  /// A tap at a point on screen. Web content's accessibility frames can be
  /// stale for a WebView that moves, so taps go by screen position instead.
  func tapScreen(x: CGFloat = 200, y: CGFloat) {
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
  }

  /// Back to Home (from a document in a folder, twice).
  func goBack() {
    for _ in 0..<2 {
      let back = app.navigationBars.buttons.element(boundBy: 0)
      guard back.exists, back.label != "New note" else { break }
      back.tap()
      sleep(1)
    }
  }

  /// Diagnostics: how long an accessibility query takes right now.
  func testProbe() {
    home()
    sleep(3)
    shot("probe-1-home")
    setNewEditor(true)
    sleep(3)
    shot("probe-2-setting")
    open("Mending with gold", in: "posts")
    sleep(3)
    shot("probe-3-open")
    note("activated")
    note("buttons: \(app.navigationBars.buttons.count)")
    note("texts: \(app.staticTexts.count)")
    note("webviews: \(app.webViews.count)")
    note(app.debugDescription)
  }

  /// Pairs with the scratch dev server (`phone_dev_server`, fixed test token).
  func testPair() {
    app.activate()
    XCUIDevice.shared.system.open(URL(string: "kintsugi://pair?url=http%3A%2F%2F127.0.0.1%3A47475&token=TEST-TOKEN")!)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    if springboard.buttons["Open"].waitForExistence(timeout: 5) { springboard.buttons["Open"].tap() }
    XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 60), "Home did not appear after pairing")
    sleep(3)
    shot("00-paired-home")
  }

  /// The six KI-36 items, as far as a Simulator can show them.
  func testNewEditor() {
    home()
    setNewEditor(true)
    shot("01-home-setting-on")

    // Opening: the editor is warm, so the text is there as the screen lands.
    open("Mending with gold", in: "posts")
    sleep(2)
    editorLog("open")
    shot("02-open")

    // Typing, with the native toolbar in the keyboard.
    note("editor frame \(editor.frame)")
    // "something to hide." at the end of the first paragraph.
    tapScreen(x: 330, y: 293)
    XCTAssertTrue(waitKeyboard(), "keyboard did not come up")
    XCTAssertTrue(toolbar("undo").waitForExistence(timeout: 5), "native toolbar missing")
    editorLog("tap")
    app.typeText("Typed on the phone. ")
    sleep(1)
    shot("03-typing-toolbar")
    toolbar("undo").tap()
    sleep(1)
    shot("04-undo")
    toolbar("redo").tap()

    // The [[ picker, phone width, rows to tap.
    toolbar("link").tap()
    sleep(1)
    app.typeText("margins")
    sleep(1)
    shot("05-link-picker")
    editorLog("picker")
    // The picker's one row, where the page says it is: accessibility frames
    // inside the WebView don't follow CodeMirror's own scrolling.
    let log = app.descendants(matching: .any)["editor-log"].label
    if let match = log.range(of: #"picker row (\d+),(\d+)(?!.*picker row)"#, options: .regularExpression) {
      let numbers = log[match].dropFirst("picker row ".count).split(separator: ",").compactMap { Double($0) }
      note("picker row at \(numbers)")
      tapScreen(x: CGFloat(numbers[0]), y: editor.frame.minY + CGFloat(numbers[1]))
    } else {
      note("picker row not reported")
    }
    sleep(1)
    editorLog("picker tap")
    shot("06-link-inserted")

    // The caret stays above the keyboard at the end of the document.
    for _ in 0..<4 { editor.swipeUp(velocity: .fast) }
    sleep(1)
    tapScreen(y: 470)
    sleep(1)
    app.typeText("\nThe last line stays in view. ")
    sleep(1)
    shot("07-caret-above-keyboard")
    toolbar("done").tap()
    sleep(1)
    shot("08-keyboard-hidden")
    goBack()

    // A second document, then the first again: one warm WebView.
    open("On writing in the margins", in: "drafts")
    sleep(1)
    shot("09-second-doc")
    goBack()
    open("Mending with gold", in: "posts")
    sleep(1)
    shot("10-first-again")
    goBack()

    // A new note: the keyboard comes up straight away.
    app.navigationBars.buttons["New note"].tap()
    let raised = waitKeyboard()
    editorLog("new note")
    XCTAssertTrue(raised, "keyboard did not come up for a new note")
    app.typeText("A note from the train\nwritten in the new editor.")
    sleep(1)
    shot("11-new-note")
    goBack()
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'inbox'")).firstMatch.waitForExistence(timeout: 10), "the new note's inbox is not listed")
    shot("12-home-after-note")
  }

  /// Where a tap puts the caret (diagnostics).
  func testTapCaret() {
    home()
    open("Mending with gold", in: "posts")
    sleep(2)
    tapScreen(x: 330, y: 293)
    _ = waitKeyboard()
    sleep(1)
    editorLog("tap")
    app.typeText("X")
    sleep(1)
    editorLog("typed")
    shot("tap-caret")
    toolbar("undo").tap()
    toolbar("done").tap()
    goBack()
  }

  /// Leaves a document open for `SYNC_WAIT` seconds while the shell edits it
  /// on the "Mac" (the scratch vault); Home's sync brings the change in.
  func testSyncedTextArrives() {
    home()
    setNewEditor(true)
    open("Mending with gold", in: "posts")
    sleep(2)
    shot("20-before-sync")
    let marker = editor.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Edited on the Mac'")).firstMatch
    let arrived = marker.waitForExistence(timeout: 120)
    note("synced text arrived: \(arrived)")
    sleep(1)
    shot("21-after-sync")
    XCTAssertTrue(arrived)
  }

  /// Offline, the phone and the Mac change the same line: the banner asks.
  func testCollisionBanner() {
    home()
    setNewEditor(true)
    open("Mending with gold", in: "posts")
    tapScreen(x: 330, y: 293)
    XCTAssertTrue(waitKeyboard())
    app.typeText(" PHONE")
    toolbar("done").tap()
    sleep(1)
    shot("29-typed-offline")
    sleep(1)
    let banner = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Which version should stay'")).firstMatch
    let shown = banner.waitForExistence(timeout: 150)
    note("collision banner: \(shown)")
    shot("30-collision")
    XCTAssertTrue(shown)
    app.buttons["Keep this phone’s"].tap()
    sleep(2)
    shot("31-kept-phone")
  }

  /// The same editor in Expo Go (no Kintsugi native modules): sample notes,
  /// the React Native toolbar on the keyboard. Metro must be running.
  func testExpoGo() {
    let go = XCUIApplication(bundleIdentifier: "host.exp.Exponent")
    go.terminate()
    XCUIDevice.shared.system.open(URL(string: "exp://127.0.0.1:8081")!)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    if springboard.buttons["Open"].waitForExistence(timeout: 5) { springboard.buttons["Open"].tap() }
    // First launch: Expo Go's own onboarding.
    for label in ["Continue", "Got it", "OK"] where go.buttons[label].waitForExistence(timeout: 3) { go.buttons[label].tap() }
    let home = go.buttons["New note"]
    if !home.waitForExistence(timeout: 5) {
      // Welcome: wait for it to load (the bundle comes from Metro), then
      // Expo Go's developer-menu introduction, then the sample button.
      XCTAssertTrue(go.staticTexts["Kintsugi"].waitForExistence(timeout: 180), "Welcome did not load in Expo Go")
      if go.buttons["Continue"].waitForExistence(timeout: 10) { go.buttons["Continue"].tap() }
      sleep(1)
      shot("go-01-welcome")
      // "Try the editor on sample notes" (see go-01-welcome.png).
      go.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 150, dy: 527)).tap()
    }
    XCTAssertTrue(home.waitForExistence(timeout: 30), "Home did not appear")
    sleep(3)
    shot("go-02-home")
    // The sample notes are in inbox/ (see go-02-home.png).
    go.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 165, dy: 368)).tap()
    sleep(2)
    shot("go-02b-inbox")
    let row = go.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Mending with gold'")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.tap()
    XCTAssertTrue(go.webViews.firstMatch.waitForExistence(timeout: 120), "editor did not appear")
    sleep(4)
    shot("go-03-open")
    go.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 330, dy: 293)).tap()
    XCTAssertTrue(go.keyboards.firstMatch.waitForExistence(timeout: 10), "keyboard did not come up")
    sleep(1)
    go.typeText(" Typed in Expo Go.")
    sleep(1)
    let undo = go.buttons["editor-toolbar-undo"]
    note("fallback toolbar: \(undo.exists)")
    shot("go-04-typing-toolbar")
    go.buttons["editor-toolbar-link"].tap()
    sleep(1)
    go.typeText("writing")
    sleep(1)
    shot("go-05-picker")
    go.buttons["editor-toolbar-done"].tap()
    sleep(1)
    shot("go-06-done")
  }
}
