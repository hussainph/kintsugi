import { validateRegistry, type Entry } from "@kintsugi/lab";

// The only browser registry. Exact filename discovery cannot pick up helpers or tests.
const modules = import.meta.glob<{ default: Entry }>(
  "./entries/*/*/entry.tsx",
  { eager: true },
);
export const entries = Object.entries(modules).map(([path, module]) => {
  if (!module.default)
    throw new Error(`Lab entry has no default definition: ${path}`);
  const id = path.replace(/^\.\/entries\//, "").replace(/\/entry\.tsx$/, "");
  if (module.default.meta.id !== id)
    throw new Error(`Lab entry ${path} must use id ${id}`);
  return module.default;
});
validateRegistry(entries);
entries.sort((a, b) => a.meta.title.localeCompare(b.meta.title));
window.__LAB_STORIES__ = entries.flatMap((entry) =>
  entry.stories.map((story) => ({ entryId: entry.meta.id, storyId: story.id })),
);
