import { merge3 } from '@kintsugi/core/merge';
import { type Remote, SECTIONS_API, STORIES_API, Unpaired, version } from '@kintsugi/core/remote';
import type { FeedAction, FeedEntry, FeedItem, Impression, Pick as FeedPick, Place, Reason, Story, SummaryState } from '@kintsugi/core/sections';

import type { Connection, KV } from './library';
import { Waiting } from './waiting.ts';

/** An action taken on the phone, waiting for the Mac. Every one becomes the
 *  same event the Mac's own Feed logs, so ranking learns from both alike. */
export type FeedOp =
  | { kind: 'act'; id: number; action: FeedAction; place?: Place }
  | { kind: 'save'; id: number; place?: Place }
  | { kind: 'dismiss'; ids: number[]; undo: boolean; place?: Place }
  /** `base` is the Mac's note when he started (`baseText`), at its version. */
  | { kind: 'note'; id: number; note: string; base: string; baseText: string; place?: Place }
  | { kind: 'impressions'; impressions: Impression[] };

export type FeedClient = Pick<
  Remote,
  'feed' | 'picked' | 'feedRead' | 'feedAct' | 'feedNote' | 'feedSave' | 'feedImpressions' | 'feedEntries' | 'feedStory' | 'feedWhy' | 'feedDismiss'
>;

type State = {
  items: FeedItem[];
  total: number;
  picks: FeedPick[];
  entries?: FeedEntry[];
  stories?: Record<string, Story>;
  reasons?: Record<string, Reason[]>;
  /** Articles he opened, as the Mac sent them, to read again offline. */
  texts: Record<string, string>;
  /** A note changed both here and on the Mac: his words, and the Mac's. */
  conflicts: Record<string, { mine: string; theirs: string; version: string }>;
};

/** An item as the phone shows it: the Mac's copy with his waiting actions applied. */
export type LocalItem = FeedItem & {
  /** Something about it is still waiting for the Mac. */
  waiting: boolean;
};

export type LocalStory = Omit<Story, 'lead' | 'items'> & { lead: LocalItem; items: LocalItem[] };
export type LocalEntry = { kind: 'item'; item: LocalItem } | { kind: 'story'; story: LocalStory };

export type FeedSnapshot = {
  items: LocalItem[];
  entries: LocalEntry[];
  picks: (Omit<FeedPick, 'item' | 'story'> & { item: LocalItem; story?: LocalStory })[];
  total: number;
  waiting: number;
  conflicts: State['conflicts'];
  connection: Connection;
  problem: string | null;
};

/** How many articles are kept to read offline. */
const KEPT_TEXTS = 40;
const PAGE = 60;
const MAX_IMPRESSIONS = 500;

/** The Feed on the phone. The Mac fetches, ranks and saves; the phone keeps
 *  the latest page and Picked for you to read offline, and his likes, notes,
 *  saves and Not interested wait here until the Mac takes them. */
export class Feed extends Waiting<State, FeedOp> {
  private current!: FeedSnapshot;
  private seen = new Set<string>();

  constructor(kv: KV) {
    super(kv, 'feed', { items: [], total: 0, picks: [], texts: {}, conflicts: {} });
    this.snapshot();
  }

  getSnapshot = () => this.current;

  /** The version probe can fail before sync reaches this store on a cold launch. */
  markOffline() {
    this.publish('offline');
  }

  protected snapshot() {
    const local = (item: FeedItem) => this.local(item);
    const shown = (item: LocalItem) => !item.dismissed;
    const items = this.state.items.map(local).filter(shown);
    this.current = {
      items,
      entries: (this.state.entries ?? this.state.items.map((item): FeedEntry => ({ kind: 'item', item }))).flatMap((entry): LocalEntry[] => {
        if (entry.kind === 'item') {
          const item = local(entry.item);
          return shown(item) ? [{ kind: 'item', item }] : [];
        }
        const story = this.localStory(entry.story);
        if (!story.items.length) return [];
        // A story needs two sources, including while a dismiss waits offline.
        return story.sources.length > 1 ? [{ kind: 'story', story }] : story.items.map((item) => ({ kind: 'item', item }));
      }),
      picks: this.state.picks.map((p) => {
        const story = p.story ? this.localStory(p.story) : undefined;
        return { ...p, item: local(p.item), story: story && story.sources.length > 1 ? story : undefined };
      }).filter((p) => shown(p.item)),
      total: this.state.total,
      waiting: this.waiting.filter((op) => op.kind !== 'impressions').length,
      conflicts: this.state.conflicts,
      connection: this.connection,
      problem: this.problem,
    };
  }

  /** The item with his waiting actions applied, in order. */
  local(item: FeedItem): LocalItem {
    let out: LocalItem = { ...item, waiting: false };
    for (const op of this.waiting) {
      if (op.kind === 'impressions') continue;
      if (op.kind === 'dismiss') {
        if (op.ids.includes(item.id)) out = { ...out, dismissed: !op.undo, waiting: true };
        continue;
      }
      if (op.id !== item.id) continue;
      out.waiting = true;
      if (op.kind === 'act') {
        if (op.action === 'like' || op.action === 'unlike') out.liked = op.action === 'like';
        if (op.action === 'notInterested' || op.action === 'undoNotInterested') out.dismissed = op.action === 'notInterested';
      } else if (op.kind === 'note') {
        out.note = op.note.trim() ? op.note : null;
      } else if (op.kind === 'save') {
        out = { ...out, savedPath: out.savedPath ?? '' };
      }
    }
    return out;
  }

  private rawItem(id: number): FeedItem | undefined {
    return this.state.items.find((i) => i.id === id) ?? this.state.picks.find((p) => p.id === id)?.item
      ?? Object.values(this.state.stories ?? {}).flatMap((s) => s.items).find((i) => i.id === id)
      ?? this.state.entries?.flatMap((e) => e.kind === 'story' ? e.story.items : [e.item]).find((i) => i.id === id);
  }

  item(id: number): LocalItem | null {
    const found = this.rawItem(id);
    return found ? this.local(found) : null;
  }

  private localStory(story: Story): LocalStory {
    const items = story.items.map((i) => this.local(i)).filter((i) => !i.dismissed);
    const sources = story.sources.filter((s) => items.some((i) => i.sourceId === s.id));
    return { ...story, items, sources, lead: items.find((i) => i.id === story.lead.id) ?? items[0] ?? this.local(story.lead) };
  }

  story(id: number): LocalStory | null {
    const entry = this.state.entries?.find((e) => e.kind === 'story' && e.story.id === id);
    const found = this.state.stories?.[id] ?? this.state.picks.find((p) => p.story?.id === id)?.story ?? (entry?.kind === 'story' ? entry.story : undefined);
    return found ? this.localStory(found) : null;
  }

  dismiss(ids: number[], undo = false, place?: Place) {
    if (!ids.length) return;
    if (undo && this.state.entries) {
      // A sync may have removed a confirmed dismissal from the newest page.
      // Put its cached story back before applying Undo, even if the Mac left.
      let entries = [...this.state.entries];
      for (const story of Object.values(this.state.stories ?? {})) {
        if (!story.items.some((i) => ids.includes(i.id)) || entries.some((e) => e.kind === 'story' && e.story.id === story.id)) continue;
        const members = new Set(story.items.map((i) => i.id));
        entries = entries.filter((e) => e.kind !== 'item' || !members.has(e.item.id));
        entries.push({ kind: 'story', story });
      }
      entries.sort((a, b) => (b.kind === 'story' ? b.story.sortAt : b.item.sortAt) - (a.kind === 'story' ? a.story.sortAt : a.item.sortAt));
      this.setState({ ...this.state, entries });
    }
    this.queue({ kind: 'dismiss', ids, undo, place });
  }

  /** The article's text as last read here, for reading offline. */
  text(id: number): string | null {
    return this.state.texts[id] ?? null;
  }

  // ── His actions ────────────────────────────────────────────────────────

  act(id: number, action: FeedAction, place?: Place) {
    this.queue({ kind: 'act', id, action, place });
  }

  save(id: number, place?: Place) {
    const item = this.item(id);
    if (!item || item.savedPath !== null) return;
    this.queue({ kind: 'save', id, place });
  }

  /** The note as he types it. One waiting note per item, started from the
   *  Mac's note as it was when he began. */
  note(id: number, note: string, place?: Place) {
    const item = this.item(id);
    if (!item) return;
    const earlier = this.waiting.find((op): op is Extract<FeedOp, { kind: 'note' }> => op.kind === 'note' && op.id === id);
    if (earlier) {
      this.setWaiting(this.waiting.map((op) => (op === earlier ? { ...earlier, note } : op)));
      this.publish();
      return;
    }
    const mac = this.rawItem(id);
    const baseText = mac?.note ?? '';
    if (baseText === note) return;
    this.queue({ kind: 'note', id, note, base: version(baseText), baseText, place });
  }

  /** Settles a note that changed in both places. */
  resolve(id: number, keep: 'mine' | 'theirs') {
    const conflict = this.state.conflicts[id];
    if (!conflict) return;
    const { [id]: _, ...rest } = this.state.conflicts;
    this.setState({ ...this.state, conflicts: rest });
    if (keep === 'mine') this.queue({ kind: 'note', id, note: conflict.mine, base: conflict.version, baseText: conflict.theirs });
    else this.publish();
  }

  /** Items shown in a list, once each per launch, for ranking. */
  saw(impressions: Impression[]) {
    const fresh = impressions.filter((i) => {
      const key = `${i.surface}:${i.id}`;
      if (this.seen.has(key)) return false;
      this.seen.add(key);
      return true;
    });
    if (!fresh.length) return;
    const last = this.waiting.at(-1);
    if (last?.kind === 'impressions' && last.impressions.length + fresh.length <= MAX_IMPRESSIONS) {
      this.setWaiting([...this.waiting.slice(0, -1), { kind: 'impressions', impressions: [...last.impressions, ...fresh] }]);
    } else {
      this.setWaiting([...this.waiting, { kind: 'impressions', impressions: fresh.slice(0, MAX_IMPRESSIONS) }]);
    }
  }

  private queue(op: FeedOp) {
    this.setWaiting([...this.waiting, op]);
    this.publish();
  }

  // ── The Mac ────────────────────────────────────────────────────────────

  /** Sends what's waiting, then reads the newest page and Picked for you.
   *  Throws Unpaired; Offline keeps everything for later. */
  sync(client: FeedClient, api = SECTIONS_API): Promise<void> {
    return this.serial(async () => {
      this.problem = null;
      if (!(await this.flush((op) => this.send(client, op)))) return;
      try {
        const [page, picked, entries] = await Promise.all([
          client.feed(0, PAGE), client.picked(), api >= STORIES_API ? client.feedEntries(0, PAGE) : null,
        ]);
        const stories = { ...this.state.stories };
        for (const entry of entries?.entries ?? []) if (entry.kind === 'story') stories[entry.story.id] = entry.story;
        for (const pick of picked.picks) if (pick.story) stories[pick.story.id] = pick.story;
        const kept = Object.fromEntries(Object.values(stories).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, KEPT_TEXTS).map((s) => [s.id, s]));
        const ids = new Set([...page.items.map((i) => i.id), ...picked.picks.map((p) => p.id), ...Object.values(kept).flatMap((s) => s.items.map((i) => i.id))]);
        const texts = Object.fromEntries(Object.entries(this.state.texts).filter(([id]) => ids.has(Number(id))));
        this.setState({ ...this.state, items: page.items, entries: entries?.entries, stories: kept, total: entries?.total ?? page.total, picks: picked.picks, texts });
        this.publish('online');
      } catch (e) {
        throw this.failed(e);
      }
    });
  }

  /** Keeps a fetched story (including its citations) to read offline. */
  readStory(client: FeedClient, id: number): Promise<LocalStory | null> {
    return this.serial(async () => {
      try {
        const story = await client.feedStory(id);
        this.setState({ ...this.state, stories: { ...this.state.stories, [id]: story } });
        this.publish('online');
      } catch (e) {
        this.failed(e);
        if (e instanceof Unpaired) throw e;
      }
      return this.story(id);
    });
  }

  reasons(id: number): Reason[] | undefined {
    return this.state.reasons?.[id];
  }

  async why(client: FeedClient, id: number): Promise<Reason[]> {
    const reasons = (await client.feedWhy(id)).filter((r) => r.key !== 'cold');
    this.setState({ ...this.state, reasons: { ...this.state.reasons, [id]: reasons } });
    this.publish();
    return reasons;
  }

  /** Reads an item on the Mac (logged as an open; an excerpt becomes the
   *  whole article) and keeps its text. Offline, it's what the phone kept. */
  read(client: FeedClient, id: number, place?: Place): Promise<string | null> {
    return this.serial(async () => {
      try {
        const reading = await client.feedRead(id, place);
        this.update(reading.item);
        if (reading.text) {
          const texts: Record<string, string> = { ...this.state.texts };
          // Newest last, so the oldest are let go first.
          delete texts[id];
          texts[id] = reading.text;
          const keys = Object.keys(texts);
          for (const old of keys.slice(0, Math.max(0, keys.length - KEPT_TEXTS))) delete texts[old];
          this.setState({ ...this.state, texts });
        }
        this.publish('online');
        return reading.text;
      } catch (e) {
        this.failed(e);
        if (e instanceof Unpaired) throw e;
        return this.text(id);
      }
    });
  }

  private async send(client: FeedClient, op: FeedOp) {
    switch (op.kind) {
      case 'impressions':
        await client.feedImpressions(op.impressions);
        return;
      case 'act': {
        this.update(await client.feedAct(op.id, op.action, op.place));
        return;
      }
      case 'dismiss':
        for (const item of await client.feedDismiss(op.ids, op.undo, op.place)) this.update(item);
        return;
      case 'save':
        this.update(await client.feedSave(op.id, op.place));
        return;
      case 'note': {
        const saved = await client.feedNote(op.id, op.note, op.base, op.place);
        this.update(saved.item);
        if (saved.result === 'saved') {
          // Typing that went on while it was in flight starts from the new note.
          this.setWaiting(
            this.waiting.map((o) => (o !== op && o.kind === 'note' && o.id === op.id ? { ...o, base: saved.version, baseText: saved.item.note ?? '' } : o)),
          );
          return;
        }
        const merged = merge3(op.baseText, op.note, saved.current.text);
        if (merged.clean) {
          const retry: FeedOp = { ...op, note: merged.text, base: saved.current.version, baseText: saved.current.text };
          this.setWaiting([retry, ...this.waiting.filter((o) => o !== op)]);
          // The retry is sent next; this op is done.
          return;
        }
        this.setState({ ...this.state, conflicts: { ...this.state.conflicts, [op.id]: { mine: op.note, theirs: saved.current.text, version: saved.current.version } } });
        return;
      }
    }
  }

  /** The Mac's newer copy of an item, wherever the phone shows it. */
  private update(item: FeedItem) {
    this.setState({
      ...this.state,
      items: this.state.items.map((i) => (i.id === item.id ? item : i)),
      entries: this.state.entries?.map((e) => e.kind === 'item' ? { ...e, item: e.item.id === item.id ? item : e.item } : { ...e, story: updateStory(e.story, item) }),
      stories: Object.fromEntries(Object.entries(this.state.stories ?? {}).map(([id, story]) => [id, updateStory(story, item)])),
      picks: this.state.picks.map((p) => ({ ...p, item: p.id === item.id ? item : p.item, story: p.story ? updateStory(p.story, item) : undefined })),
    });
  }
}

/** "3 h", "2 d": how long ago, from Unix seconds. */
export function ago(seconds: number | null, now = Date.now()): string {
  if (seconds === null) return '';
  const minutes = Math.max(0, Math.round((now / 1000 - seconds) / 60));
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

function updateStory(story: Story, item: FeedItem): Story {
  return { ...story, lead: story.lead.id === item.id ? item : story.lead, items: story.items.map((i) => i.id === item.id ? item : i) };
}

export const summaryStateLine = (state: SummaryState): string | null => ({
  ready: null,
  pending: 'Kin is writing a summary.',
  failed: "Couldn't write a summary, so this is the first article's text.",
  capped: "This month's AI limit is reached, so there's no summary yet.",
  unavailable: 'Set up an AI provider in Settings for summaries.',
})[state];
