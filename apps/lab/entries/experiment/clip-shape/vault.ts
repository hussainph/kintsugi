// Browser side of the fixtures: Vite loads the committed clip files and their
// media; clips.ts parses them exactly as the node tests do.
import { annotations, assemble, parseClipFile, type Clip } from "./clips";

const files = import.meta.glob<string>("./fixtures/inspiration/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const media = import.meta.glob<string>("./fixtures/inspiration/media/*", {
  query: "?url",
  import: "default",
  eager: true,
});

export const clips: Clip[] = annotations.map((note) => {
  const key = `./fixtures/${note.path}`;
  const raw = files[key];
  if (raw === undefined) throw new Error(`Missing clip fixture ${key}`);
  const file = parseClipFile(note.path, raw);
  const image = file.fields.image
    ? media[`./fixtures/inspiration/${file.fields.image}`] ?? null
    : null;
  return assemble(file, note, image);
});
