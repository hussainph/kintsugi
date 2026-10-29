import Foundation
import Security

/// The Mac this phone is paired with, mirrored by the app into a keychain
/// item shared with the share extension (never into App Group files: the
/// token is a password to the vault). The app's expo-secure-store item stays
/// the source of truth; the app calls `save` whenever it loads, pairs or
/// unpairs.
///
/// The keychain group comes from the `KintsugiKeychainGroup` Info.plist key of
/// the running bundle (app or extension), set to
/// `$(AppIdentifierPrefix)dev.phalasiya.kintsugi.capture` and listed in both
/// targets' `keychain-access-groups` entitlement.
public struct CapturePairing: Equatable {
  public static let service = "kintsugi.capture.pairing"
  public static let account = "kintsugi.pairing"
  public static let groupInfoKey = "KintsugiKeychainGroup"

  public let url: String
  public let token: String

  public init(url: String, token: String) {
    self.url = url
    self.token = token
  }

  /// Reads `{url, token}` as the app stores it. The url must be an origin,
  /// `http(s)://host[:port]`, as `parsePairLink` in @kintsugi/core accepts.
  public init(json: String) throws {
    guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
          let url = object["url"] as? String,
          let token = object["token"] as? String,
          !token.isEmpty,
          Self.isOrigin(url)
    else { throw CaptureError.invalidPairing }
    self.init(url: url, token: token)
  }

  static func isOrigin(_ url: String) -> Bool {
    guard let parts = URLComponents(string: url),
          let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = parts.host, !host.isEmpty
    else { return false }
    return parts.user == nil && parts.password == nil && parts.query == nil && parts.fragment == nil
      && (parts.path.isEmpty || parts.path == "/")
  }

  public var json: String {
    let data = (try? JSONSerialization.data(withJSONObject: ["url": url, "token": token])) ?? Data()
    return String(decoding: data, as: UTF8.self)
  }

  /// Stores the pairing JSON in the shared keychain item, or deletes the item for nil.
  public static func save(_ json: String?) throws {
    var query = try baseQuery()
    guard let json else {
      let status = SecItemDelete(query as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else { throw keychainError(status) }
      return
    }
    let pairing = try CapturePairing(json: json)
    let attributes: [String: Any] = [
      kSecValueData as String: Data(pairing.json.utf8),
      // Readable by background deliveries while the phone is locked, never backed up.
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      query.merge(attributes) { _, new in new }
      status = SecItemAdd(query as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw keychainError(status) }
  }

  /// The shared pairing, or nil when the app hasn't stored one.
  public static func load() throws -> CapturePairing? {
    var query = try baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw keychainError(status) }
    return try CapturePairing(json: String(decoding: data, as: UTF8.self))
  }

  static func baseQuery() throws -> [String: Any] {
    guard let group = Bundle.main.object(forInfoDictionaryKey: groupInfoKey) as? String,
          !group.isEmpty, !group.contains("$(")
    else { throw CaptureError.io("Info.plist has no \(groupInfoKey).") }
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: group,
    ]
  }

  static func keychainError(_ status: OSStatus) -> CaptureError {
    let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
    return .io("Keychain: \(message)")
  }
}
