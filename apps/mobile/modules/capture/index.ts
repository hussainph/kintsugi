import { requireOptionalNativeModule } from 'expo';

/** One queued capture, as `pending()` lists it (oldest first). */
export type CaptureSummary = { id: string; capturedAt: string; error?: string };

/** The App Group capture queue shared with the share extension
 *  (ios/Shared/CaptureStore.swift). Send flow: pending → claim → read → POST
 *  /v1/clips → acknowledge on success, release otherwise (in a finally). */
export type KintsugiCaptureModule = {
  /** Mirrors the pairing (`{url, token}` JSON) into the keychain item shared
   *  with the extension; null removes it. Synchronous; throws on failure. */
  setPairing(pairingJSON: string | null): void;
  /** Durably queues a POST /v1/clips body (must carry `capturedAt`, at most
   *  22 MiB of UTF-8); resolves its id. */
  enqueue(payloadJSON: string): Promise<string>;
  /** JSON `CaptureSummary[]` of every queued capture, leased or not. */
  pending(): Promise<string>;
  /** One capture's payload JSON. Rejects if it is gone or damaged (damaged ones are set aside). */
  read(id: string): Promise<string>;
  /** Leases a capture for 120 s; false when it is gone or someone else is sending it. */
  claim(id: string): Promise<boolean>;
  /** Removes a delivered capture. */
  acknowledge(id: string): Promise<void>;
  /** Preserves a rejected item, but excludes it from automatic delivery. */
  reject(id: string, reason: string): Promise<void>;
  /** Gives up this app's lease so the capture is sent later. A lease held by
   *  the share extension's upload is left alone (it lapses within 120 s). */
  release(id: string): Promise<void>;
};

/** Null where the native module isn't built in (Android, web, Expo Go). */
export const KintsugiCapture = requireOptionalNativeModule<KintsugiCaptureModule>('KintsugiCapture');
