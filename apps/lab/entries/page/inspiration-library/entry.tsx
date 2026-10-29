import { useState } from "react";
import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { Library } from "@/inspiration/Library";
import { UsedIn } from "@/references/UsedIn";
import { Toaster } from "sonner";
import { createInspirationFixtures } from "./fixtures";
export const meta: EntryMeta = {
  id: "page/inspiration-library",
  title: "Inspiration library",
  kind: "page",
  group: "inspiration",
  status: "exploring",
  sources: [
    "apps/desktop/src/inspiration/Library.tsx",
    "apps/desktop/src/inspiration/Detail.tsx",
    "apps/desktop/src/inspiration/Masonry.tsx",
    "apps/desktop/src/references/UsedIn.tsx",
  ],
  tickets: ["KI-15"],
  related: ["component/clip-card", "page/writing", "experiment/clip-open"],
  summary:
    "Real searchable library, raster images, tags, editable detail and shared backlinks. Capture, edit and trash mutate only frame-local fixtures.",
};
export const controls: Record<string, Control> = {
  view: {
    type: "select",
    default: "grid",
    options: ["grid", "detail"],
    target: "apps/desktop/src/inspiration/Library.tsx#openClip",
  },
};
function LibraryPreview({
  empty = false,
  detail = false,
}: {
  empty?: boolean;
  detail?: boolean;
}) {
  useState(() => createInspirationFixtures("page/inspiration-library", empty));
  const [opened, setOpened] = useState("");
  return (
    <div className="flex h-svh min-h-0 flex-col overflow-hidden">
      <Library
        key={String(detail)}
        openClip={
          detail
            ? { path: "inspiration/the-beauty-of-repair.md", seq: 1 }
            : undefined
        }
        renderUsedIn={(clip) => (
          <UsedIn
            root="lab://inspiration"
            path={clip.path}
            onOpen={(path) => setOpened(path)}
          />
        )}
      />
      {opened && (
        <p className="border-t p-2 text-xs text-muted-foreground" role="status">
          Selected writing: {opened}. Open the Writing entry to explore that
          surface.
        </p>
      )}
      <Toaster />
    </div>
  );
}
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "Things that stay with you",
      render: ({ values }) => (
        <LibraryPreview detail={values.view === "detail"} />
      ),
    },
    {
      id: "empty",
      title: "Before the first capture",
      render: () => <LibraryPreview empty />,
    },
  ],
  variants: [
    {
      id: "detail",
      title: "A captured image, opened",
      values: { view: "detail" },
    },
  ],
});
