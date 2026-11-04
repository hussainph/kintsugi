import { ArrowLeft, Check, Loader2, MessagesSquare, Plus, RotateCcw, Search, Sparkles } from "@kintsugi/ui/icons";
import { Button } from "@kintsugi/ui/components/button";
import { Input } from "@kintsugi/ui/components/input";
import { useEffect, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { threads as api, type Anchor, type Thread } from "@/lib/chat";
import { snippet } from "@/lib/chips";
import { REVIEWS } from "@/refine/review";
import { requestReview } from "@/refine/reviews";
import { KinComposer, KinHelpers, KinLog, KinSuggestions } from "./Conversation";
import { openLink } from "./links";
import {
  ACTIVE,
  type KinState,
  newAnchor,
  newThread,
  openThread,
  rename,
  search,
  setStatus,
  setVisible,
  showAll,
  showList,
  subject,
  useKin,
} from "./useKin";

export { useKinStatus } from "./useKin";

/** "14:05" today, "Nov 3" this year, "Nov 3, 2025" before. */
function when(at: string) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString(undefined, date.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** A message as one plain line: no Markdown marks or link brackets. */
const plain = (text: string) =>
  text
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, target: string, alias: string) => alias || target)
    .replace(/\*+|`+|^[#>\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** What a thread is about, as one line, when the list doesn't already say. */
function aboutLabel(anchor: Anchor | undefined) {
  if (!anchor || anchor.kind === "paragraph") return null;
  return anchor.label?.trim() || anchor.path.replace(/^.*\//, "").replace(/\.mdx?$/, "");
}

/** The passage a paragraph thread is about. */
function Passage({ anchor, clamp = true }: { anchor: Anchor; clamp?: boolean }) {
  const text = anchor.quote?.exact ?? "";
  if (!text.trim()) return null;
  return (
    <blockquote className="ki-kin-passage" data-orphaned={anchor.orphaned || undefined} data-clamp={clamp || undefined} title={anchor.orphaned ? "No longer in the draft" : undefined}>
      {clamp ? snippet(plain(text), 160) : plain(text)}
    </blockquote>
  );
}

function ThreadRow({ thread, s, showAbout }: { thread: Thread; s: KinState; showAbout: boolean }) {
  const running = !!s.live[thread.id] || s.list.running.includes(thread.id);
  const about = showAbout ? aboutLabel(thread.anchor) : null;
  return (
    <li>
      <button type="button" className="ki-kin-row" data-thread={thread.id} data-status={thread.status} onClick={() => openThread(thread.id)}>
        <span className="ki-kin-row-head">
          <span className="ki-kin-row-title">{thread.title || "Untitled"}</span>
          {running ? (
            <Loader2 aria-label="Kin is answering" className="ki-kin-row-busy" />
          ) : s.unread.has(thread.id) ? (
            <span aria-label="New reply" className="ki-kin-row-unread" />
          ) : null}
          <span className="ki-kin-row-time">{when(thread.updated)}</span>
        </span>
        {thread.anchor?.kind === "paragraph" && <Passage anchor={thread.anchor} />}
        {about && <span className="ki-kin-row-about">{about}</span>}
        {(thread.hit || thread.preview) && <span className="ki-kin-row-preview">{plain(thread.hit ?? thread.preview)}</span>}
        {thread.status === "resolved" && (
          <span className="ki-kin-row-resolved">
            <Check aria-hidden /> Resolved
          </span>
        )}
      </button>
    </li>
  );
}

function Rows({ threads, s, showAbout }: { threads: Thread[]; s: KinState; showAbout: boolean }) {
  return (
    <ul className="ki-kin-rows">
      {threads.map((t) => (
        <ThreadRow key={t.id} thread={t} s={s} showAbout={showAbout} />
      ))}
    </ul>
  );
}

/** The screen's threads: this draft's in the editor; elsewhere, what's on
 *  screen first, then recent ones. */
function ListView({ s, onManage }: { s: KinState; onManage: () => void }) {
  const about = subject(s.screen);
  const inDraft = about?.kind === "doc";
  const reviewing = inDraft && s.list.reviewing.includes(about.path);
  const mine = s.list.threads;
  return (
    <>
      <div className="ki-kin-bar">
        <Button variant="ghost" size="sm" className="ki-kin-bar-new" onClick={() => newThread(about)} data-new-thread>
          <Plus /> New thread
        </Button>
        <Button variant="ghost" size="sm" onClick={showAll} data-all-threads>
          <MessagesSquare /> All threads
        </Button>
      </div>
      <div className="ki-kin-list" aria-label="Threads">
        {reviewing ? (
          <p className="ki-kin-reviewing" data-reviewing>
            <Loader2 aria-hidden /> Kin is reviewing this draft
            <Button variant="ghost" size="xs" onClick={() => void api.reviewStop(about.path).catch((e) => toast.error(String(e)))}>
              Stop
            </Button>
          </p>
        ) : inDraft && (
          // Asked suggestions (KI-109): Kin marks the draft, and the card under each steps through them.
          <div className="ki-kin-review" role="group" aria-label="Review">
            {REVIEWS.map((r) => (
              <Button key={r.id} variant="ghost" size="sm" data-review={r.id} onClick={() => {
                if (!requestReview(about.path, r.id)) toast("Open the draft to review it.");
              }}>
                <Sparkles /> {r.label}
              </Button>
            ))}
          </div>
        )}
        {inDraft ? (
          mine.length ? (
            <Rows threads={mine} s={s} showAbout={false} />
          ) : (
            !reviewing && (
              <div className="ki-kin-list-empty">
                <p>No threads on this draft yet.</p>
                <KinSuggestions s={s} />
              </div>
            )
          )
        ) : (
          <>
            {about && mine.length > 0 && (
              <section aria-label={aboutLabel(about) ?? undefined}>
                <h3 className="ki-kin-group">{aboutLabel(about)}</h3>
                <Rows threads={mine} s={s} showAbout={false} />
              </section>
            )}
            {s.recent.length > 0 && (
              <section aria-label="Recent">
                {about && mine.length > 0 && <h3 className="ki-kin-group">Recent</h3>}
                <Rows threads={s.recent} s={s} showAbout />
              </section>
            )}
            {!mine.length && !s.recent.length && <p className="ki-kin-list-empty">No threads yet.</p>}
          </>
        )}
      </div>
      <div className="ki-kin-footer">
        <KinHelpers helpers={s.helpers.filter((j) => ACTIVE.includes(j.status))} />
        <KinComposer s={s} onManage={onManage} />
      </div>
    </>
  );
}

/** Every thread in the vault, resolved ones too, searchable. */
function AllView({ s }: { s: KinState }) {
  return (
    <>
      <div className="ki-kin-bar">
        <Button variant="ghost" size="icon-sm" aria-label="Back" title="Back" onClick={showList}>
          <ArrowLeft />
        </Button>
        <label className="ki-kin-search">
          <Search aria-hidden />
          <Input autoFocus value={s.query} onChange={(e) => search(e.target.value)} placeholder="Search threads" aria-label="Search threads" />
        </label>
      </div>
      <div className="ki-kin-list" aria-label="All threads">
        {s.all === null ? null : s.all.length ? (
          <Rows threads={s.all} s={s} showAbout />
        ) : (
          <p className="ki-kin-list-empty">{s.query.trim() ? "No thread matches." : "No threads yet."}</p>
        )}
      </div>
    </>
  );
}

/** A thread's title, renamed in place. */
function Title({ thread }: { thread: Thread }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(thread.title);
  useEffect(() => setText(thread.title), [thread.title]);
  if (!editing)
    return (
      <button type="button" className="ki-kin-title" title="Rename" onClick={() => setEditing(true)} data-thread-title>
        {thread.title || "Untitled"}
      </button>
    );
  const done = (save: boolean) => {
    setEditing(false);
    if (save && text.trim() !== thread.title) rename(thread, text);
    else setText(thread.title);
  };
  return (
    <Input
      autoFocus
      className="ki-kin-title-input"
      aria-label="Thread title"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") {
          e.stopPropagation();
          done(false);
        }
      }}
    />
  );
}

/** What the thread is about, above its messages: the passage, or the item. */
function About({ anchor }: { anchor: Anchor | null | undefined }) {
  if (!anchor) return null;
  if (anchor.kind === "paragraph")
    return (
      <button type="button" className="ki-kin-about-passage" onClick={() => openLink(anchor.path)} title={anchor.path}>
        <Passage anchor={anchor} clamp />
      </button>
    );
  const label = aboutLabel(anchor);
  const open = anchor.kind === "doc" || anchor.kind === "clip" ? () => openLink(anchor.path) : undefined;
  return (
    <p className="ki-kin-about">
      {open ? (
        <button type="button" className="ki-kin-path" onClick={open}>
          {label}
        </button>
      ) : (
        label
      )}
    </p>
  );
}

function ThreadView({ s, onManage }: { s: KinState; onManage: () => void }) {
  const thread = s.view?.thread;
  const isNew = s.mode.kind === "new";
  const working = s.helpers.filter((j) => ACTIVE.includes(j.status));
  const anchor = isNew ? newAnchor(s) : thread?.anchor;
  return (
    <>
      <header className="ki-kin-bar ki-kin-thread-bar">
        <Button variant="ghost" size="icon-sm" aria-label="Back" title="Back" onClick={showList} data-back>
          <ArrowLeft />
        </Button>
        {isNew ? <span className="ki-kin-title" data-new>New thread</span> : thread ? <Title thread={thread} /> : <span className="ki-kin-title" />}
        {thread &&
          (thread.status === "open" ? (
            <Button variant="ghost" size="sm" onClick={() => setStatus(thread, "resolved")} data-resolve>
              <Check /> Resolve
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setStatus(thread, "open")} data-reopen>
              <RotateCcw /> Reopen
            </Button>
          ))}
      </header>
      <About anchor={anchor} />
      <KinLog s={s} />
      <div className="ki-kin-footer">
        <KinHelpers helpers={working} />
        <KinComposer s={s} onManage={onManage} />
      </div>
    </>
  );
}

/**
 * Kin's tab in the right margin (KI-103, KI-104): the screen's threads, one
 * thread open, or all of them. It fills its panel; the margin shows and hides
 * it, and Escape calls `onHide`. Its state outlives it (`useKin`), so a
 * thread stays open while the tab is away.
 */
export function KinTab({ onHide }: { onHide?: () => void }) {
  const s = useKin();
  useEffect(() => {
    setVisible(true);
    return () => setVisible(false);
  }, []);
  const onManage = onHide ?? (() => {});
  return (
    <section
      className="ki-kin-tab"
      aria-label="Kin"
      data-kin-mode={s.mode.kind}
      onKeyDown={(e) => {
        // Escape puts Kin away (a menu's Escape, in a portal, closes only the menu);
        // the thread stays where he left it.
        if (e.key !== "Escape" || e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
        e.stopPropagation();
        onHide?.();
      }}
    >
      {s.mode.kind === "list" ? <ListView s={s} onManage={onManage} /> : s.mode.kind === "all" ? <AllView s={s} /> : <ThreadView s={s} onManage={onManage} />}
    </section>
  );
}

