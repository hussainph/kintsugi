import { merge3 } from '@kintsugi/core/merge';
import { type Remote, version } from '@kintsugi/core/remote';
import type { Effect, FeedAction, FeedItem, Impression, Pick as FeedPick, Place } from '@kintsugi/core/sections';

import type { Connection, KV } from './library';
import { Waiting } from './waiting.ts';

/** An action taken on the phone, waiting for the Mac. Every one becomes the
 *  same event the Mac's own Feed logs, so ranking learns from both alike. */
export type FeedOp =
  | { kind: 'act'; id: number; action: FeedAction; place?: Place }
  | { kind: 'save'; id: number; place?: Place }
  /** `base` is the Mac's note when he started (`baseText`), at its version. */
  | { kind: 'note'; id: number; note: string; base: string; baseText: string; place?: Place }
  | { kind: 'impressions'; impressions: Impression[] };

export type FeedClient = Pick<
  Remote,
  'feed' | 'picked' | 'feedRead' | 'feedAct' | 'feedNote' | 'feedSave' | 'feedImpressions' | 'feedEffect'
>;

type State = {
  items: FeedItem[];
  total: number;
  picks: FeedPick[];
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

export type FeedSnapshot = {
  items: LocalItem[];
  picks: (FeedPick & { item: LocalItem })[];
  total: number;
  waiting: number;
  conflicts: State['conflicts'];
  connection: Connection;
  problem: string | null;
  /** What the last like changed in Picked for you, for the toast. */
  effect: { id: number; effect: Effect } | null;
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
  private effect: FeedSnapshot['effect'] = null;
  private seen = new Set<string>();

  constructor(kv: KV) {
    super(kv, 'feed', { items: [], total: 0, picks: [], texts: {}, conflicts: {} });
    this.snapshot();
  }

  getSnapshot = () => this.current;

  protected snapshot() {
    const local = (item: FeedItem) => this.local(item);
    const shown = (item: LocalItem) => !item.dismissed;
    const items = this.state.items.map(local).filter(shown);
    this.current = {
      items,
      picks: this.state.picks.map((p) => ({ ...p, item: local(p.item) })).filter((p) => shown(p.item)),
      total: this.state.total,
      waiting: this.waiting.filter((op) => op.kind !== 'impressions').length,
      conflicts: this.state.conflicts,
      connection: this.connection,
      problem: this.problem,
      effect: this.effect,
    };
  }

  /** The item with his waiting actions applied, in order. */
  local(item: FeedItem): LocalItem {
    let out: LocalItem = { ...item, waiting: false };
    for (const op of this.waiting) {
      if (op.kind === 'impressions' || op.id !== item.id) continue;
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

  item(id: number): LocalItem | null {
    const found = this.state.items.find((i) => i.id === id) ?? this.state.picks.find((p) => p.id === id)?.item;
    return found ? this.local(found) : null;
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
    const mac = this.state.items.find((i) => i.id === id) ?? this.state.picks.find((p) => p.id === id)?.item;
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

  dismissEffect() {
    this.effect = null;
    this.publish();
  }

  private queue(op: FeedOp) {
    this.setWaiting([...this.waiting, op]);
    this.publish();
  }

  // ── The Mac ────────────────────────────────────────────────────────────

  /** Sends what's waiting, then reads the newest page and Picked for you.
   *  Throws Unpaired; Offline keeps everything for later. */
  sync(client: FeedClient): Promise<void> {
    return this.serial(async () => {
      this.problem = null;
      if (!(await this.flush((op) => this.send(client, op)))) return;
      try {
        const [page, picked] = await Promise.all([client.feed(0, PAGE), client.picked()]);
        const ids = new Set([...page.items.map((i) => i.id), ...picked.picks.map((p) => p.id)]);
        const texts = Object.fromEntries(Object.entries(this.state.texts).filter(([id]) => ids.has(Number(id))));
        this.setState({ ...this.state, items: page.items, total: page.total, picks: picked.picks, texts });
        this.publish('online');
      } catch (e) {
        throw this.failed(e);
      }
    });
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
        if (op.action === 'like' && !this.waiting.some((o) => o !== op && o.kind === 'act' && o.id === op.id)) {
          // What it changed in Picked for you; a nicety, so a failure is quiet.
          const effect = await client.feedEffect(op.id).catch(() => null);
          if (effect) this.effect = { id: op.id, effect };
        }
        return;
      }
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
      picks: this.state.picks.map((p) => (p.id === item.id ? { ...p, item } : p)),
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

/** The toast after a like: what moved in Picked for you, in a line. */
export function effectLine(effect: Effect): string {
  const moved = effect.changes.filter((c) => c.after > c.before).map((c) => c.label);
  const parts: string[] = [];
  if (moved.length) parts.push(`More like ${moved.slice(0, 2).join(' and ')}`);
  if (effect.added.length) parts.push(`${effect.added.length} new in Picked for you`);
  return parts.length ? parts.join(' · ') : 'Liked.';
}
