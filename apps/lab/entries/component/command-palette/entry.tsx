import { useState } from "react";
import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { Palette, type PaletteMode } from "@/components/Palette";
import { Button } from "@kintsugi/ui/components/button";
import { documentSeeds } from "../../page/inspiration-library/fixtures";
export const meta: EntryMeta = {
  id: "component/command-palette",
  title: "Command palette",
  kind: "component",
  group: "navigation",
  status: "exploring",
  sources: [
    "apps/desktop/src/components/Palette.tsx",
    "packages/ui/src/components/command.tsx",
  ],
  tickets: ["KI-15"],
  related: ["component/sidebar", "page/writing", "component/dialog"],
  summary:
    "The actual document jump / creation palette with keyboard filtering and frame-local selection feedback.",
};
export const controls: Record<string, Control> = {
  mode: {
    type: "select",
    default: "open",
    options: ["open", "new-doc", "new-folder"],
    target: "apps/desktop/src/components/Palette.tsx#mode",
  },
};
function PalettePreview({
  kind = "open",
}: {
  kind?: "open" | "new-doc" | "new-folder";
}) {
  const initial: PaletteMode =
    kind === "open" ? { kind } : { kind, dir: "notes" };
  const [mode, setMode] = useState<PaletteMode | null>(initial);
  const [result, setResult] = useState(
    "Choose a document. ↑ / ↓ and Enter work here.",
  );
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
      <Button variant="outline" onClick={() => setMode(initial)}>
        Open palette
      </Button>
      <p className="text-sm text-muted-foreground" role="status">
        {result}
      </p>
      <Palette
        mode={mode}
        docs={documentSeeds.map((doc) => ({
          kind: "doc",
          name: doc.path,
          path: doc.path,
          title: doc.title,
          status: doc.status,
        }))}
        onClose={() => setMode(null)}
        onOpen={(path) => {
          setResult(`Selected ${path}`);
          setMode(null);
        }}
        onCreate={(mode, name) => {
          setResult(
            `Named a ${mode.kind === "new-doc" ? "document" : "folder"}: ${name}. This preview creates no files.`,
          );
          setMode(null);
        }}
      />
    </div>
  );
}
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "Jump or create",
      render: ({ values }) => (
        <PalettePreview
          key={String(values.mode)}
          kind={values.mode as "open" | "new-doc" | "new-folder"}
        />
      ),
    },
    {
      id: "new-document",
      title: "Name a new document",
      render: () => <PalettePreview kind="new-doc" />,
    },
  ],
});
