import { type Pairing, remote, type Remote } from '@kintsugi/core/remote';
import * as SecureStore from 'expo-secure-store';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

const KEY = 'kintsugi.pairing';

function load(): Pairing | null {
  try {
    const raw = SecureStore.getItem(KEY);
    return raw ? (JSON.parse(raw) as Pairing) : null;
  } catch {
    return null;
  }
}

type Value = {
  pairing: Pairing | null;
  /** The Mac this phone is paired with, or null before pairing. */
  client: Remote | null;
  pair: (pairing: Pairing) => void;
  unpair: () => void;
};

const Context = createContext<Value | null>(null);

/** The pairing token is a password to the vault, so it lives in the Keychain. */
export function PairingProvider({ children }: { children: ReactNode }) {
  const [pairing, setPairing] = useState(load);
  const value = useMemo<Value>(
    () => ({
      pairing,
      client: pairing && remote(pairing),
      pair(next) {
        SecureStore.setItem(KEY, JSON.stringify(next));
        setPairing(next);
      },
      unpair() {
        SecureStore.deleteItemAsync(KEY).catch(() => {});
        setPairing(null);
      },
    }),
    [pairing],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePairing(): Value {
  const value = useContext(Context);
  if (!value) throw new Error('usePairing needs a PairingProvider');
  return value;
}
