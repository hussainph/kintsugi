import { useCallback, useEffect, useRef, useState } from "react";
import type { LabState } from "./state";

export type ClientState = LabState;
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/__lab/${path}`, init);
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || `Lab request failed (${response.status})`);
  return result;
}
export function useEntryState(entryId: string) {
  const [state, setState] = useState<ClientState>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useRef<ClientState>(undefined);
  const queue = useRef(Promise.resolve());
  const failed = useRef<Array<Record<string, unknown>>>([]);
  const accept = useCallback((next: ClientState) => {
    // A focus refresh that began before a mutation must not roll its revision back.
    if (current.current && next.revision < current.current.revision) return;
    current.current = next;
    setState(next);
  }, []);
  const refresh = useCallback(async () => {
    try {
      accept(
        await request<ClientState>(`state?id=${encodeURIComponent(entryId)}`),
      );
      if (!failed.current.length) setError("");
    } catch (error) {
      setError(String(error));
    }
  }, [entryId, accept]);
  useEffect(() => {
    void refresh();
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [refresh]);
  const send = useCallback(
    (action: Record<string, unknown>): Promise<void> => {
      const next = queue.current
        .catch(() => {})
        .then(async () => {
          setBusy(true);
          try {
            // Preserve ordering: an update cannot overtake a failed annotation add.
            if (failed.current.length) {
              failed.current.push(action);
              setError(
                `${failed.current.length} changes were not saved. Retry to save them in order.`,
              );
              throw new Error("Earlier changes must be retried first");
            }
            const state = await request<ClientState>("state", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                entryId,
                revision: current.current?.revision ?? 0,
                action,
              }),
            });
            accept(state);
            setError("");
          } catch (error) {
            if (failed.current.includes(action)) throw error;
            failed.current.push(action);
            setError(
              `${String(error)} Your change was not saved. Refresh and retry.`,
            );
            // Refresh the revision, but keep the failed action and its visible error.
            try {
              accept(
                await request<ClientState>(
                  `state?id=${encodeURIComponent(entryId)}`,
                ),
              );
            } catch {
              /* Preserve original error. */
            }
            throw error;
          } finally {
            setBusy(false);
          }
        });
      queue.current = next.catch(() => {});
      return next;
    },
    [entryId, accept],
  );
  return {
    state,
    error,
    busy,
    refresh,
    send,
    retry: async () => {
      if (!failed.current.length) return refresh();
      const pending = failed.current;
      failed.current = [];
      // Queue the whole batch before awaiting, so another failure retains its tail.
      await Promise.all(pending.map(send));
    },
  };
}
