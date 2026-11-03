import { defaultKeymap, historyKeymap, toggleBlockComment, toggleComment } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import type { KeyBinding } from "@codemirror/view";

/** CodeMirror's own keys, after the formatting keys. The app's shortcut
 *  registry is tested against this list, so a new app key can't silently
 *  take one of these (or lose to one). */
export const builtinKeymap: readonly KeyBinding[] = [
  // CodeMirror's comment toggles write `<!-- -->` even in MDX; ⌘/ dims instead (KI-88).
  ...defaultKeymap.filter((binding) => binding.run !== toggleComment && binding.run !== toggleBlockComment),
  ...historyKeymap,
  ...searchKeymap,
];

/** The specs a binding answers to on a Mac: its `mac` key (else `key`),
 *  and the ⇧ variant when it has a `shift` command. */
export function macSpecs(binding: KeyBinding): string[] {
  const spec = binding.mac ?? binding.key;
  if (!spec) return [];
  return binding.shift ? [spec, `Shift-${spec}`] : [spec];
}
