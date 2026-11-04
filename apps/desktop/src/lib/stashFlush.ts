type Flush = () => Promise<boolean>;
type Participant = { flush: Flush; discard?: () => void; retire?: (from: string) => void };
const roots = new Map<string, Set<Participant>>();
const pending = new Map<string, Set<Promise<unknown>>>();

/** Include validation already requested by the writer in navigation's barrier. */
export function trackStashWrite<T>(root: string, action: () => Promise<T>): Promise<T> {
  let work = pending.get(root);
  if (!work) pending.set(root, work = new Set());
  const result = Promise.resolve().then(action);
  work.add(result);
  const finish = () => { work.delete(result); if (!work.size) pending.delete(root); };
  void result.then(finish, finish);
  return result;
}

/** A vault's queues must reach disk before its draft writes or path changes. */
export function registerStashFlush(root: string, flush: Flush, discard?: () => void, retire?: (from: string) => void) {
  let callbacks = roots.get(root);
  if (!callbacks) roots.set(root, callbacks = new Set());
  const participant = { flush, discard, retire };
  callbacks.add(participant);
  return () => {
    callbacks.delete(participant);
    if (!callbacks.size && roots.get(root) === callbacks) roots.delete(root);
  };
}

/** After the backend has moved a document or folder and its saved sidecars. */
export function retireStashes(root: string | null, from: string) {
  if (root) for (const participant of roots.get(root) ?? []) participant.retire?.(from);
}

/** Only after the writer explicitly discards the corresponding draft changes. */
export function discardStashes(root: string | null) {
  if (root) for (const participant of roots.get(root) ?? []) participant.discard?.();
}

export async function flushStashes(root: string | null): Promise<boolean> {
  if (!root) return true;
  for (;;) {
    // Rejected preflight adds never mutate the stash, but still finish before
    // the path changes. Successful ones notify their queue before settling.
    while (pending.get(root)?.size) await Promise.allSettled([...pending.get(root)!]);
    const callbacks = [...(roots.get(root) ?? [])];
    const results = await Promise.allSettled(callbacks.map(({ flush }) => flush()));
    if (!results.every((result) => result.status === "fulfilled" && result.value)) return false;
    if (!pending.get(root)?.size) return true;
  }
}
