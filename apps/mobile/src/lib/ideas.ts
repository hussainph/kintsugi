import type { Remote } from '@kintsugi/core/remote';
import type { IdeasView, ListedIdea } from '@kintsugi/core/sections';

import type { Connection, KV } from './library';
import { Waiting } from './waiting.ts';

/** What he did with an idea on the phone, waiting for the Mac. */
export type IdeaOp =
  | { kind: 'adopt'; id: string }
  | { kind: 'dismiss'; id: string }
  | { kind: 'undismiss'; id: string }
  | { kind: 'discussed'; id: string }
  /** "Ask for more": Kin makes them on the Mac. */
  | { kind: 'more' };

export type IdeasClient = Pick<Remote, 'ideas' | 'moreIdeas' | 'adoptIdea' | 'dismissIdea' | 'ideaDiscussed'>;

type State = { view: IdeasView | null; adopted: Record<string, string> };

/** An idea as the phone shows it, with his waiting actions applied. */
export type LocalIdea = ListedIdea & { adopting?: boolean };

export type IdeasSnapshot = {
  ideas: LocalIdea[];
  today: string | null;
  /** Kin is making a batch on the Mac (or one waits to be asked for). */
  making: boolean;
  /** The last batch failed, and why. */
  failed: string | null;
  capReached: boolean;
  /** The drafts adopted ideas became, by idea id, once the Mac made them. */
  adopted: Record<string, string>;
  waiting: number;
  connection: Connection;
  problem: string | null;
};

/** Ideas on the phone. Kin makes them on the Mac; the phone keeps the last
 *  list to read offline, and Adopt, Dismiss and "Ask for more" wait here
 *  until the Mac takes them. */
export class Ideas extends Waiting<State, IdeaOp> {
  private current!: IdeasSnapshot;
  private now: () => string;

  constructor(kv: KV, now: () => string = () => new Date().toISOString()) {
    super(kv, 'ideas', { view: null, adopted: {} });
    this.now = now;
    this.snapshot();
  }

  getSnapshot = () => this.current;

  protected snapshot() {
    const view = this.state.view;
    const ideas = (view?.ideas ?? []).map((idea) => this.local(idea));
    const job = view?.job;
    const running = job != null && (job.status === 'queued' || job.status === 'running' || job.status === 'waiting');
    this.current = {
      ideas,
      today: view?.today ?? null,
      making: running || this.waiting.some((op) => op.kind === 'more'),
      failed: job?.status === 'failed' ? (job.error ?? 'Kin couldn’t find ideas this time.') : null,
      capReached: view?.capReached ?? false,
      adopted: this.state.adopted,
      waiting: this.waiting.length,
      connection: this.connection,
      problem: this.problem,
    };
  }

  private local(idea: ListedIdea): LocalIdea {
    let out: LocalIdea = idea;
    for (const op of this.waiting) {
      if (op.kind === 'more' || op.id !== idea.id) continue;
      if (op.kind === 'dismiss') out = { ...out, dismissed: { at: this.now(), reasons: [] } };
      if (op.kind === 'undismiss') out = { ...out, dismissed: undefined };
      if (op.kind === 'adopt') out = { ...out, adopting: true };
    }
    return out;
  }

  adopt(id: string) {
    if (this.current.ideas.find((i) => i.id === id)?.adopted) return;
    if (this.waiting.some((op) => op.kind === 'adopt' && op.id === id)) return;
    this.queue({ kind: 'adopt', id });
  }

  dismiss(id: string, undo = false) {
    this.queue({ kind: undo ? 'undismiss' : 'dismiss', id });
  }

  discussed(id: string) {
    this.queue({ kind: 'discussed', id });
  }

  more() {
    if (this.current.making) return;
    this.queue({ kind: 'more' });
  }

  private queue(op: IdeaOp) {
    this.setWaiting([...this.waiting, op]);
    this.publish();
  }

  /** Sends what's waiting, then reads the list. Throws Unpaired. Returns the
   *  drafts adopted during this sync, so the phone can fetch and open them. */
  sync(client: IdeasClient): Promise<string[]> {
    return this.serial(async () => {
      this.problem = null;
      const drafts: string[] = [];
      const reached = await this.flush(async (op) => {
        switch (op.kind) {
          case 'adopt': {
            const adopted = await client.adoptIdea(op.id);
            drafts.push(adopted.path);
            this.setState({ view: adopted.view, adopted: { ...this.state.adopted, [op.id]: adopted.path } });
            return;
          }
          case 'dismiss':
          case 'undismiss':
            this.setState({ ...this.state, view: await client.dismissIdea(op.id, op.kind === 'undismiss') });
            return;
          case 'discussed':
            await client.ideaDiscussed(op.id);
            return;
          case 'more':
            this.setState({ ...this.state, view: await client.moreIdeas() });
            return;
        }
      });
      if (!reached) return drafts;
      try {
        this.setState({ ...this.state, view: await client.ideas() });
        this.publish('online');
      } catch (e) {
        throw this.failed(e);
      }
      return drafts;
    });
  }
}

/** Today's ideas, earlier ones still fresh, and those fading this week.
 *  Dismissed ideas leave the list unless `keep` (just dismissed, for Undo). */
export function groupIdeas(ideas: LocalIdea[], keep: ReadonlySet<string> = new Set()) {
  const shown = ideas.filter((i) => !i.dismissed || keep.has(i.id));
  return {
    today: shown.filter((i) => i.age === 0 && i.stage !== 'faded'),
    earlier: shown.filter((i) => i.age > 0 && i.stage !== 'faded'),
    faded: shown.filter((i) => i.stage === 'faded' && !i.dismissed),
  };
}

/** One per source, in Kin's order. */
export function evidence(idea: ListedIdea) {
  const seen = new Set<string>();
  return idea.quotes.filter((q) => !seen.has(q.source) && seen.add(q.source));
}
