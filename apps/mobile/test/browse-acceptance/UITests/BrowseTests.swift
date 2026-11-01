import XCTest

/// KI-29 on the phone, against the installed Kintsugi app paired with the
/// real phone API on a scratch vault (run.sh): folders browse, and the status
/// and tag chips filter. Screenshots go to `TEST_RUNNER_SHOTS` when set (the
/// simulator shares the host's file system), and are attached to the result.
final class BrowseTests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "dev.phalasiya.kintsugi")

  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  /// `simctl openurl` may ask before opening a custom scheme the first time.
  func test0ApproveOpen() {
    let open = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Open"].firstMatch
    if open.waitForExistence(timeout: 10) { open.tap() }
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
  }

  func test1BrowseAndFilter() throws {
    app.activate()
    let posts = folder("posts")
    XCTAssertTrue(posts.waitForExistence(timeout: 45), "the vault's folders never appeared")
    XCTAssertTrue(folder("notes").exists)
    shot("01-root-folders")

    // Status: drafts only, across every folder.
    tap(chip("Drafts"))
    XCTAssertTrue(doc("Kintsugi and gold").waitForExistence(timeout: 10))
    XCTAssertTrue(doc("Repair is a kind of attention").exists)
    XCTAssertFalse(doc("Attention has a cost").exists, "a complete note passed the drafts filter")
    shot("02-drafts")

    // And a tag: drafts tagged #craft.
    tap(chip("#craft"))
    XCTAssertTrue(doc("Glaze chemistry").waitForExistence(timeout: 10))
    XCTAssertFalse(doc("Kintsugi and gold").exists, "an untagged draft passed the #craft filter")
    shot("03-drafts-tagged-craft")

    // Complete instead of drafts: the complete #craft post.
    tap(chip("Complete"))
    XCTAssertTrue(doc("On craft and repair").waitForExistence(timeout: 10))
    XCTAssertFalse(doc("Glaze chemistry").exists)
    tap(chip("Clear"))
    XCTAssertTrue(folder("posts").waitForExistence(timeout: 10))

    // Folders nest.
    tap(folder("posts"))
    XCTAssertTrue(folder("series").waitForExistence(timeout: 10))
    XCTAssertTrue(doc("On craft and repair").exists)
    shot("04-posts-folder")
    tap(folder("series"))
    XCTAssertTrue(doc("Glaze chemistry").waitForExistence(timeout: 10))
    XCTAssertTrue(doc("Field notes: the long way home").exists)
    // The filter follows into a folder.
    tap(chip("#fire"))
    XCTAssertTrue(doc("Glaze chemistry").waitForExistence(timeout: 10))
    XCTAssertFalse(doc("Field notes: the long way home").exists)
    shot("05-series-folder-filtered")
    tap(chip("Clear"))
  }

  private func folder(_ name: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(name), folder")).firstMatch
  }

  /// A document row, read as "title, status, #tags".
  private func doc(_ title: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", title, "\(title),")).firstMatch
  }

  private func chip(_ label: String) -> XCUIElement {
    app.buttons[label].firstMatch
  }

  private func tap(_ element: XCUIElement) {
    XCTAssertTrue(element.waitForExistence(timeout: 10), "missing \(element)")
    element.tap()
  }

  private func shot(_ name: String) {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    if let dir = ProcessInfo.processInfo.environment["SHOTS"] {
      try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }
  }
}
