import { invoke } from "@tauri-apps/api/core";
import type { ClipSummary } from "@kintsugi/core/clips";
import { linkFor, type ReferenceSource } from "@kintsugi/core/references";
import type { Skill } from "@/lib/kin";
import { paragraphTerms } from "@/references/Writing";
import type { Action } from "./prompts";

/** ⌘K's actions that write nothing: they find, or open Kin's chat. */
export type KinAction = { id: "supporting" | "disagrees" | "discuss"; label: string; hint: string };

export const KIN_ACTIONS: KinAction[] = [
  { id: "supporting", label: "Find supporting clips", hint: "Search your clips for this passage" },
  { id: "disagrees", label: "Who disagrees?", hint: "Ask Kin who argues against it" },
  { id: "discuss", label: "Discuss this paragraph", hint: "Open Kin's chat with it attached" },
];

export const WHO_DISAGREES =
  "Who disagrees with this? Look through my clips and writing for people who argue against it, and point me to where they do. Don't rewrite it.";

/** A skill flagged for the editor, run like ⌘K's edits: a diff to accept. */
export function skillAction(skill: Pick<Skill, "name" | "description" | "body">): Action {
  return {
    id: `skill:${skill.name}`,
    label: skill.name,
    shape: "rewrite",
    instruction: `Apply the skill "${skill.name}" (${skill.description.trim()}) to the passage. Its procedure:\n\n${skill.body.trim()}\n\nApply it as an edit of the passage itself.`,
  };
}

type ClipSearch = { clips: (ClipSummary & { text: string })[]; total: number };

export type Found = { source: ReferenceSource; link: string; matches: number };

/**
 * Clips that share the passage's words, most shared first. One search per
 * term through `clip_search` (all terms must match there), so a clip that
 * matches more of the passage ranks higher. `docs` keep links unambiguous.
 */
export async function supportingClips(passage: string, docs: { path: string; title?: string | null }[], limit = 8): Promise<Found[]> {
  const terms = paragraphTerms(passage);
  if (!terms.length) return [];
  const results = await Promise.all(terms.map((query) => invoke<ClipSearch>("clip_search", { query, limit: 20 })));
  const scored = new Map<string, { clip: ClipSummary; matches: number; first: number }>();
  results.forEach((result, order) => {
    for (const clip of result.clips) {
      const seen = scored.get(clip.path);
      scored.set(clip.path, { clip, matches: (seen?.matches ?? 0) + 1, first: seen?.first ?? order });
    }
  });
  const found = [...scored.values()].sort((a, b) => b.matches - a.matches || a.first - b.first).slice(0, limit);
  const sources: ReferenceSource[] = [
    ...docs.map((doc) => ({ kind: "document" as const, path: doc.path, title: doc.title ?? doc.path })),
    ...found.map(({ clip }) => toSource(clip)),
  ];
  return found.map(({ clip, matches }) => {
    const source = toSource(clip);
    return { source, link: linkFor(source, sources), matches };
  });
}

const toSource = (clip: ClipSummary): ReferenceSource => ({
  kind: "clip",
  path: clip.path,
  title: clip.title || clip.path.replace(/^.*\//, "").replace(/\.mdx?$/, ""),
  site: clip.site,
  summary: clip.summary,
});
