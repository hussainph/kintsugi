import type { Pairing } from '@kintsugi/core/remote';
import Storage from 'expo-sqlite/kv-store';

import { library } from './documents';
import { setNewEditor } from './settings';

/** A pairing with nothing behind it: every call fails as Offline, so the app
 *  runs on its own copy, as it does away from the Mac. For trying the editor
 *  in Expo Go without a Mac (development builds only; see Welcome). */
export const SAMPLE_PAIRING: Pairing = { url: 'http://127.0.0.1:9', token: 'kintsugi-sample' };

const PATHS = 'sample:paths';

export const isSample = (pairing: Pairing | null) => pairing?.url === SAMPLE_PAIRING.url && pairing.token === SAMPLE_PAIRING.token;

const paragraph = (n: number) =>
  `## Part ${n}\n\nThe quick brown fox jumps over the lazy dog while the writer, half awake on the train, tries to remember what the paragraph was meant to say. Part ${n} links back to [[mending-with-gold]] and has some *emphasis* and **strong text**.\n\nA second paragraph for part ${n}: a phone editor has to stay quick when the document is long, because the long ones are the ones worth finishing.\n`;

const SAMPLES = [
  `Mending with gold\n\nKintsugi repairs broken pottery with lacquer and gold, so the break becomes part of the object's history instead of something to hide.\n\n## Why it matters for writing\n\nA draft is mostly breaks. The *first* version says the wrong thing in the right order, or the right thing in the **wrong** order. Type [[ to link another note.\n\n> The point is not to hide the seam. It is to make it worth looking at.\n\n- Write the ugly paragraph first.\n- Fix the order before the sentences.\n- Read it aloud on the phone, away from the desk.`,
  `On writing in the margins\n\nThe margins are where the real thinking happens.`,
  `A long essay to scroll\n\n` + Array.from({ length: 125 }, (_, i) => paragraph(i + 1)).join('\n'),
];

/** Starts the app on sample notes, with the new editor on. */
export function startSample(pair: (pairing: Pairing) => void) {
  const paths = SAMPLES.map((text) => library.create(text));
  Storage.setItemSync(PATHS, JSON.stringify(paths));
  setNewEditor(true);
  pair(SAMPLE_PAIRING);
}

/** Leaving the samples removes them, so none reach a real Mac later. */
export function endSample() {
  try {
    for (const path of JSON.parse(Storage.getItemSync(PATHS) ?? '[]') as string[]) library.forget(path);
  } catch {}
  Storage.removeItemSync(PATHS);
}
