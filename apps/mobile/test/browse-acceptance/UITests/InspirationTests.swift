import XCTest

/// KI-3 on the phone, after BrowseTests' first-launch approval (run.sh with
/// ONLY=inspiration): the Inspiration grid with its images, search, a clip's
/// detail with its source link and the source fetched on demand, a note
/// edited on the phone landing in the Mac's vault, and the grid still there
/// once the Mac is gone. The test runner shares the host's file system, so
/// it reads the scratch vault (`VAULT`) and asks run.sh to stop the Mac
/// through a file in `CONTROL`.
final class InspirationTests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "dev.phalasiya.kintsugi")
  let env = ProcessInfo.processInfo.environment

  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  func test1GridSearchDetailAndNotes() throws {
    app.activate()
    let entry = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Inspiration, 7 clips")).firstMatch
    XCTAssertTrue(entry.waitForExistence(timeout: 45), "the home screen never listed the clips")
    shot("01-home")
    entry.tap()

    XCTAssertTrue(card("Why we sleep").waitForExistence(timeout: 15))
    XCTAssertTrue(card("A thought").exists, "the note clip has no card")
    // Images arrive in the background.
    sleep(4)
    shot("02-grid")

    // Search: every word, across titles, summaries, tags and notes.
    let search = app.searchFields.firstMatch
    tap(search)
    search.typeText("repair")
    XCTAssertTrue(card("Golden joinery").waitForExistence(timeout: 10))
    XCTAssertFalse(card("Why we sleep").exists, "a clip without “repair” passed the search")
    shot("03-search-repair")
    search.typeText(" bowl")
    XCTAssertTrue(card("Golden joinery").waitForExistence(timeout: 5), "own text isn’t searched")
    if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() }
    XCTAssertTrue(card("Why we sleep").waitForExistence(timeout: 10))

    // Detail: source link, summary, notes and the source on demand.
    tap(card("Why we sleep"))
    XCTAssertTrue(app.buttons["Open the source"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Summary · machine-made"].exists)
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "tired mind")).firstMatch.exists)
    shot("04-detail")
    app.swipeUp()
    tap(app.buttons["Show the source"])
    let source = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "night-shift workers")).firstMatch
    XCTAssertTrue(source.waitForExistence(timeout: 10), "the source never came from the Mac")
    shot("05-source-on-demand")
    app.swipeDown()
    app.swipeDown()

    // Notes, in the same editor path as documents.
    tap(app.buttons["Edit your notes"])
    let notes = app.textViews["Your notes"]
    XCTAssertTrue(notes.waitForExistence(timeout: 10))
    // Below the text, so the caret lands at its end.
    notes.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.97)).tap()
    notes.typeText("\nEdited on the phone, on the train.")
    shot("06-notes-editing")
    app.navigationBars.buttons.firstMatch.tap()
    let vault = try XCTUnwrap(env["VAULT"])
    let clip = URL(fileURLWithPath: vault).appendingPathComponent("inspiration/why-we-sleep.md")
    XCTAssertTrue(wait(timeout: 15) { ((try? String(contentsOf: clip, encoding: .utf8)) ?? "").contains("Edited on the phone, on the train.") },
                  "the note never reached the Mac’s vault")
    let saved = try String(contentsOf: clip, encoding: .utf8)
    XCTAssertTrue(saved.contains("night-shift workers"), "the note edit lost the clip’s source")
    XCTAssertTrue(saved.contains("tired mind"), "the note edit lost the earlier note")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "on the train")).firstMatch.waitForExistence(timeout: 5))
    shot("07-detail-after-edit")
  }

  func test2OfflineBrowsing() throws {
    // run.sh stops the Mac when asked.
    let control = try XCTUnwrap(env["CONTROL"])
    FileManager.default.createFile(atPath: control + "/stop-mac", contents: nil)
    XCTAssertTrue(wait(timeout: 20) { FileManager.default.fileExists(atPath: control + "/mac-stopped") })
    app.terminate()
    app.activate()
    let entry = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Inspiration, 7 clips")).firstMatch
    // The app may reopen inside Inspiration's stack; back out to home first.
    if !entry.waitForExistence(timeout: 10) {
      while app.navigationBars.buttons.firstMatch.exists && !entry.exists { app.navigationBars.buttons.firstMatch.tap() }
    }
    tap(entry)
    XCTAssertTrue(card("Why we sleep").waitForExistence(timeout: 10), "the cards aren’t kept on the phone")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Your Mac is offline")).firstMatch.waitForExistence(timeout: 15))
    shot("08-grid-offline")
    tap(card("Why we sleep"))
    tap(app.buttons["Show the source"])
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "The source is kept on your Mac")).firstMatch.waitForExistence(timeout: 15))
    shot("09-detail-offline")
  }

  /// A card is read as "Open <title, link or kind>".
  private func card(_ label: String) -> XCUIElement {
    app.buttons["Open \(label)"].firstMatch
  }

  private func tap(_ element: XCUIElement) {
    XCTAssertTrue(element.waitForExistence(timeout: 10), "missing \(element)")
    element.tap()
  }

  private func wait(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      if condition() { return true }
      RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    }
    return condition()
  }

  private func shot(_ name: String) {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    if let dir = env["SHOTS"] {
      try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("inspiration-\(name).png"))
    }
  }
}
