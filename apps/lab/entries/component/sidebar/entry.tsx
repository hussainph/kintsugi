import { useState, type CSSProperties } from "react";
import { defineEntry, type EntryMeta, type Control } from "@kintsugi/lab";
import { Sidebar } from "@/components/Sidebar";
import {
  SidebarProvider,
  SidebarTrigger,
} from "@kintsugi/ui/components/sidebar";
import { WritingPreview } from "../../page/writing/preview";
import {
  documentTree,
  documentSeeds,
  writingPath,
} from "../../page/inspiration-library/fixtures";
export const meta: EntryMeta = {
  id: "component/sidebar",
  title: "Sidebar",
  kind: "component",
  group: "navigation",
  status: "exploring",
  sources: [
    "apps/desktop/src/components/Sidebar.tsx",
    "packages/ui/src/components/sidebar.tsx",
  ],
  tickets: ["KI-15"],
  related: [
    "component/command-palette",
    "page/writing",
    "page/inspiration-library",
  ],
  summary:
    "The product document tree, collapsible folders, context menu and responsive sidebar provider beside the live editor.",
};
export const controls: Record<string, Control> = {
  width: {
    type: "number",
    default: 16,
    min: 12,
    max: 22,
    step: 0.5,
    target: "packages/ui/src/components/sidebar.tsx#SIDEBAR_WIDTH",
  },
  phoneOn: {
    type: "boolean",
    default: false,
    target: "apps/desktop/src/components/Sidebar.tsx#phoneOn",
  },
};
function SidebarPreview({
  width,
  phoneOn,
}: {
  width: number;
  phoneOn: boolean;
}) {
  const [active, setActive] = useState(writingPath);
  const [tree, setTree] = useState(documentTree);
  const [dir, setDir] = useState("");
  const [library, setLibrary] = useState(false);
  const [notice, setNotice] = useState(
    "Context menus, F2 and ⌘\\ use the real product handlers.",
  );
  const text = documentSeeds.find((doc) => doc.path === active)?.text ?? "";
  return (
    <SidebarProvider
      className="h-svh min-h-0!"
      style={{ "--sidebar-width": `${width}rem` } as CSSProperties}
    >
      <Sidebar
        tree={tree}
        vaultName="Lab writing"
        active={active}
        libraryOpen={library}
        onLibrary={() => {
          setLibrary(true);
          setNotice(
            "Inspiration selected. Explore the full page in the Inspiration library entry.",
          );
        }}
        feedOpen={false}
        onFeed={() => setNotice("Feed selected. The Feed has no Lab entry yet.")}
        selectedDir={dir}
        onSelectDir={setDir}
        onOpen={(path) => {
          setActive(path);
          setLibrary(false);
        }}
        onNewDoc={(path) =>
          setNotice(
            `New document requested in ${path || "vault"}. Naming is exercised in the command-palette entry.`,
          )
        }
        onNewFolder={(path) =>
          setNotice(`New folder requested in ${path || "vault"}.`)
        }
        onRename={(path, name) => {
          setTree((old) =>
            old.map((entry) =>
              entry.path === path
                ? {
                    ...entry,
                    name,
                    ...(entry.kind === "doc" ? { title: name } : {}),
                  }
                : entry,
            ),
          );
          setNotice(`Renamed ${path} to ${name} in the tree fixture only.`);
        }}
        onTrash={(path) => {
          setTree((old) => old.filter((entry) => entry.path !== path));
          setNotice(`Removed ${path} from the tree fixture only.`);
        }}
        phoneOn={phoneOn}
        onPhone={() =>
          setNotice(
            "Phone pairing is unavailable in Lab. No native dialog was opened.",
          )
        }
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center gap-3 border-b px-3">
          <SidebarTrigger />
          <p className="truncate text-xs text-muted-foreground" role="status">
            {notice}
          </p>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <WritingPreview
            key={active}
            entryId="component/sidebar"
            initialText={text}
            margin={false}
          />
        </div>
      </main>
    </SidebarProvider>
  );
}
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "A small writing vault",
      render: ({ values }) => (
        <SidebarPreview
          width={Number(values.width)}
          phoneOn={Boolean(values.phoneOn)}
        />
      ),
    },
  ],
});
