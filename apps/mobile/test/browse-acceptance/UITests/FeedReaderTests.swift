import XCTest

/// KI-105, against the real headless phone server's sample Feed.
/// CONTROL coordinates simctl light/dark screenshots without opening Simulator.
final class FeedReaderTests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "dev.phalasiya.kintsugi")
  let env = ProcessInfo.processInfo.environment

  override func setUpWithError() throws { continueAfterFailure = false }

  func testReaders() throws {
    let approval = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Open"].firstMatch
    if approval.waitForExistence(timeout: 3) { approval.tap() }
    app.activate()
    let home = app.buttons["open-feed"]
    if home.waitForExistence(timeout: 3) && home.isHittable { home.tap() }
    let mark = app.descendants(matching: .any).matching(identifier: "feed-summary-mark").firstMatch
    XCTAssertTrue(mark.waitForExistence(timeout: 120), "no summarised story in the sample Feed")
    XCTAssertTrue(mark.label.hasPrefix("Kin's summary of "))
    shot("feed-light")
    shot("feed-dark")

    let story = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "feed-story-")).firstMatch
    XCTAssertTrue(story.exists)
    story.tap()
    XCTAssertTrue(app.buttons["Discuss"].waitForExistence(timeout: 15))
    XCTAssertTrue(mark.exists, "the story header lost its summary mark")
    shot("story-light")
    shot("story-dark")
    app.navigationBars.buttons.firstMatch.tap()

    let title = env["ARTICLE_TITLE"] ?? "What Mending Workshop 2026 taught me about my own prices"
    let article = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "feed-item-", title)).firstMatch
    var scrolls = 0
    while !article.isHittable && scrolls < 12 { app.swipeUp(); scrolls += 1 }
    XCTAssertTrue(article.isHittable, "the personal post was grouped or is missing")
    article.tap()
    XCTAssertTrue(app.otherElements["feed-reader"].waitForExistence(timeout: 15))
    for text in ["What I counted", "the hours each repair took", "A repair you can't see is a repair nobody pays for.", "The bowl that started the ledger.", "=SUM(materials) + hours * rate"] {
      let element = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", text)).firstMatch
      XCTAssertTrue(element.exists, "missing Markdown content: \(text)")
    }
    XCTAssertFalse(app.scrollViews["feed-article"].descendants(matching: .any).matching(identifier: "feed-summary-mark").firstMatch.exists, "an author's article carries Kin's summary mark")
    shot("article-header-light")
    shot("article-header-dark")
    if env["COVERAGE_CHECK"] == "1" {
      let storyLink = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Night Shift")).firstMatch
      XCTAssertTrue(storyLink.exists, "no story coverage link")
      storyLink.tap()
      XCTAssertTrue(mark.waitForExistence(timeout: 15), "coverage did not open the story")
      app.navigationBars.buttons.firstMatch.tap()
      let itemLink = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Workshop Wire")).firstMatch
      XCTAssertTrue(itemLink.exists, "no item coverage link")
      itemLink.tap()
      XCTAssertTrue(app.staticTexts["Attention is the scarce material"].waitForExistence(timeout: 15), "coverage did not open the article")
      app.navigationBars.buttons.firstMatch.tap()
    }
    app.swipeUp()
    shot("article-body-light")
    shot("article-body-dark")
    app.swipeUp()
    shot("article-figure-light")
    shot("article-figure-dark")
  }

  private func shot(_ name: String) {
    guard let control = env["CONTROL"] else { return }
    try? name.write(toFile: control + "/ready", atomically: true, encoding: .utf8)
    let done = control + "/done"
    let end = Date().addingTimeInterval(45)
    while !FileManager.default.fileExists(atPath: done) && Date() < end { Thread.sleep(forTimeInterval: 0.2) }
    XCTAssertTrue(FileManager.default.fileExists(atPath: done), "simctl did not capture \(name)")
    try? FileManager.default.removeItem(atPath: done)
  }
}
