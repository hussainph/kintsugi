import { useRef, useState } from "react";
import { MotionStudy } from "@kintsugi/lab/adapters/dialkit";
import { Masonry } from "@/inspiration/Masonry";
import { Detail } from "@/inspiration/Detail";
import { UsedIn } from "@/references/UsedIn";
import { createInspirationFixtures } from "../../page/inspiration-library/fixtures";

type Props = {
  duration: number;
  reducedMotion: boolean;
  initialDetail: boolean;
};
/** Motion exists only in the experiment wrapper. Product modules are unchanged. */
export function ClipOpenStudy({
  duration,
  reducedMotion,
  initialDetail,
}: Props) {
  const [fixture] = useState(() =>
    createInspirationFixtures("experiment/clip-open"),
  );
  const [path, setPath] = useState<string | undefined>(
    initialDetail ? "inspiration/the-beauty-of-repair.md" : undefined,
  );
  const [revision, changed] = useState(0);
  const [selectedDocument, setSelectedDocument] = useState("");
  const triggerPath = useRef<string | null>(null);
  const keyboard = useRef(false);
  const grid = useRef<HTMLDivElement>(null);
  const close = () => {
    setPath(undefined);
    requestAnimationFrame(() => {
      const trigger =
        triggerPath.current &&
        grid.current?.querySelector<HTMLButtonElement>(
          `[data-clip-path="${CSS.escape(triggerPath.current)}"]`,
        );
      (trigger || grid.current)?.focus();
    });
  };
  const items = fixture.search().clips;
  const detail = path && (
    <Detail
      key={path}
      path={path}
      onClose={close}
      onChanged={() => changed(revision + 1)}
      renderUsedIn={(clip) => (
        <UsedIn
          root="lab://motion"
          path={clip.path}
          onOpen={setSelectedDocument}
        />
      )}
    />
  );
  return (
    <section
      className="flex h-svh min-h-0 flex-col gap-5 p-6"
      aria-label="Clip opening motion study"
    >
      <header className="max-w-3xl shrink-0 space-y-2">
        <p className="text-xs text-muted-foreground">
          Experiment · not a product motion token
        </p>
        <h1 className="text-xl font-medium">
          Keep the thread when a clip opens.
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Hypothesis: a short, non-bouncy settling movement makes the change
          from collection to detail easier to follow, without delaying reading.
          Replay and scrub the real detail below; compare with reduced motion.
        </p>
      </header>
      <div
        ref={grid}
        tabIndex={-1}
        className={
          path ? "hidden" : "flex min-h-0 flex-1 flex-col outline-none"
        }
        onPointerDownCapture={() => {
          keyboard.current = false;
        }}
        onKeyDownCapture={() => {
          keyboard.current = true;
        }}
      >
        <Masonry
          active={!path}
          items={items}
          total={items.length}
          loading={false}
          onOpen={(next) => {
            triggerPath.current = next;
            setPath(next);
          }}
          onMore={() => {}}
        />
      </div>
      {path &&
        (keyboard.current ? (
          <div className="flex min-h-0 flex-1 flex-col">{detail}</div>
        ) : (
          <MotionStudy
            key={`${path}:${duration}:${reducedMotion}`}
            name="Clip opens"
            duration={duration}
            reducedMotion={reducedMotion}
          >
            {(style) => (
              <div className="flex min-h-0 flex-1 flex-col" style={style}>
                {detail}
              </div>
            )}
          </MotionStudy>
        ))}
      {selectedDocument && (
        <p className="text-xs text-muted-foreground" role="status">
          Selected writing: {selectedDocument}
        </p>
      )}
    </section>
  );
}
