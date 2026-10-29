import UIKit

/// KI-2 acceptance host. It is a *share source*, nothing else: three buttons
/// that present the system `UIActivityViewController` with a URL, a generated
/// PNG, or text. It deliberately has no App Group and no keychain entitlement,
/// so any capture that appears in Kintsugi's queue or on the fake Mac can only
/// have been written by the real installed share extension.
///
/// The tests set `SHARE_URL` / `SHARE_TEXT` in `launchEnvironment`; everything
/// has a default so the app is also usable by hand.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    true
  }

  func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: windowScene)
    window.rootViewController = HarnessViewController()
    window.makeKeyAndVisible()
    self.window = window
  }
}

final class HarnessViewController: UIViewController {
  private let environment = ProcessInfo.processInfo.environment
  private let statusLabel = UILabel()
  private var buttons: [UIButton] = []

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground

    let title = UILabel()
    title.text = "KI-2 share acceptance host"
    title.font = .preferredFont(forTextStyle: .title2)
    title.numberOfLines = 0

    let hint = UILabel()
    hint.text = "Presents the system share sheet. No App Group, no keychain: only the installed Kintsugi extension can save a capture."
    hint.font = .preferredFont(forTextStyle: .footnote)
    hint.textColor = .secondaryLabel
    hint.numberOfLines = 0

    statusLabel.font = .preferredFont(forTextStyle: .caption1)
    statusLabel.textColor = .secondaryLabel
    statusLabel.numberOfLines = 0
    statusLabel.accessibilityIdentifier = "harness-status"
    statusLabel.text = "idle"

    buttons = [
      makeButton(title: "Share URL", identifier: "share-url", action: #selector(shareURL)),
      makeButton(title: "Share Image", identifier: "share-image", action: #selector(shareImage)),
      makeButton(title: "Share Text", identifier: "share-text", action: #selector(shareText)),
    ]

    let stack = UIStackView(arrangedSubviews: [title, hint] + buttons + [statusLabel])
    stack.axis = .vertical
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
      stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
    ])
  }

  private func makeButton(title: String, identifier: String, action: Selector) -> UIButton {
    var configuration = UIButton.Configuration.filled()
    configuration.title = title
    let button = UIButton(configuration: configuration)
    button.addTarget(self, action: action, for: .touchUpInside)
    button.accessibilityIdentifier = identifier
    button.accessibilityLabel = title
    button.heightAnchor.constraint(equalToConstant: 48).isActive = true
    return button
  }

  // MARK: - Share sources

  @objc private func shareURL() {
    let value = environment["SHARE_URL"] ?? "http://127.0.0.1:8848/page.html?case=url"
    guard let url = URL(string: value) else {
      statusLabel.text = "SHARE_URL is not a URL: \(value)"
      return
    }
    present(items: [url], description: url.absoluteString)
  }

  @objc private func shareImage() {
    // Use an actual PNG file, not UIImage's negotiable representation. This
    // also exercises providers advertising both public.file-url and an image.
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("ki2-image.png")
    do {
      guard let data = ImageFactory.card().pngData() else { return }
      try data.write(to: file, options: .atomic)
      present(items: [file], description: "generated PNG")
    } catch {
      statusLabel.text = "Couldn’t prepare the PNG: \(error.localizedDescription)"
    }
  }

  @objc private func shareText() {
    let value = environment["SHARE_TEXT"] ?? "A passage worth keeping."
    present(items: [value], description: "text")
  }

  private func present(items: [Any], description: String) {
    setButtons(enabled: false)
    statusLabel.text = "presenting \(description)"

    let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
    controller.completionWithItemsHandler = { [weak self] _, completed, _, error in
      guard let self else { return }
      self.statusLabel.text = completed
        ? "shared \(description)"
        : "finished \(description) error=\(error?.localizedDescription ?? "none")"
      self.setButtons(enabled: true)
    }
    if let popover = controller.popoverPresentationController {
      popover.sourceView = view
      popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
    }
    present(controller, animated: true)
  }

  private func setButtons(enabled: Bool) {
    buttons.forEach { $0.isEnabled = enabled }
  }
}

enum ImageFactory {
  /// A 1200×800 PNG drawn at scale 1, so the extension's preview, its MIME
  /// detection (`image/png`) and the saved bytes can all be checked without a
  /// fixture file in the repository.
  static func card() -> UIImage {
    let size = CGSize(width: 1200, height: 800)
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = true
    return UIGraphicsImageRenderer(size: size, format: format).image { context in
      let colors = [UIColor.systemIndigo.cgColor, UIColor.systemTeal.cgColor]
      if let gradient = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: colors as CFArray,
        locations: [0, 1]
      ) {
        context.cgContext.drawLinearGradient(
          gradient,
          start: .zero,
          end: CGPoint(x: size.width, y: size.height),
          options: []
        )
      }
      let paragraph = NSMutableParagraphStyle()
      paragraph.alignment = .center
      let attributes: [NSAttributedString.Key: Any] = [
        .font: UIFont.systemFont(ofSize: 72, weight: .semibold),
        .foregroundColor: UIColor.white,
        .paragraphStyle: paragraph,
      ]
      let text = "KI-2 image"
      let bounds = text.boundingRect(
        with: size,
        options: .usesLineFragmentOrigin,
        attributes: attributes,
        context: nil
      )
      text.draw(
        in: CGRect(x: 0, y: (size.height - bounds.height) / 2, width: size.width, height: bounds.height),
        withAttributes: attributes
      )
    }
  }
}
