import XCTest

/// Fixed facts of the acceptance run. Values that must match the app or the
/// stub Mac live here so a change is a one-line edit.
enum Acceptance {
  static let harnessBundleIdentifier = "dev.phalasiya.kintsugi.shareharness"
  static let kintsugiBundleIdentifier = "dev.phalasiya.kintsugi"
  /// The extension's `CFBundleDisplayName`: what the share sheet shows.
  static let extensionName = "Kintsugi"
  static let note = "KI-2 acceptance note"

  static let baseURL = ProcessInfo.processInfo.environment["KI2_BASE_URL"] ?? "http://127.0.0.1:8848"
  static let shortWait: TimeInterval = 15
  static let wait: TimeInterval = 45

  /// A page served by the fake Mac, with a marker this run can assert on.
  static func page(_ marker: String) -> String {
    "\(baseURL)/page.html?case=\(marker)"
  }
}

/// Drives the real system share sheet, which is remote view-service content:
/// the extension's own views can appear under the sharing app, under
/// SpringBoard, or only after scrolling the app row / opening "More". Each
/// strategy is tried, and a failure attaches both element trees instead of
/// guessing.
final class ShareSheetDriver {
  private let host: XCUIApplication
  private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
  private var scopes: [XCUIApplication] { [host, springboard] }

  /// Called with the element trees just before `XCTFail`, so the test can
  /// attach them. Without it, a failure says only that a label was missing.
  var onFailure: ((String) -> Void)?

  init(host: XCUIApplication) {
    self.host = host
  }

  // MARK: - Choosing the extension

  /// Taps Kintsugi in the share sheet and waits for its sheet.
  func chooseKintsugi(timeout: TimeInterval = Acceptance.wait) {
    let deadline = Date().addingTimeInterval(timeout)
    var attempt = 0
    while Date() < deadline {
      if let entry = extensionEntry() {
        entry.tap()
        guard saveButton(timeout: 8) != nil else {
          fail("Tapped “\(Acceptance.extensionName)” but its sheet never appeared.")
          return
        }
        return
      }
      attempt += 1
      // The apps row is a horizontal collection; "More" holds the full list.
      if attempt == 4 || attempt == 8 { scrollAppRow() }
      if attempt == 12 { openMoreList() }
      Thread.sleep(forTimeInterval: 0.5)
    }
    fail("“\(Acceptance.extensionName)” was never offered in the share sheet.")
  }

  private func extensionEntry() -> XCUIElement? {
    let predicate = NSPredicate(format: "label == %@", Acceptance.extensionName)
    for scope in scopes {
      let candidates = [
        scope.buttons.matching(predicate).firstMatch,
        scope.cells.matching(predicate).firstMatch,
        scope.staticTexts.matching(predicate).firstMatch,
        scope.images.matching(predicate).firstMatch,
        scope.otherElements.matching(predicate).firstMatch,
      ]
      for candidate in candidates where candidate.exists && candidate.isHittable {
        return candidate
      }
    }
    return nil
  }

  private func scrollAppRow() {
    for scope in scopes {
      let row = scope.collectionViews.firstMatch
      if row.exists && row.isHittable {
        row.swipeLeft()
        return
      }
    }
    if host.exists { host.swipeLeft() }
  }

  private func openMoreList() {
    for scope in scopes {
      for candidate in [scope.buttons["More"], scope.cells["More"]] where candidate.exists && candidate.isHittable {
        candidate.tap()
        return
      }
    }
  }

  // MARK: - The extension's own sheet

  /// The extension disables Save until it has understood its input, so this is
  /// also the assertion that a URL, image or text was actually read.
  @discardableResult
  func waitForSaveEnabled(timeout: TimeInterval = Acceptance.wait) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if let button = saveButton(), button.isEnabled { return true }
      Thread.sleep(forTimeInterval: 0.25)
    }
    return false
  }

  /// `ShareViewController` shows the shared URL and its host in the preview.
  func assertPreviewContains(_ fragment: String) {
    let predicate = NSPredicate(format: "label CONTAINS %@", fragment)
    for scope in scopes where scope.staticTexts.matching(predicate).firstMatch.exists {
      return
    }
    fail("The preview does not show “\(fragment)”.")
  }

  func enterNote(_ note: String = Acceptance.note) {
    guard let field = noteField() else {
      fail("The note field was not found in the extension sheet.")
      return
    }
    field.tap()
    field.typeText(note)
  }

  func save() {
    guard waitForSaveEnabled() else {
      fail("Save never became enabled: the extension had nothing to save.")
      return
    }
    guard let button = saveButton(), button.isEnabled else {
      fail("The Save button vanished before it could be tapped.")
      return
    }
    button.tap()
  }

  /// Save commits to the App Group and dismisses without opening Kintsugi, so
  /// the sharing app must be back in front with the sheet gone.
  func expectDismissed(timeout: TimeInterval = Acceptance.wait) {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if saveButton() == nil && host.wait(for: .runningForeground, timeout: 5) { return }
      Thread.sleep(forTimeInterval: 0.5)
    }
    fail("Save did not dismiss the sheet, or the sharing app never came back.")
  }

  // MARK: - Element lookup

  private func saveButton(timeout: TimeInterval = 0) -> XCUIElement? {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      for scope in scopes {
        let button = scope.buttons["Save"]
        if button.exists { return button }
      }
      if timeout > 0 { Thread.sleep(forTimeInterval: 0.25) }
    } while Date() < deadline
    return nil
  }

  private func noteField() -> XCUIElement? {
    let placeholder = "What caught your attention?"
    for scope in scopes {
      let field = scope.textFields[placeholder]
      if field.exists { return field }
      let view = scope.textViews[placeholder]
      if view.exists { return view }
    }
    // A SwiftUI TextField(axis: .vertical) is a text view on some versions.
    for scope in scopes {
      if scope.textFields.count == 1 { return scope.textFields.firstMatch }
      if scope.textViews.count == 1 { return scope.textViews.firstMatch }
    }
    return nil
  }

  // MARK: - Failure evidence

  private func fail(_ message: String, file: StaticString = #filePath, line: UInt = #line) {
    onFailure?(describe())
    XCTFail(message, file: file, line: line)
  }

  func describe() -> String {
    let hostTree = host.exists ? String(host.debugDescription.prefix(12_000)) : "harness is not running"
    let boardTree = String(springboard.debugDescription.prefix(20_000))
    return """
    === harness (\(Acceptance.harnessBundleIdentifier)) ===
    \(hostTree)

    === springboard ===
    \(boardTree)
    """
  }
}
