import { openUrl } from "@tauri-apps/plugin-opener";
import { Bookmark, Brain, Check, Clock, Coins, Copy, FileText, Hourglass, Lightbulb, Loader2, Pilcrow, Rss, Unplug, AlertCircle, X } from "@kintsugi/ui/icons";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
  ChainOfThoughtSteps,
  ChatNotice,
  CodeBlock,
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
  Message,
  MessageAction,
  MessageActions,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageStatus,
  PromptInput,
  PromptInputChip,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
  Response,
  type ResponseComponents,
  Suggestion,
  Suggestions,
  useCopy,
} from "@kintsugi/ui/ai";
import { Button } from "@kintsugi/ui/components/button";
import type { Entry, Job } from "@/lib/chat";
import { type Chip, chipKey, chipTitle, snippet } from "@/lib/chips";
import { openSettings } from "@/lib/kin";
import { onStashTarget, stashReply, stashTarget } from "@/lib/stash";
import { KinAvatar } from "./Avatar";
import { parseEdit } from "./edits";
import { EditProposal } from "./EditProposal";
import { openLink, splitPaths } from "./links";
import { ChatModelPicker } from "./ModelPicker";
import { cost, describeStep, isTimeout, modelShort, stepsSummary } from "./steps";
import { again, chipsOf, type KinState, type Live, removeChip, send, setDraft, stop, stopHelper } from "./useKin";
import { WebSources } from "./WebSources";

const chipIcon = (kind: string) =>
  kind === "clip" ? Bookmark : kind === "feed" ? Rss : kind === "idea" ? Lightbulb : kind === "paragraph" || kind === "selection" ? Pilcrow : FileText;

const chipTooltip = (chip: Chip) => `${chip.kind} · ${chip.path}${chip.lines ? ` · lines ${chip.lines[0]}–${chip.lines[1]}` : ""}`;

function ChipView({ chip, onRemove }: { chip: Chip; onRemove?: () => void }) {
  return <PromptInputChip data-chip={chipKey(chip)} icon={chipIcon(chip.kind)} label={chipTitle(chip)} title={chipTooltip(chip)} onRemove={onRemove} />;
}

/** A path Kin named, as a link that opens it. */
function PathLink({ path, children }: { path: string; children?: ReactNode }) {
  return (
    <button type="button" className="ki-kin-path" data-path={path} onClick={() => openLink(path)}>
      {children ?? path}
    </button>
  );
}

/** How Kin's Markdown meets the app: paths and [[links]] open, web links go
 *  to the browser, edit blocks become edits he can apply. */
function replyComponents(id: string): ResponseComponents {
  let edits = 0;
  return {
    text: (text) => {
      const parts = splitPaths(text);
      if (parts.length === 1 && typeof parts[0] === "string") return text;
      return parts.map((part, i) => (typeof part === "string" ? part : <PathLink key={i} path={part.path} />));
    },
    inlineCode: (code) => (/^(?:[\w.-]+\/)+[\w .-]+\.mdx?$/.test(code.trim()) ? <PathLink path={code.trim()}><code className="ki-response-inline-code">{code}</code></PathLink> : undefined),
    wikilink: ({ target, label }) => (
      <button type="button" className="ki-kin-path ki-kin-wikilink" data-target={target} onClick={() => openLink(target)}>
        {label}
      </button>
    ),
    link: ({ href, children }) => (
      <a
        href={href}
        className="ki-response-link"
        onClick={(e) => {
          e.preventDefault();
          void openUrl(href).catch((err) => toast.error(String(err)));
        }}
      >
        {children}
      </a>
    ),
    code: ({ info, code, complete }) => {
      if (!/^edit\b/i.test(info)) return undefined;
      const edit = complete ? parseEdit(info, code) : null;
      const at = edits++;
      if (!edit) return <CodeBlock code={code} />;
      return <EditProposal edit={edit} id={`${id}:${at}`} />;
    },
  };
}

function KinText({ text, id, streaming }: { text: string; id: string; streaming?: boolean }) {
  return <Response streaming={streaming} components={replyComponents(id)}>{text}</Response>;
}

/** What Kin did for a finished reply, folded to one line. */
function Steps({ entry }: { entry: Entry }) {
  const tools = entry.tools ?? [];
  const summary = stepsSummary(tools.length, entry.ms);
  if (!summary) return null;
  if (!tools.length)
    return (
      <div className="ki-chain-header" data-steps="thought">
        <Brain className="ki-chain-header-icon" aria-hidden />
        <span>{summary}</span>
      </div>
    );
  return (
    <ChainOfThought data-steps={tools.length}>
      <ChainOfThoughtHeader>{summary}</ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {tools.map((tool, i) => {
          const step = describeStep(tool.name, tool.arguments);
          return <ChainOfThoughtStep key={i} status={tool.error ? "error" : "done"} icon={step.icon} label={step.label} title={step.label} />;
        })}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

function ReplyActions({ entry, latest }: { entry: Entry; latest: boolean }) {
  const { copied, copy } = useCopy();
  const target = useSyncExternalStore(onStashTarget, stashTarget, () => null);
  const meta = [modelShort(entry.model), cost(entry.usd)].filter(Boolean).join(" · ");
  return (
    <MessageActions pinned={latest}>
      {!entry.error && (
        <MessageAction label={copied ? "Copied" : "Copy"} onClick={() => void copy(entry.text)}>
          {copied ? <Check /> : <Copy />}
        </MessageAction>
      )}
      {!entry.error && !entry.interrupted && target && <MessageAction label="Stash" onClick={async () => {
        try { if (!await stashReply(entry.text)) toast.error("Couldn’t add to stash"); }
        catch (error) { toast.error(String(error)); }
      }}><Bookmark /></MessageAction>}
      {meta && <span className="ki-message-meta" data-model={entry.model}>{meta}</span>}
    </MessageActions>
  );
}

function ReplyError({ entry, onRetry }: { entry: Entry; onRetry?: () => void }) {
  const error = entry.error ?? "";
  const timeout = isTimeout(error);
  return (
    <ChatNotice
      tone="error"
      icon={timeout ? Unplug : AlertCircle}
      title={timeout ? "The model stopped responding" : "Kin couldn’t answer"}
      detail={error}
      data-error={timeout ? "timeout" : "failed"}
      actions={
        onRetry && (
          <Button variant="ghost" size="xs" onClick={onRetry}>
            Try again
          </Button>
        )
      }
    />
  );
}

function CapReached() {
  return (
    <ChatNotice
      tone="warning"
      icon={Coins}
      title="This month’s cap is reached"
      detail="Helpers wait for next month or a higher cap."
      data-cap-reached
      actions={
        <Button variant="ghost" size="xs" onClick={() => openSettings("kin")}>
          Change cap
        </Button>
      }
    />
  );
}

function HelperReport({ entry, fresh }: { entry: Entry; fresh: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = entry.text.length > 220 || entry.text.split("\n").length > 4;
  return (
    <Message from="helper" fresh={fresh} data-entry={entry.seq} data-role="helper">
      <MessageContent data-expanded={expanded || !long || undefined} className="ki-kin-helper">
        <Response components={replyComponents(`h${entry.seq}`)}>{entry.text}</Response>
        {long && (
          <button type="button" className="ki-kin-more" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </MessageContent>
    </Message>
  );
}

type EntryProps = { entry: Entry; waiting: boolean; fresh: boolean; latest: boolean; onRetry: (entry: Entry) => void };

function KinEntry({ entry, waiting, fresh, latest, onRetry }: EntryProps) {
  if (entry.role === "owner") {
    return (
      <Message from="owner" fresh={fresh} data-entry={entry.seq} data-role="owner">
        <MessageContent>{entry.text}</MessageContent>
        {(entry.chips?.length || waiting) && (
          <MessageFooter>
            {entry.chips?.map((c) => <ChipView key={chipKey(c)} chip={c} />)}
            {waiting && (
              <MessageStatus data-waiting>
                <Clock aria-hidden /> Waiting
              </MessageStatus>
            )}
          </MessageFooter>
        )}
      </Message>
    );
  }
  if (entry.role === "helper") return <HelperReport entry={entry} fresh={fresh} />;
  const retry = entry.error ? () => onRetry(entry) : undefined;
  return (
    <Message from="assistant" data-entry={entry.seq} data-role="kin" data-review={entry.review || undefined}>
      <MessageAvatar>
        <KinAvatar />
      </MessageAvatar>
      <MessageContent>
        <Steps entry={entry} />
        {entry.error ? (
          <ReplyError entry={entry} onRetry={retry} />
        ) : (
          <div className="ki-kin-reply">
            <KinText text={entry.text} id={`r${entry.seq}`} />
            {entry.interrupted && (
              <MessageStatus data-interrupted>Interrupted</MessageStatus>
            )}
          </div>
        )}
        {!!entry.web?.length && <WebSources calls={entry.web} />}
        {entry.capReached && <CapReached />}
        <ReplyActions entry={entry} latest={latest} />
      </MessageContent>
    </Message>
  );
}

/** The turn under way: Kin thinking, its steps as they run, its words as they come. */
function LiveTurn({ live }: { live: Live | null }) {
  const steps = live?.steps ?? [];
  const text = live?.text ?? "";
  const busy = steps.some((s) => s.status === "running");
  return (
    <Message from="assistant" data-live={live ? "" : undefined} data-listening={live ? undefined : ""} aria-busy>
      <MessageAvatar>
        <KinAvatar talking />
      </MessageAvatar>
      <MessageContent>
        {steps.length > 0 && (
          <ChainOfThoughtSteps aria-label="What Kin is doing">
            {steps.map((s) => {
              const step = describeStep(s.name, s.args);
              return <ChainOfThoughtStep key={s.id} status={s.status} icon={step.icon} label={step.label} title={step.label} />;
            })}
          </ChainOfThoughtSteps>
        )}
        {!text && !busy && (
          <ChainOfThoughtHeader live icon={Brain}>
            Thinking
          </ChainOfThoughtHeader>
        )}
        {live && live.web.length > 0 && <WebSources calls={live.web} />}
        {text && <KinText text={text} id={`live-${live?.turn}`} streaming />}
      </MessageContent>
    </Message>
  );
}

const SUGGESTIONS: Record<string, string[]> = {
  doc: ["Who disagrees?", "Find a clip", "Have I said this before?"],
  paragraph: ["Who disagrees?", "Find a clip", "Tighten this"],
  clip: ["Why did I save this?", "Where could I use this?"],
  feed: ["Is this worth reading?", "What does it add?"],
  idea: ["Is this worth writing?", "What would I need?"],
};

/** A few asks to send in one click, for what's on screen. */
export function KinSuggestions({ s }: { s: KinState }) {
  const first = chipsOf(s)[0];
  const kind = s.mode.kind === "new" && s.mode.anchor?.kind === "paragraph" ? "paragraph" : first?.kind === "selection" ? "paragraph" : first?.kind;
  const asks = (kind && SUGGESTIONS[kind]) || [];
  if (!asks.length) return null;
  return (
    <Suggestions>
      {asks.map((ask) => (
        <Suggestion key={ask} suggestion={ask} onPick={(text) => void send(text)} />
      ))}
    </Suggestions>
  );
}

/** A thread's messages, the turn under way, and a way back to the latest. */
export function KinLog({ s }: { s: KinState }) {
  const view = s.view;
  const entries = view?.entries ?? [];
  const thread = s.mode.kind === "thread" ? s.mode.id : null;
  const live = (thread && s.live[thread]) || null;
  const answering = new Set(view?.running?.answers ?? []);
  const pending = view?.pending ?? [];
  const listening = !live && pending.length > 0;
  const lastKin = [...entries].reverse().find((e) => e.role === "kin")?.seq;
  return (
    <Conversation resetKey={thread ?? s.mode.kind} className="ki-kin-log">
      <ConversationContent aria-label="Conversation" aria-live="polite">
        {!entries.length && !live && !listening && (
          <ConversationEmptyState icon={<KinAvatar className="ki-kin-empty-avatar" />} title="Ask Kin anything.">
            <KinSuggestions s={s} />
          </ConversationEmptyState>
        )}
        {entries.map((entry) => {
          const fresh = s.seenThrough !== null && entry.seq > s.seenThrough && entry.role !== "kin";
          return (
            <div key={entry.seq} className="ki-kin-entry">
              <KinEntry entry={entry} fresh={fresh} latest={entry.seq === lastKin && !live} waiting={pending.includes(entry.seq) && !answering.has(entry.seq)} onRetry={(e) => again(e.thread)} />
            </div>
          );
        })}
        {(live || listening) && <LiveTurn live={live} />}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

const JOB_ICON = { running: Loader2, waiting: Hourglass, queued: Clock } as const;
const JOB_LEAD = { running: "Helper working: ", waiting: "Waiting for the monthly cap: ", queued: "Queued: " } as const;

/** Helpers at work, above the composer. */
export function KinHelpers({ helpers }: { helpers: Job[] }) {
  if (!helpers.length) return null;
  return (
    <ul className="ki-kin-helpers" aria-label="Helpers">
      {helpers.slice(0, 3).map((j) => {
        const status = j.status as keyof typeof JOB_ICON;
        const Icon = JOB_ICON[status] ?? Clock;
        return (
          <li key={j.id} className="ki-kin-helper-row" data-job={j.status}>
            <Icon aria-hidden className="ki-kin-helper-icon" />
            <span className="ki-kin-helper-text" title={j.brief}>
              {JOB_LEAD[status] ?? ""}
              {snippet(j.brief, 60)}
            </span>
            <Button variant="ghost" size="icon-xs" aria-label="Stop this helper" title="Stop this helper" onClick={() => stopHelper(j)}>
              <X />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** The composer: what goes with the message, the field, the model and send. */
export function KinComposer({ s, onManage }: { s: KinState; onManage: () => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const thread = s.mode.kind === "thread" ? s.mode.id : null;
  const talking = !!(thread && s.live[thread]);
  const streaming = talking && !s.draft.trim();
  const chips = chipsOf(s);
  useEffect(() => {
    if (s.focus) requestAnimationFrame(() => input.current?.focus());
  }, [s.focus]);
  return (
    <PromptInput className="ki-kin-composer" onSubmit={() => void send()}>
      {chips.length > 0 && (
        <PromptInputHeader aria-label="Context">
          {chips.map((c) => (
            <ChipView key={chipKey(c)} chip={c} onRemove={() => removeChip(c)} />
          ))}
        </PromptInputHeader>
      )}
      <PromptInputTextarea
        ref={input}
        aria-label="Message Kin"
        placeholder={talking ? "Type to interrupt…" : thread ? "Reply…" : "Ask Kin…"}
        value={s.draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <PromptInputToolbar>
        <PromptInputTools>
          <ChatModelPicker conversation={thread ?? ""} vault={s.vaultSeq} onManage={onManage} />
        </PromptInputTools>
        <PromptInputSubmit status={streaming ? "streaming" : "ready"} onStop={stop} disabled={!s.draft.trim()} aria-label={streaming ? "Stop Kin" : "Send"} title={streaming ? "Stop Kin" : "Send"} />
      </PromptInputToolbar>
    </PromptInput>
  );
}
