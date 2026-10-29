import { useRef, useState } from "react";
import { Masonry } from "@/inspiration/Masonry";
import { Detail } from "@/inspiration/Detail";
import { UsedIn } from "@/references/UsedIn";
import { Button } from "@kintsugi/ui/components/button";
import { WritingPreview } from "../../page/writing/preview";
import { createInspirationFixtures } from "../../page/inspiration-library/fixtures";

/** Private card UI is reached through the real public Masonry or Writing surfaces. */
export function ClipCardsPreview({
  kind = "all",
  entryId = "component/clip-card",
}: {
  kind?: string;
  entryId?: string;
}) {
  const [fixture] = useState(() => createInspirationFixtures(entryId));
  const [detail, setDetail] = useState<string>();
  const [revision, changed] = useState(0);
  const [notice, setNotice] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const items = fixture
    .search()
    .clips.filter((clip) => kind === "all" || clip.kind === kind);
  return (
    <section
      className="flex h-svh min-h-0 flex-col gap-6 p-7"
      aria-label="Clip card study"
    >
      <header>
        <p className="text-xs text-muted-foreground">
          Inspiration · real Masonry cards
        </p>
        <h1 className="mt-2 text-xl font-medium">
          A little company for a thought.
        </h1>
      </header>
      {detail ? (
        <Detail
          key={detail}
          path={detail}
          onClose={() => {
            setDetail(undefined);
            requestAnimationFrame(() => trigger.current?.focus());
          }}
          onChanged={() => changed(revision + 1)}
          renderUsedIn={(clip) => (
            <UsedIn root="lab://cards" path={clip.path} onOpen={setNotice} />
          )}
        />
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col"
          onClickCapture={(event) => {
            const element = event.target as HTMLElement;
            trigger.current = element.closest<HTMLButtonElement>(
              "button[data-clip-path]",
            );
          }}
        >
          <Masonry
            active
            items={items}
            total={items.length}
            loading={false}
            onOpen={setDetail}
            onMore={() => {}}
          />
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          Selected writing: {notice}
        </p>
      )}
    </section>
  );
}
export function ReferenceClipPreview() {
  const [hint, setHint] = useState(true);
  return (
    <div className="relative">
      {hint && (
        <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between border-b bg-background px-5 py-2 text-xs text-muted-foreground">
          <span>
            Open “The beauty of repair” in the margin to exercise Writing’s
            private ClipCard.
          </span>
          <Button variant="ghost" size="xs" onClick={() => setHint(false)}>
            Dismiss
          </Button>
        </div>
      )}
      <WritingPreview entryId="component/clip-card" margin />
    </div>
  );
}
