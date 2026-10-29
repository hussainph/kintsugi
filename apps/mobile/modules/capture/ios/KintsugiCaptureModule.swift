import ExpoModulesCore

/// The capture queue and shared pairing, for the app's JavaScript.
/// Queue calls are async (off the JS thread); `setPairing` is synchronous.
public class KintsugiCaptureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KintsugiCapture")

    Function("setPairing") { (pairingJSON: String?) throws in
      try CapturePairing.save(pairingJSON)
    }

    AsyncFunction("enqueue") { (payloadJSON: String) throws -> String in
      try CaptureStore().enqueue(payloadJSON)
    }

    AsyncFunction("pending") { () throws -> String in
      try CaptureStore().pending()
    }

    AsyncFunction("read") { (id: String) throws -> String in
      try CaptureStore().read(id)
    }

    AsyncFunction("claim") { (id: String) throws -> Bool in
      try CaptureStore().claim(id)
    }

    AsyncFunction("acknowledge") { (id: String) throws in
      try CaptureStore().acknowledge(id)
    }

    AsyncFunction("reject") { (id: String, reason: String) throws in
      try CaptureStore().reject(id, reason: reason)
    }

    AsyncFunction("release") { (id: String) throws in
      try CaptureStore().release(id)
    }
  }
}
