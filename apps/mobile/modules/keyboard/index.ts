import { type EventSubscription, requireOptionalNativeModule } from 'expo';

/** One button in the keyboard toolbar. `symbol` is an SF Symbol; without one
 *  the label is shown. id "-" is flexible space. */
export type ToolbarItem = { id: string; symbol?: string; label: string };

type KintsugiKeyboardModule = {
  setToolbar(items: ToolbarItem[] | null): Promise<void>;
  setEnabled(enabled: Record<string, boolean>): Promise<void>;
  setFocusRaisesKeyboard(enabled: boolean): Promise<void>;
  focusWebView(): Promise<boolean>;
  addListener(event: 'onAction', listener: (event: { id: string }) => void): EventSubscription;
};

/** The editor WebView's native keyboard toolbar (ios/KintsugiKeyboardModule.swift).
 *  Null where the native module isn't built in (Expo Go, web, Android). */
export const KintsugiKeyboard = requireOptionalNativeModule<KintsugiKeyboardModule>('KintsugiKeyboard');
