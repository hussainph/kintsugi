import SwiftUI

/// Only a host for the UI test bundle; the tests drive Kintsugi itself.
@main
struct HostApp: App {
  var body: some Scene {
    WindowGroup { Text("Browse harness") }
  }
}
