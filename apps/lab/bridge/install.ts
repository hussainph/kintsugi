/** Browser-only, in-memory Tauri runtime for isolated Lab frames.
 * Importing this module does not inspect window, config, credentials or a vault.
 * The frame must call installLabBridge() BEFORE dynamically importing entries.
 */
export type FixtureArgs = Record<string, unknown>;
export type FixtureHandler = (args: FixtureArgs) => unknown | Promise<unknown>;
export type FixtureHandlers = Record<string, FixtureHandler>;
type Callback = (payload: unknown) => unknown;

export function createLabBridge() {
  let sequence = 0;
  let handlers: FixtureHandlers = {};
  let owner: string | null = null;
  const callbacks = new Map<number, Callback>();
  const listeners = new Map<number, { event: string; handler: number }>();
  const calls: Array<{ command: string; args: FixtureArgs }> = [];

  function unregisterCallback(id: number) {
    callbacks.delete(id);
    for (const [eventId, listener] of listeners)
      if (listener.handler === id) listeners.delete(eventId);
  }
  function unregisterListener(event: string, id: number) {
    const listener = listeners.get(id);
    if (listener?.event === event) {
      listeners.delete(id);
      callbacks.delete(listener.handler);
    }
  }
  function emit(event: string, payload: unknown) {
    for (const [id, listener] of [...listeners]) {
      if (listener.event === event)
        callbacks.get(listener.handler)?.({ event, id, payload });
    }
  }
  async function invoke(command: string, args: FixtureArgs = {}) {
    // Only Tauri's event plumbing is built in. Product commands must opt in.
    if (command === "plugin:event|listen") {
      if (
        typeof args.event !== "string" ||
        typeof args.handler !== "number" ||
        !callbacks.has(args.handler)
      ) {
        throw new Error("Lab bridge: invalid event listener");
      }
      const id = ++sequence;
      listeners.set(id, { event: args.event, handler: args.handler });
      return id;
    }
    if (command === "plugin:event|unlisten") {
      unregisterListener(String(args.event), Number(args.eventId));
      return null;
    }
    calls.push({ command, args });
    if (!Object.hasOwn(handlers, command))
      throw new Error(
        `Lab bridge: no fixture handler for ${command} (${owner ?? "no entry registered"})`,
      );
    return handlers[command](args);
  }
  const internals = {
    metadata: {
      currentWindow: { label: "lab" },
      currentWebview: { windowLabel: "lab", label: "lab" },
    },
    invoke,
    callbacks,
    transformCallback(callback?: Callback, once = false) {
      const id = ++sequence;
      callbacks.set(id, (payload) => {
        if (once) unregisterCallback(id);
        return callback?.(payload);
      });
      return id;
    },
    unregisterCallback,
    runCallback(id: number, payload: unknown) {
      callbacks.get(id)?.(payload);
    },
    convertFileSrc() {
      throw new Error(
        "Lab bridge: filesystem assets are unavailable; use explicit clip_image fixtures",
      );
    },
  };
  return {
    internals,
    eventInternals: { unregisterListener },
    emit,
    calls,
    /** Replaces the entire command set. There is no permissive fallback. */
    register(entryId: string, next: FixtureHandlers) {
      owner = entryId;
      const registered = { ...next };
      handlers = registered;
      // A later registration cannot be removed by an older disposer.
      return () => {
        if (handlers === registered) {
          handlers = {};
          owner = null;
        }
      };
    },
  };
}
export type LabBridge = ReturnType<typeof createLabBridge>;
let installed: LabBridge | null = null;

export function installLabBridge(win: object = window): LabBridge {
  const target = win as Record<string, unknown>;
  if ("__TAURI_INTERNALS__" in target)
    throw new Error("Lab refuses to replace an existing Tauri runtime");
  const bridge = createLabBridge();
  target.__TAURI_INTERNALS__ = bridge.internals;
  target.__TAURI_EVENT_PLUGIN_INTERNALS__ = bridge.eventInternals;
  installed = bridge;
  return bridge;
}
export function labBridge(): LabBridge {
  if (!installed)
    throw new Error("Install the Lab bridge before loading a product story");
  return installed;
}
/** Call synchronously from an entry fixture boundary, before mounting product children. */
export function registerFixtureHandlers(
  entryId: string,
  handlers: FixtureHandlers,
): () => void {
  return labBridge().register(entryId, handlers);
}
