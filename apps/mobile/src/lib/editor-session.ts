import type { PhoneExternal } from '@/components/editor/PhoneEditor';

/** Where the editor goes on screen, in window coordinates. */
export type Slot = { x: number; y: number; width: number; height: number };

/** One open document in the shared editor. */
export type Session = {
  /** Stays the same for the life of the screen, even when a new note is
   *  renamed after it's sent, so its undo history carries on. */
  key: string;
  /** The writing (without frontmatter) when it opens. */
  text: string;
  /** Put the caret at the end and raise the keyboard (a new note). */
  focus: boolean;
  /** When the screen asked for the editor, for the opening time. */
  openedAt: number;
};

export type EditorSnapshot = {
  session: Session | null;
  external: PhoneExternal | null;
  slot: Slot | null;
  /** The doc screen has finished its transition and the editor may show. */
  visible: boolean;
  /** The document has been painted in the WebView. */
  shown: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Development builds: the editor's recent events (see EditorHost). */
  log: string[];
};

type Writer = (text: string, seen: string) => void;

/** Connects the doc screen to the one editor WebView mounted in the root
 *  layout (EditorHost). The screen says which document, where and when; the
 *  host renders it and hands the text back. Writers stay registered after a
 *  screen closes, so text still on its way from the WebView lands. */
class EditorSessions {
  private snapshot: EditorSnapshot = { session: null, external: null, slot: null, visible: false, shown: null, canUndo: false, canRedo: false, log: [] };
  private listeners = new Set<() => void>();
  private writers = new Map<string, Writer>();
  private flushes = new Map<number, () => void>();
  private token = 0;
  private seq = 0;
  /** Set by the host once the WebView can take commands. */
  commands: { flush: (token: number) => boolean; blur: () => void } | null = null;
  /** Opening times, newest last, for checking "instant open". */
  readonly timings: { key: string; ms: number }[] = [];

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;

  open(session: Omit<Session, 'openedAt'>, write: Writer) {
    this.writers.set(session.key, write);
    this.set({ session: { ...session, openedAt: Date.now() }, external: null, visible: false, shown: null, canUndo: false, canRedo: false });
  }

  close(key: string) {
    if (this.snapshot.session?.key !== key) return;
    this.commands?.blur();
    this.set({ session: null, external: null, visible: false, shown: null });
  }

  setSlot(key: string, slot: Slot) {
    if (this.snapshot.session?.key !== key) return;
    const old = this.snapshot.slot;
    if (old && old.x === slot.x && old.y === slot.y && old.width === slot.width && old.height === slot.height) return;
    this.set({ slot });
  }

  setVisible(key: string, visible: boolean) {
    if (this.snapshot.session?.key !== key || this.snapshot.visible === visible) return;
    if (!visible) this.commands?.blur();
    this.set({ visible });
  }

  /** The document changed here other than by typing (sync, a merge, the
   *  status toggle, a conflict choice). */
  external(key: string, text: string) {
    if (this.snapshot.session?.key !== key) return;
    this.set({ external: { key, text, seq: ++this.seq } });
  }

  /** Everything typed so far has reached the writers. */
  flush(): Promise<void> {
    const commands = this.commands;
    if (!commands) return Promise.resolve();
    const token = ++this.token;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timeout);
        this.flushes.delete(token);
        resolve();
      };
      // A WebView that never answers mustn't hold the screen.
      const timeout = setTimeout(done, 1500);
      this.flushes.set(token, done);
      // Not loaded yet: nothing can have been typed.
      if (!commands.flush(token)) done();
    });
  }

  // ---- from the host -------------------------------------------------------

  wrote(key: string, text: string, seen: string) {
    this.writers.get(key)?.(text, seen);
  }

  flushed(token: number) {
    this.flushes.get(token)?.();
  }

  log(message: string) {
    this.set({ log: [...this.snapshot.log.slice(-11), message] });
  }

  history(canUndo: boolean, canRedo: boolean) {
    this.set({ canUndo, canRedo });
  }

  shownKey(key: string) {
    const session = this.snapshot.session;
    if (session?.key !== key || this.snapshot.shown === key) return;
    const ms = Date.now() - session.openedAt;
    this.timings.push({ key, ms });
    if (__DEV__) this.log(`shown ${key} ${ms}ms`);
    if (this.timings.length > 20) this.timings.shift();
    this.set({ shown: key });
  }

  private set(change: Partial<EditorSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    this.listeners.forEach((listener) => listener());
  }
}

export const editorSessions = new EditorSessions();
