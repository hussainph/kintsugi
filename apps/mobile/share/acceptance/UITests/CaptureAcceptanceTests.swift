import XCTest

/// End-to-end acceptance for KI-2, driven through the *system* share sheet:
/// a separate host app shares a real item, the test picks the installed
/// Kintsugi extension, types a note and taps Save. What the capture contains,
/// where it is queued and what reached the Mac are asserted on the host by
/// `run.sh` (App Group container and the fake Mac's journal) — this test only
/// proves the system path and the extension's own UI.
///
/// Preconditions `run.sh` establishes (and this test checks where it can):
/// the real app with its embedded `KintsugiShare.appex` is installed, the app
/// is paired with the fake Mac and is *not* running, and the fake Mac answers.
final class CaptureAcceptanceTests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  /// simctl openurl can require first-use confirmation on iOS 27. Approve it
  /// through the real SpringBoard UI, without a Simulator viewer or a backdoor
  /// that writes the pairing directly into storage.
  func testApprovePairingLink() {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    attach("pairing-before", screenshot: true)
    let open = springboard.alerts.buttons["Open"].firstMatch
    if open.waitForExistence(timeout: 15) { open.tap() }
    let app = XCUIApplication(bundleIdentifier: Acceptance.kintsugiBundleIdentifier)
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: Acceptance.wait), "Pairing link did not open Kintsugi.")
    attach("pairing-app", screenshot: true)
  }

  func testURLShareWithNote() throws {
    try share(
      button: "share-url",
      launchEnvironment: ["SHARE_URL": Acceptance.page("url")],
      note: Acceptance.note,
      preview: "127.0.0.1"
    )
  }

  func testImageShareWithNote() throws {
    try share(
      button: "share-image",
      launchEnvironment: [:],
      note: Acceptance.note,
      preview: nil
    )
  }

  func testTextShare() throws {
    try share(
      button: "share-text",
      launchEnvironment: [:],
      note: nil,
      preview: "passage worth keeping"
    )
  }

  /// The phone's existing capture box must route a whole URL to clips, while
  /// ordinary prose retains the inbox action. This test does not write prose.
  func testPhoneURLCapture() {
    let app = XCUIApplication(bundleIdentifier: Acceptance.kintsugiBundleIdentifier)
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: Acceptance.wait))
    let input = app.textViews.firstMatch
    XCTAssertTrue(input.waitForExistence(timeout: Acceptance.wait), "The phone capture box is missing.")
    input.tap()
    input.typeText("A thought for the inbox")
    attach("phone-prose", text: app.debugDescription)
    // React Native's Pressable groups its label into an Other element rather
    // than exposing the inner Text as StaticText on this iOS version.
    let inbox = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Save to inbox")).firstMatch
    XCTAssertTrue(inbox.waitForExistence(timeout: Acceptance.shortWait))
    // Delete the known short string, without relying on localized edit menus.
    input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "A thought for the inbox".count))
    input.typeText(Acceptance.page("phone"))
    XCTAssertEqual(input.value as? String, Acceptance.page("phone"), "The keyboard changed the URL or left prose behind.")
    let save = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Save inspiration")).firstMatch
    XCTAssertTrue(save.waitForExistence(timeout: Acceptance.shortWait), "A pasted URL still routes to the inbox.")
    attach("phone-url-ready", screenshot: true)
    save.tap()
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: save)
    waitForExpectations(timeout: Acceptance.wait)
    attach("phone-url-saved", screenshot: true)
  }

  // MARK: - The flow

  private func share(
    button: String,
    launchEnvironment: [String: String],
    note: String?,
    preview: String?
  ) throws {
    let host = XCUIApplication(bundleIdentifier: Acceptance.harnessBundleIdentifier)
    host.launchEnvironment = launchEnvironment
    host.launch()
    XCTAssertTrue(host.wait(for: .runningForeground, timeout: Acceptance.wait), "The share host did not come up.")

    let shareButton = host.buttons[button]
    XCTAssertTrue(shareButton.waitForExistence(timeout: Acceptance.shortWait), "\(button) is missing from the host.")
    shareButton.tap()
    attach("01-system-share-sheet", screenshot: true)

    let driver = ShareSheetDriver(host: host)
    driver.onFailure = { [weak self] description in
      self?.attach("failure-hierarchies", text: description)
      self?.attach("failure-screen", screenshot: true)
    }

    driver.chooseKintsugi()
    attach("02-kintsugi-extension", screenshot: true)

    XCTAssertTrue(
      driver.waitForSaveEnabled(),
      "The extension never enabled Save, so it did not understand the shared item."
    )
    if let preview {
      driver.assertPreviewContains(preview)
    }
    if let note {
      driver.enterNote(note)
    }
    attach("03-ready-to-save", screenshot: true)

    driver.save()
    driver.expectDismissed()
    attach("04-after-save", screenshot: true)

    // Save must not open the main UI. iOS may legitimately relaunch the app
    // in the background to finish the extension's background URLSession events.
    XCTAssertNotEqual(
      XCUIApplication(bundleIdentifier: Acceptance.kintsugiBundleIdentifier).state,
      .runningForeground,
      "The share flow opened Kintsugi instead of returning to the source app."
    )
  }

  // MARK: - Attachments

  private func attach(_ name: String, screenshot: Bool = false, text: String? = nil) {
    XCTContext.runActivity(named: name) { activity in
      if let text {
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        activity.add(attachment)
      }
      if screenshot {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        activity.add(attachment)
      }
    }
  }
}
