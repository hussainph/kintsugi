import { requireOptionalNativeModule } from 'expo';

/** One queued capture, as `pending()` lists it (oldest first). `id` is the
 *  queue's own sortable id, not the payload's KI-10 capture UUID. */
export type CaptureSummary = { id: string; capturedAt: string; error?: string; file?: boolean };

/** The App Group capture queue shared with the share extension
 *  (ios/Shared/CaptureStore.swift). Send flow: pending → claim → read → POST
 *  /v1/clips → acknowledge on success, release otherwise (in a finally). */
export type KintsugiCaptureModule = {
  /** Mirrors the pairing (`{url, token}` JSON) into the keychain item shared
   *  with the extension; null removes it. Synchronous; throws on failure. */
  setPairing(pairingJSON: string | null): void;
  /** Durably queues a POST /v1/clips body (must carry `capturedAt`, at most
   *  22 MiB of UTF-8 once committed, or 70 MiB with a `file`); resolves its queue id. A valid UUID `id`
   *  in the body is kept byte for byte; a missing or null one is generated
   *  once and stored in the payload; any other `id` rejects (invalid payload). */
  enqueue(payloadJSON: string): Promise<string>;
  /** JSON `CaptureSummary[]` of every queued capture, leased or not.
   *  `file: true` marks one carrying a PDF or EPUB (`ClipCapture.file`). */
  pending(): Promise<string>;
  /** One capture's payload JSON, always carrying the same UUID `id` (captures
   *  queued before ids get theirs once, persisted, on first claim or read).
   *  Rejects if it is gone or damaged (damaged ones are set aside). */
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
