import { type Pairing, remote, type Remote } from '@kintsugi/core/remote';
import * as SecureStore from 'expo-secure-store';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { Alert } from 'react-native';

import { KintsugiCapture as Capture } from '../../modules/capture';
import { endSample, isSample } from './sample';

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
  useEffect(() => {
    // Migrate existing installs at launch. Only the native shared Keychain holds
    // the extension's copy — never App Group preferences or capture files.
    try {
      Capture?.setPairing(pairing ? JSON.stringify(pairing) : null);
    } catch (error) {
      Alert.alert('Couldn’t enable share delivery', `Captures will wait on this phone. ${String(error)}`);
    }
  }, [pairing]);
  const value = useMemo<Value>(
    () => ({
      pairing,
      client: pairing && remote(pairing),
      pair(next) {
        const raw = JSON.stringify(next);
        // The app's pairing is canonical. The effect mirrors it separately;
        // a share entitlement problem must not prevent using the phone app.
        SecureStore.setItem(KEY, raw);
        setPairing(next);
      },
      unpair() {
        // Synchronous invalidation: a failed Keychain write must not pretend
        // to have unpaired while the extension still has a live vault token.
        try {
          Capture?.setPairing(null);
          SecureStore.setItem(KEY, '');
          if (isSample(pairing)) endSample();
          setPairing(null);
        } catch (error) {
          Alert.alert('Couldn’t unpair this phone', String(error));
        }
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
