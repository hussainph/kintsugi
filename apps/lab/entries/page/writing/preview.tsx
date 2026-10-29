import {
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { Writing } from "@/references/Writing";
import { Palette, type PaletteMode } from "@/components/Palette";
import { Sidebar } from "@/components/Sidebar";
import { Button } from "@kintsugi/ui/components/button";
import {
  SidebarProvider,
  SidebarTrigger,
} from "@kintsugi/ui/components/sidebar";
import { UsedIn } from "@/references/UsedIn";
import { Library } from "@/inspiration/Library";
import { Toaster } from "sonner";
import {
  createInspirationFixtures,
  documentTree,
  writingPath,
  writingText,
} from "../inspiration-library/fixtures";

type Props = {
  entryId: string;
  initialText?: string;
  margin?: boolean;
  navigation?: boolean;
  fontSize?: number;
  lineHeight?: number;
  contentPadding?: number;
  contentGutter?: number;
  rootRadius?: number;
};
/** Real editor / Writing integration, not a reconstruction of private margin/chip components. */
export function WritingPreview({
  entryId,
  initialText = writingText,
  margin = true,
  navigation = false,
  fontSize = 19,
  lineHeight = 1.7,
  contentPadding = 88,
  contentGutter = 32,
  rootRadius,
}: Props) {
  const [fixtures] = useState(() => {
    const fixture = createInspirationFixtures(entryId);
    fixture.documents[0].text = initialText;
    // Product convenience state is seeded only at runtime on the separate Lab origin.
    try {
      localStorage.setItem("kintsugi:margin", margin ? "visible" : "hidden");
    } catch {
      /* Storage may be disabled. */
    }
    return fixture;
  });
  const [active, setActive] = useState(writingPath);
  const [text, setText] = useState(initialText);
  const [clip, setClip] = useState<{ path: string; seq: number }>();
  const [library, setLibrary] = useState(false);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [tree, setTree] = useState(documentTree);
  const [selectedDir, setSelectedDir] = useState("");
  const [notice, setNotice] = useState("Saved in this preview only");
  const viewRef =
    useRef<ComponentProps<typeof Writing>["viewRef"]["current"]>(null);
  const openDocument = (path: string) => {
    const doc = fixtures.documents.find((doc) => doc.path === path);
    if (doc) {
      setActive(path);
      setText(doc.text);
      setLibrary(false);
    } else setNotice(`Document not found in fixture: ${path}`);
  };
  const openClip = (path: string) => {
    setClip({ path, seq: (clip?.seq ?? 0) + 1 });
    setLibrary(true);
  };
  const style = {
    "--radius": rootRadius === undefined ? undefined : `${rootRadius}rem`,
  } as CSSProperties;
  const writing = (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {navigation && (
        <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPalette({ kind: "open" })}
          >
            Jump to a document…
          </Button>
          <span className="ml-auto truncate text-xs text-muted-foreground">
            {active}
          </span>
        </header>
      )}
      <div className="relative flex min-h-0 flex-1">
        {library ? (
          <Library
            openClip={clip}
            renderUsedIn={(item) => (
              <UsedIn
                root="lab://writing"
                path={item.path}
                onOpen={openDocument}
              />
            )}
          />
        ) : (
          <Writing
            root="lab://writing"
            path={active}
            text={text}
            viewRef={viewRef}
            onOpenDoc={openDocument}
            onOpenClip={navigation ? openClip : undefined}
            onChange={(path, next) => {
              fixtures.saveDocument(path, next);
              setText(next);
              setNotice("Saved in this preview only");
            }}
          />
        )}
      </div>
      {navigation && (
        <footer className="flex h-8 shrink-0 items-center justify-between border-t px-4 text-[11px] text-muted-foreground">
          <span>{notice}</span>
          <span>{text.trim().split(/\s+/).length} words</span>
        </footer>
      )}
    </div>
  );
  return (
    <div
      className="lab-writing-preview h-svh min-h-0 overflow-hidden bg-background text-foreground"
      style={style}
    >
      <style>{`.lab-writing-preview .cm-editor{font-size:${fontSize}px}.lab-writing-preview .cm-scroller{line-height:${lineHeight}}.lab-writing-preview .cm-content{padding-top:${contentPadding}px;padding-left:${contentGutter}px;padding-right:${contentGutter}px}`}</style>
      {navigation ? (
        <SidebarProvider className="h-full min-h-0!">
          <Sidebar
            tree={tree}
            vaultName="Lab writing"
            active={library ? null : active}
            libraryOpen={library}
            onLibrary={() => {
              setClip(undefined);
              setLibrary(true);
            }}
            selectedDir={selectedDir}
            onSelectDir={setSelectedDir}
            onOpen={openDocument}
            onNewDoc={() =>
              setNotice(
                "Use the command-palette entry to explore naming a new document.",
              )
            }
            onNewFolder={() =>
              setNotice(
                "Folder creation is not connected in this writing preview.",
              )
            }
            onRename={(path, name) => {
              setNotice(`Renamed ${path} to ${name} in the sidebar fixture`);
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
            }}
            onTrash={(path) => {
              setTree((old) => old.filter((entry) => entry.path !== path));
              setNotice(`Removed ${path} from the sidebar fixture`);
            }}
            phoneOn={false}
            onPhone={() =>
              setNotice(
                "Phone pairing is deliberately unavailable in fixture mode.",
              )
            }
          />
          {writing}
          <Palette
            mode={palette}
            docs={fixtures.documents.map((doc) => ({
              kind: "doc",
              name: doc.path,
              path: doc.path,
              title: doc.title,
              status: doc.status,
            }))}
            onOpen={(path) => {
              openDocument(path);
              setPalette(null);
            }}
            onClose={() => setPalette(null)}
            onCreate={() => setPalette(null)}
          />
        </SidebarProvider>
      ) : (
        writing
      )}
      <Toaster />
    </div>
  );
}
