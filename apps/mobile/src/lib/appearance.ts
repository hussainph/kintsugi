/** Device-local preferences. Nothing here enters the phone sync payloads. */
export type AppearanceMode = 'light' | 'dark' | 'system';
export type ColorScheme = 'light' | 'dark';
export type AppearanceSnapshot = { mode: AppearanceMode; textSize: number };
export type AppearanceStorage = {
  getItemSync: (key: string) => string | null;
  setItemSync: (key: string, value: string) => void;
};

// KI-65's Mac steps, including its nearest-step and endpoint behavior.
export const TEXT_SIZES = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5] as const;
export const APPEARANCE_KEY = 'settings:appearance';
export const DEFAULT_APPEARANCE: AppearanceSnapshot = { mode: 'system', textSize: 1 };

export function nearestSize(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return TEXT_SIZES.reduce((best, size) => Math.abs(size - value) < Math.abs(best - value) ? size : best, 1);
}

export function stepSize(current: number, direction: -1 | 1): number {
  const index = TEXT_SIZES.indexOf(nearestSize(current) as (typeof TEXT_SIZES)[number]);
  return TEXT_SIZES[Math.max(0, Math.min(TEXT_SIZES.length - 1, index + direction))];
}

export function resolveScheme(mode: AppearanceMode, system: string | null | undefined): ColorScheme {
  return mode === 'system' ? system === 'dark' ? 'dark' : 'light' : mode;
}

function decode(saved: string | null): AppearanceSnapshot {
  try {
    const value: unknown = JSON.parse(saved ?? 'null');
    if (!value || typeof value !== 'object') return DEFAULT_APPEARANCE;
    const { mode, textSize } = value as Record<string, unknown>;
    return {
      mode: mode === 'light' || mode === 'dark' ? mode : 'system',
      textSize: typeof textSize === 'number' ? nearestSize(textSize) : 1,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export class AppearancePreferences {
  private value: AppearanceSnapshot;
  private listeners = new Set<() => void>();
  private storage: AppearanceStorage;

  constructor(storage: AppearanceStorage) {
    this.storage = storage;
    try { this.value = decode(storage.getItemSync(APPEARANCE_KEY)); }
    catch { this.value = DEFAULT_APPEARANCE; }
  }

  getSnapshot = (): AppearanceSnapshot => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  setMode = (mode: AppearanceMode) => this.set({ ...this.value, mode });
  setTextSize = (textSize: number) => this.set({ ...this.value, textSize: nearestSize(textSize) });

  private set(next: AppearanceSnapshot) {
    if (next.mode === this.value.mode && next.textSize === this.value.textSize) return;
    this.value = next;
    try { this.storage.setItemSync(APPEARANCE_KEY, JSON.stringify(next)); }
    catch { /* A preference only: still apply for this launch. */ }
    this.listeners.forEach((listener) => listener());
  }
}

/** Paper's compact 520pt sheet, with a full-height accessibility detent. */
export function appearanceDetents(height: number, fontScale: number): { detents: number[]; initial: number } {
  const compact = Math.min(1, 520 / Math.max(1, height));
  const detents = compact < 1 ? [compact, 1] : [1];
  return { detents, initial: fontScale > 1.2 ? detents.length - 1 : 0 };
}
