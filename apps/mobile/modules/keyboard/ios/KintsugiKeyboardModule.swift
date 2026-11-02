import ExpoModulesCore
import UIKit
import WebKit

/// The phone editor runs in an Expo DOM component (a WKWebView). WebKit gives
/// a focused web field its own accessory bar (⌃⌄✓) and no way to supply
/// another, so a toolbar drawn by React Native sat beside the keyboard rather
/// than in it and lost track when the keyboard changed height (KI-28). This
/// makes the editor's toolbar the WebView's real `inputAccessoryView`: it is
/// part of the keyboard, moves with it, and is counted in its height.
///
/// It also lets the editor raise the keyboard when it focuses itself (a new
/// note), which WebKit otherwise only allows during a tap in the page; the
/// same switch react-native-webview's `keyboardDisplayRequiresUserAction` uses.
public class KintsugiKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KintsugiKeyboard")
    Events("onAction")

    OnCreate {
      KeyboardToolbar.shared.onAction = { [weak self] id in
        self?.sendEvent("onAction", ["id": id])
      }
      // Before any DOM WebView exists: WebKit reads its UI delegate's
      // optional methods when the delegate is set.
      DispatchQueue.main.async { FocusWithoutTap.install() }
    }

    /// Items to show above the keyboard while a DOM WebView has focus, or
    /// null for WebKit's own bar. Each is `{ id, symbol, label }`; an empty
    /// `symbol` shows `label` as text, and id "-" is flexible space.
    AsyncFunction("setToolbar") { (items: [[String: String]]?) in
      KeyboardToolbar.shared.set(items)
    }.runOnQueue(.main)

    /// Greys out items by id (Undo with nothing to undo, say).
    AsyncFunction("setEnabled") { (enabled: [String: Bool]) in
      KeyboardToolbar.shared.setEnabled(enabled)
    }.runOnQueue(.main)

    /// Makes the DOM WebView the first responder and focuses the editor's
    /// content from here, so typing starts without a tap (a new note).
    /// Doing both on the main thread, in order, avoids racing the page's own
    /// `focus()` against the first responder change.
    AsyncFunction("focusWebView") { () -> Bool in
      for scene in UIApplication.shared.connectedScenes {
        for window in (scene as? UIWindowScene)?.windows ?? [] {
          guard let webView = KeyboardToolbar.findDomWebView(in: window) else { continue }
          let responder = webView.becomeFirstResponder()
          webView.evaluateJavaScript("document.querySelector('.cm-content')?.focus()", completionHandler: nil)
          return responder
        }
      }
      return false
    }.runOnQueue(.main)

    /// Whether the editor focusing itself raises the keyboard.
    AsyncFunction("setFocusRaisesKeyboard") { (enabled: Bool) in
      FocusWithoutTap.enabled = enabled
    }.runOnQueue(.main)
  }
}

final class KeyboardToolbar {
  static let shared = KeyboardToolbar()
  var onAction: ((String) -> Void)?
  private var toolbar: UIToolbar?
  private var buttons: [String: UIBarButtonItem] = [:]
  private var installed = false

  var view: UIView? { toolbar }

  func set(_ items: [[String: String]]?) {
    guard let items else {
      toolbar = nil
      buttons = [:]
      reloadFirstResponder()
      return
    }
    install()
    let bar = UIToolbar(frame: CGRect(x: 0, y: 0, width: UIScreen.main.bounds.width, height: 44))
    bar.autoresizingMask = [.flexibleWidth]
    bar.accessibilityIdentifier = "editor-toolbar"
    var built: [UIBarButtonItem] = []
    buttons = [:]
    for item in items {
      let id = item["id"] ?? ""
      if id == "-" {
        built.append(UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil))
        continue
      }
      let label = item["label"] ?? id
      let action = UIAction { [weak self] _ in self?.onAction?(id) }
      let button: UIBarButtonItem
      if let symbol = item["symbol"], !symbol.isEmpty, let image = UIImage(systemName: symbol) {
        button = UIBarButtonItem(title: nil, image: image, primaryAction: action, menu: nil)
      } else {
        button = UIBarButtonItem(title: label, primaryAction: action)
      }
      button.accessibilityLabel = label
      button.accessibilityIdentifier = "editor-toolbar-\(id)"
      buttons[id] = button
      built.append(button)
    }
    bar.items = built
    bar.sizeToFit()
    toolbar = bar
    reloadFirstResponder()
  }

  func setEnabled(_ enabled: [String: Bool]) {
    for (id, on) in enabled { buttons[id]?.isEnabled = on }
  }

  /// Every WKWebView subclass Expo's DOM components create answers WebKit's
  /// `inputAccessoryView` question from here while a toolbar is set.
  private func install() {
    guard !installed else { return }
    installed = true
    let selector = #selector(getter: UIResponder.inputAccessoryView)
    for cls in Self.domWebViewClasses() {
      guard let method = class_getInstanceMethod(cls, selector) else { continue }
      let original = method_getImplementation(method)
      typealias Getter = @convention(c) (AnyObject, Selector) -> UIView?
      let call = unsafeBitCast(original, to: Getter.self)
      let block: @convention(block) (AnyObject) -> UIView? = { me in
        KeyboardToolbar.shared.view ?? call(me, selector)
      }
      class_replaceMethod(cls, selector, imp_implementationWithBlock(block), method_getTypeEncoding(method))
    }
  }

  /// `DomWKWebView` from @expo/dom-webview, found by name so this module
  /// doesn't link against it. The scan reads class names without messaging
  /// the classes: some runtime classes don't answer messages.
  private static func domWebViewClasses() -> [AnyClass] {
    for name in ["ExpoDomWebView.DomWKWebView", "_TtC14ExpoDomWebView12DomWKWebView"] {
      if let cls = NSClassFromString(name) { return [cls] }
    }
    var count: UInt32 = 0
    guard let list = objc_copyClassList(&count) else { return [] }
    defer { free(UnsafeMutableRawPointer(list)) }
    var found: [AnyClass] = []
    let buffer = UnsafeBufferPointer(start: list, count: Int(count))
    for cls in buffer where String(cString: class_getName(cls)).contains("DomWKWebView") {
      if class_getSuperclass(cls) == WKWebView.self { found.append(cls) }
    }
    return found
  }

  static func findDomWebView(in view: UIView) -> WKWebView? {
    if let webView = view as? WKWebView, String(cString: class_getName(type(of: webView))).contains("DomWKWebView") { return webView }
    for child in view.subviews {
      if let found = findDomWebView(in: child) { return found }
    }
    return nil
  }

  private func reloadFirstResponder() {
    UIResponder.kintsugiCurrentFirstResponder()?.reloadInputViews()
  }
}

enum FocusWithoutTap {
  static var enabled = false
  private static var installed = false

  /// WebKit only starts typing (raises the keyboard) for a focus that came
  /// from a tap. Two ways to allow it, both used by react-native-webview's
  /// `keyboardDisplayRequiresUserAction`: the UI delegate's
  /// `_webView:focusShouldStartInputSession:` (Expo's DomWebView is the
  /// delegate), and WKContentView's focus entry point with
  /// `userIsInteracting` set. If a future WebKit renames either, the keyboard
  /// simply waits for a tap.
  static func install() {
    guard !installed else { return }
    installed = true
    let shouldStart = NSSelectorFromString("_webView:focusShouldStartInputSession:")
    for name in ["ExpoDomWebView.DomWebView", "_TtC14ExpoDomWebView10DomWebView"] {
      guard let cls = NSClassFromString(name) else { continue }
      let block: @convention(block) (AnyObject, WKWebView, AnyObject?) -> Bool = { _, _, _ in enabled }
      class_addMethod(cls, shouldStart, imp_implementationWithBlock(block), "B@:@@")
      break
    }
    guard let content = NSClassFromString("WKContentView") else { return }
    let selector = sel_getUid("_elementDidFocus:userIsInteracting:blurPreviousNode:activityStateChanges:userObject:")
    guard let method = class_getInstanceMethod(content, selector) else {
      NSLog("[KintsugiKeyboard] WKContentView focus selector not found")
      return
    }
    let original = method_getImplementation(method)
    typealias Focus = @convention(c) (AnyObject, Selector, UnsafeRawPointer?, Bool, Bool, UInt, AnyObject?) -> Void
    let call = unsafeBitCast(original, to: Focus.self)
    let block: @convention(block) (AnyObject, UnsafeRawPointer?, Bool, Bool, UInt, AnyObject?) -> Void = { me, node, interacting, blur, changes, object in
      call(me, selector, node, interacting || enabled, blur, changes, object)
    }
    method_setImplementation(method, imp_implementationWithBlock(block))
  }
}

private weak var foundResponder: UIResponder?

extension UIResponder {
  static func kintsugiCurrentFirstResponder() -> UIResponder? {
    foundResponder = nil
    UIApplication.shared.sendAction(#selector(kintsugiFindFirstResponder), to: nil, from: nil, for: nil)
    return foundResponder
  }

  @objc private func kintsugiFindFirstResponder() {
    foundResponder = self
  }
}
