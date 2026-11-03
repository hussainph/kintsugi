/**
 * Edits Kin proposes in the chat (KI-79), when he asks for one: a fenced
 * block whose info string is `edit <path>`, holding search/replace pairs
 * (the passage as it is, then Kin's version). See `prompt.rs`.
 */
export type EditPair = { before: string; after: string };
export type ProposedEdit = { path: string; pairs: EditPair[] };

const SEARCH = /^<{5,}\s*SEARCH\s*$/;
const DIVIDE = /^={5,}\s*$/;
const REPLACE = /^>{5,}\s*REPLACE\s*$/;

/** The path an edit block names, or null when `info` isn't an edit block. */
export function editPath(info: string): string | null {
  const match = /^edit(?:\s+(\S.*))?$/i.exec(info.trim());
  return match ? (match[1] ?? "").trim() : null;
}

/** An edit block's pairs. Null while it's incomplete or malformed. */
export function parseEdit(info: string, code: string): ProposedEdit | null {
  const path = editPath(info);
  if (path === null) return null;
  const pairs: EditPair[] = [];
  let state: "out" | "before" | "after" = "out";
  let before: string[] = [];
  let after: string[] = [];
  for (const line of code.split("\n")) {
    if (state === "out" && SEARCH.test(line)) {
      state = "before";
      before = [];
      after = [];
    } else if (state === "before" && DIVIDE.test(line)) {
      state = "after";
    } else if (state === "after" && REPLACE.test(line)) {
      pairs.push({ before: before.join("\n"), after: after.join("\n") });
      state = "out";
    } else if (state === "before") before.push(line);
    else if (state === "after") after.push(line);
  }
  if (state !== "out" || !pairs.length || pairs.some((p) => !p.before.trim())) return null;
  return { path, pairs };
}
