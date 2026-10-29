import ExpoModulesCore
import UIKit

/// When a share extension's upload finishes after the extension is gone,
/// iOS relaunches the app with that launch's session events. Reconnect to
/// that one session only then; it is invalidated once settled.
public class CaptureAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    // Expo waits for every subscriber's handler; reconnect calls it at once
    // for identifiers that aren't ours.
    CaptureDelivery.reconnect(identifier: identifier, completionHandler: completionHandler)
  }
}
