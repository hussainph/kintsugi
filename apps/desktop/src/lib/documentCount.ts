import type { DocumentCount } from "@kintsugi/editor/Editor";

export function documentCountLabel({ words, selection }: DocumentCount): string {
  const total = `${words.toLocaleString()} ${words === 1 ? "word" : "words"}`;
  if (!selection) return total;
  return `${selection.words.toLocaleString()} of ${total} · ${selection.characters.toLocaleString()} ${selection.characters === 1 ? "character" : "characters"}`;
}
