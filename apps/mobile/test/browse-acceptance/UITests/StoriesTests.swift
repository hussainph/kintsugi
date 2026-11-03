import XCTest

/// KI-94. Run against the headless phone server's eight-item sample Feed.
/// SHOTS optionally saves the rendered screens; CONTROL optionally asks the
/// outer runner to capture the same scenes with simctl (ready/done files).
final class StoriesTests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "dev.phalasiya.kintsugi")
  let env = ProcessInfo.processInfo.environment

  override func setUpWithError() throws { continueAfterFailure = false }

  func testStories() throws {
    let approval = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Open"].firstMatch
    if approval.waitForExistence(timeout: 3) { approval.tap() }
    app.activate()
    let home = app.buttons["open-feed"]
    if home.waitForExistence(timeout: 10) { home.tap() }
    let story = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "feed-story-", "Mending")).firstMatch
    XCTAssertTrue(story.waitForExistence(timeout: 45), "no grouped story in the Feed")
    shot("feed")

    let like = app.buttons["Like"].firstMatch
    if like.exists { like.tap() }
    sleep(2)
    XCTAssertFalse(app.otherElements["toast"].exists, "a like showed ranking feedback")
    let why = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "feed-why-")).firstMatch
    why.tap()
    XCTAssertTrue(app.otherElements["feed-reasons"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["Learning"].exists)
    shot("feed-reasons")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.9)).tap()

    story.tap()
    XCTAssertTrue(app.buttons["Discuss"].waitForExistence(timeout: 10))
    shot("story-long-summary")
    let source = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "story-source-")).firstMatch
    var scrolls = 0
    while !source.isHittable && scrolls < 12 { app.swipeUp(); scrolls += 1 }
    XCTAssertTrue(source.isHittable, "no compact source strip after the summary")
    shot("story-sources")
    source.press(forDuration: 1.2)
    let open = app.buttons["Open"].firstMatch
    XCTAssertTrue(open.waitForExistence(timeout: 5) || app.menuItems["Open"].exists, "no native source context menu")
    shot("source-menu")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.3)).tap()
    let headerWhy = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "feed-why-")).firstMatch
    headerWhy.tap()
    XCTAssertTrue(app.otherElements["feed-reasons"].waitForExistence(timeout: 5))
    shot("story-reasons")
  }

  private func shot(_ name: String) {
    sleep(1)
    if let dir = env["SHOTS"] {
      try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
    }
    if let control = env["CONTROL"] {
      let ready = control + "/ready"
      try? name.write(toFile: ready, atomically: true, encoding: .utf8)
      let done = control + "/done"
      let end = Date().addingTimeInterval(20)
      while !FileManager.default.fileExists(atPath: done) && Date() < end { Thread.sleep(forTimeInterval: 0.2) }
      try? FileManager.default.removeItem(atPath: done)
    }
  }
}
