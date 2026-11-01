import { useState } from "react";
import { contentTypes, displayTitle, type Clip, type ContentType, type Note } from "./clips";
import { clips } from "./vault";
import { CardWithThread, Expandable, Hybrid, LongPage } from "./shapes";

const shapes = {
  a: { title: "A · Card with a note thread", render: CardWithThread },
  b: { title: "B · Card that expands", render: Expandable },
  c: { title: "C · Long page", render: LongPage },
  ab: { title: "A→B · Card, then one tap deeper", render: Hybrid },
} as const;
export type ShapeId = keyof typeof shapes;


/** Lab-only: what the real capture kept and lost, beside the shape it feeds. */
function CaptureNote({ clip }: { clip: Clip }) {
  return (
    <aside className="space-y-1.5 self-start rounded-xl border border-dashed p-3 text-xs leading-relaxed text-muted-foreground" aria-label={`Capture notes for ${clip.label}`}>
      <p className="font-medium text-foreground">
        {clip.label} <span className="font-normal text-muted-foreground">· {clip.capture.pipeline}</span>
      </p>
      <p>{clip.capture.kept}</p>
      <ul className="list-disc space-y-0.5 pl-4">
        {clip.capture.lost.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </aside>
  );
}

export interface StudyProps {
  shape: ShapeId;
  only: ContentType | "all";
  open: boolean;
  annotate: boolean;
  reducedMotion: boolean;
}

export function ClipShapeStudy({ shape, only, open, annotate, reducedMotion }: StudyProps) {
  // Notes added in the Lab live in memory only; the fixtures never change.
  const [threads, setThreads] = useState<Record<string, Note[]>>(() =>
    Object.fromEntries(clips.map((clip) => [clip.path, clip.thread])),
  );
  const [page, setPage] = useState<ContentType>(only === "all" ? "article" : only);
  const note = (clip: Clip) => (text: string) => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const at = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    setThreads((all) => ({ ...all, [clip.path]: [...all[clip.path], { at, text }] }));
  };
  const Shape = shapes[shape].render;
  const props = (clip: Clip) => ({
    clip,
    notes: threads[clip.path],
    onNote: note(clip),
    reducedMotion,
    open,
  });

  if (shape === "c") {
    const clip = clips.find((c) => c.type === (only === "all" ? page : only))!;
    return (
      <main className="min-h-svh px-5 py-6 sm:px-8 sm:py-8">
        {only === "all" && (
          <nav aria-label="Clips" className="mx-auto mb-8 flex max-w-[1040px] gap-1 overflow-x-auto pb-1">
            {contentTypes.map((type) => {
              const item = clips.find((c) => c.type === type)!;
              return (
                <button
                  key={type}
                  type="button"
                  aria-current={type === page ? "page" : undefined}
                  onClick={() => setPage(type)}
                  className="shrink-0 rounded-full px-3 py-1 text-xs text-muted-foreground hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
                  title={displayTitle(item)}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
        )}
        <Shape key={clip.path} {...props(clip)} />
        {annotate && (
          <div className="mx-auto mt-10 max-w-[760px] lg:max-w-[1040px]">
            <CaptureNote clip={clip} />
          </div>
        )}
      </main>
    );
  }

  const shown = clips.filter((clip) => only === "all" || clip.type === only);
  return (
    <main className="min-h-svh px-4 py-6 sm:px-8 sm:py-10">
      <div className={`mx-auto space-y-8 ${annotate ? "max-w-[920px]" : "max-w-[600px]"}`}>
        {shown.map((clip) => (
          <div key={clip.path} className={annotate ? "grid gap-3 md:grid-cols-[minmax(0,600px)_minmax(0,1fr)] md:gap-6" : undefined}>
            <Shape {...props(clip)} />
            {annotate && <CaptureNote clip={clip} />}
          </div>
        ))}
      </div>
    </main>
  );
}
