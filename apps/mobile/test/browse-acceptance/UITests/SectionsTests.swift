import XCTest

/// KI-42 on the phone, after BrowseTests' first-launch approval (run.sh with
/// ONLY=sections). The Mac is the headless app on a scratch vault with a
/// sample Feed and Kin's scripted mock model (`phone_dev_server` built with
/// the headless feature): the Feed with Picked for you, a like, a note and
/// a save landing in the vault, Discuss opening Kin with the item as a chip
/// and Kin answering, Ideas asked for, opened and adopted into a new draft
/// in the vault, then the Mac stopped: Kin says so and keeps the message,
/// and the Feed stays readable.
final class SectionsTests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "dev.phalasiya.kintsugi")
  let env = ProcessInfo.processInfo.environment

  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  func test1FeedKinAndIdeas() throws {
    app.activate()
    let feedEntry = button(beginning: "Feed, 8 items")
    XCTAssertTrue(feedEntry.waitForExistence(timeout: 60), "the home screen never listed the Feed")
    XCTAssertTrue(app.buttons["kin-avatar"].exists || app.otherElements["kin-avatar"].exists || button(beginning: "Kin").exists, "no Kin avatar")
    shot("01-home")
    tap(feedEntry)

    XCTAssertTrue(heading("Picked for you").waitForExistence(timeout: 15), "no Picked for you")
    XCTAssertTrue(heading("Newest").exists)
    shot("02-feed")

    // A like from the list: the toast says what it changed in Picked for you.
    tap(app.buttons["Like"].firstMatch)
    XCTAssertTrue(app.otherElements["toast"].waitForExistence(timeout: 15) || app.buttons["Undo"].waitForExistence(timeout: 5), "no toast after a like")
    shot("03-liked")

    // Read an item, note it and save it into Inspiration.
    tap(button(beginning: "Mending as a design method"))
    let text = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "visible repair")).firstMatch
    XCTAssertTrue(text.waitForExistence(timeout: 15), "the article never opened")
    let note = field("feed-note")
    tap(note)
    note.typeText("Seams as a method, not a flaw.")
    sleep(2)
    tap(app.buttons["Save"])
    let vault = URL(fileURLWithPath: try XCTUnwrap(env["VAULT"]))
    let clip = vault.appendingPathComponent("inspiration/mending-as-a-design-method.md")
    XCTAssertTrue(wait(timeout: 20) { ((try? String(contentsOf: clip, encoding: .utf8)) ?? "").contains("Seams as a method, not a flaw.") },
                  "the save (with its note) never reached the Mac’s vault")
    XCTAssertTrue(app.buttons["Saved"].waitForExistence(timeout: 10))
    shot("04-reader-noted-and-saved")

    // Discuss: Kin's chat, with the item attached as a chip.
    tap(app.buttons["Discuss"])
    XCTAssertTrue(button(beginning: "Remove Mending as a design method").waitForExistence(timeout: 10), "the item isn’t a context chip")
    let message = field("kin-message")
    tap(message)
    message.typeText("What does this say about repair?")
    shot("05-kin-with-chip")
    tap(app.buttons["Send"])
    let reply = app.otherElements.matching(NSPredicate(format: "label BEGINSWITH %@", "Kin:")).firstMatch
    XCTAssertTrue(reply.waitForExistence(timeout: 45), "Kin never answered")
    XCTAssertTrue(wait(timeout: 30) { !self.app.staticTexts["Kin is replying…"].exists })
    shot("06-kin-replied")
    tap(app.buttons["Done"])

    // Ideas: ask Kin for more, open one, adopt it.
    backToHome()
    tap(button(beginning: "Ideas,"))
    tap(app.buttons["Ask for more"])
    let idea = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "idea-")).firstMatch
    XCTAssertTrue(idea.waitForExistence(timeout: 60), "Kin’s ideas never came")
    shot("07-ideas")
    tap(idea)
    XCTAssertTrue(heading("Kin’s hunch").waitForExistence(timeout: 10))
    XCTAssertTrue(heading("Evidence").exists)
    shot("08-idea-open")
    let drafts = vault.appendingPathComponent("drafts")
    let before = Set((try? FileManager.default.contentsOfDirectory(atPath: drafts.path)) ?? [])
    tap(app.buttons["Adopt"])
    var made: String?
    XCTAssertTrue(wait(timeout: 20) {
      let now = Set((try? FileManager.default.contentsOfDirectory(atPath: drafts.path)) ?? [])
      made = now.subtracting(before).first
      return made != nil
    }, "Adopt made no draft on the Mac")
    let draft = try String(contentsOf: drafts.appendingPathComponent(made!), encoding: .utf8)
    XCTAssertTrue(draft.contains("ideas:") && draft.contains("from: kin"), "the draft doesn’t carry the idea")
    // The new draft opens on the phone.
    sleep(4)
    shot("09-adopted-draft")
  }

  func test2KinWithoutTheMac() throws {
    let control = try XCTUnwrap(env["CONTROL"])
    FileManager.default.createFile(atPath: control + "/stop-mac", contents: nil)
    XCTAssertTrue(wait(timeout: 20) { FileManager.default.fileExists(atPath: control + "/mac-stopped") })
    app.activate()
    backToHome()
    let avatar = app.buttons["kin-avatar"].exists ? app.buttons["kin-avatar"] : button(beginning: "Kin")
    tap(avatar)
    let message = field("kin-message")
    tap(message)
    message.typeText("Anything new on repair?")
    tap(app.buttons["Send"])
    let status = app.staticTexts["Your Mac is offline. One message waiting."]
    XCTAssertTrue(status.waitForExistence(timeout: 30), "Kin doesn’t say it needs the Mac")
    XCTAssertTrue(app.staticTexts["Waiting for your Mac"].waitForExistence(timeout: 10), "the message isn’t kept waiting")
    shot("10-kin-offline-waiting")
    tap(app.buttons["Done"])

    backToHome()
    tap(button(beginning: "Feed,"))
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Your Mac is offline")).firstMatch.waitForExistence(timeout: 20))
    XCTAssertTrue(button(beginning: "Gold in the cracks").exists || button(beginning: "Small sites").exists, "the Feed isn’t kept on the phone")
    shot("11-feed-offline")
  }

  private func backToHome() {
    let home = button(beginning: "Feed,")
    var tries = 0
    while !home.waitForExistence(timeout: 2) && tries < 6 {
      let back = app.navigationBars.buttons.firstMatch
      if back.exists { back.tap() } else { app.swipeDown(velocity: .fast) }
      tries += 1
    }
  }

  /// Headings are shown in capitals; match them however they read.
  private func heading(_ label: String) -> XCUIElement {
    app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", label)).firstMatch
  }

  /// A text input, by its test id, whatever kind of element it surfaces as.
  private func field(_ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  private func button(beginning label: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
  }

  private func tap(_ element: XCUIElement) {
    XCTAssertTrue(element.waitForExistence(timeout: 15), "missing \(element)")
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
      try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("sections-\(name).png"))
    }
  }
}
