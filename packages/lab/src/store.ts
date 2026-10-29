import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertConfined, discover, type DiscoveredEntry } from "./discovery.ts";
import { fail, validateEntryId, type Status } from "./schema.ts";
import {
  migrateEvent,
  reduceEvent,
  reduceEvents,
  validateAction,
  type Action,
  type LabEvent,
  type LabState,
} from "./state.ts";

const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
export class RevisionConflict extends Error {
  readonly statusCode = 409;
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(
      `Stale revision: expected ${expected}, current revision is ${actual}. Reload before retrying.`,
    );
    this.expected = expected;
    this.actual = actual;
    this.name = "RevisionConflict";
  }
}
export class LockTimeout extends Error {
  readonly statusCode = 423;
  constructor(path: string) {
    super(
      `Thread is locked: ${path}. Retry; if the writer died, inspect and remove its lock file manually.`,
    );
    this.name = "LockTimeout";
  }
}
export interface StoreOptions {
  root: string;
  entriesDir: string;
  lockTimeoutMs?: number;
}
/** History validates its own event schema, never today's mutable control definitions. */
export function parseLog(
  content: string,
  status: Status = "idea",
): LabState {
  if (Buffer.byteLength(content) > MAX_LOG_BYTES)
    fail("Thread exceeds the 16 MiB log limit");
  if (content !== "" && !content.endsWith("\n"))
    fail("Corrupt thread: incomplete final JSONL line");
  const events: LabEvent[] = [];
  const lines = content === "" ? [] : content.slice(0, -1).split("\n");
  for (const [index, line] of lines.entries()) {
    try {
      if (!line.trim() || Buffer.byteLength(line) > MAX_EVENT_BYTES)
        fail("Empty or oversized event line");
      events.push(migrateEvent(JSON.parse(line)));
    } catch (error) {
      fail(`Corrupt thread at line ${index + 1}: ${(error as Error).message}`);
    }
  }
  try {
    return reduceEvents(events, status);
  } catch (error) {
    return fail(`Corrupt thread: ${(error as Error).message}`);
  }
}
export class LabStore {
  private readonly options: StoreOptions;
  constructor(options: StoreOptions) {
    if (
      options.lockTimeoutMs !== undefined &&
      (!Number.isFinite(options.lockTimeoutMs) ||
        options.lockTimeoutMs < 0 ||
        options.lockTimeoutMs > 60000)
    )
      fail("lockTimeoutMs must be from 0 to 60000");
    this.options = { ...options };
  }
  async catalog(): Promise<DiscoveredEntry[]> {
    return discover(this.options.root, this.options.entriesDir);
  }
  private async entry(
    entryId: string,
  ): Promise<{ root: string; entry: DiscoveredEntry }> {
    validateEntryId(entryId);
    const root = await realpath(resolve(this.options.root));
    const entry = (await this.catalog()).find(
      ({ meta }) => meta.id === entryId,
    );
    if (!entry) fail(`Unknown entry: ${entryId}`);
    await assertConfined(root, entry.directory);
    return { root, entry };
  }
  private async readEntry(
    root: string,
    entry: DiscoveredEntry,
  ): Promise<LabState> {
    const file = join(entry.directory, "thread.jsonl");
    await assertConfined(root, file, true);
    let handle;
    try {
      handle = await open(
        file,
        constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return reduceEvents([], entry.meta.status);
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1)
        fail(`Thread must be a regular, singly-linked file: ${file}`);
      if (info.size > MAX_LOG_BYTES)
        fail("Thread exceeds the 16 MiB log limit");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(
          await handle.readFile(),
        );
      } catch (error) {
        if (error instanceof TypeError) fail("Corrupt thread: invalid UTF-8");
        throw error;
      }
      return parseLog(content, entry.meta.status);
    } finally {
      await handle.close();
    }
  }
  async read(entryId: string): Promise<LabState> {
    const { root, entry } = await this.entry(entryId);
    return this.readEntry(root, entry);
  }
  async append(
    entryId: string,
    revision: number,
    input: Action | unknown,
  ): Promise<LabState> {
    if (!Number.isSafeInteger(revision) || revision < 0)
      fail("revision must be a nonnegative integer");
    const { root, entry } = await this.entry(entryId);
    // New snapshots must still conform to the current controls; old snapshots are immutable history.
    const action = validateAction(input, entry.controls);
    const lockPath = join(entry.directory, "thread.jsonl.lock");
    const started = Date.now();
    let lock;
    while (!lock) {
      await assertConfined(root, lockPath, true);
      try {
        lock = await open(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() - started >= (this.options.lockTimeoutMs ?? 3000))
          throw new LockTimeout(lockPath);
        await delay(20);
      }
    }
    let temporary: string | undefined;
    try {
      await lock.writeFile(
        `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
      );
      const current = await this.readEntry(root, entry);
      if (current.revision !== revision)
        throw new RevisionConflict(revision, current.revision);
      const event: LabEvent = {
        version: 1,
        id: randomUUID(),
        at: new Date().toISOString(),
        action,
      };
      if (Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES)
        fail("Event exceeds the 256 KiB limit");
      const next = reduceEvent(current, event, entry.controls);
      // Re-emitting migrated events upgrades the original file; there are no legacy sidecars.
      const content =
        next.events.map((item) => JSON.stringify(item)).join("\n") + "\n";
      if (Buffer.byteLength(content) > MAX_LOG_BYTES)
        fail("Thread exceeds the 16 MiB log limit");
      await assertConfined(root, entry.directory);
      temporary = join(
        entry.directory,
        `.thread-${process.pid}-${randomUUID()}.tmp`,
      );
      const output = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
        0o600,
      );
      try {
        await output.writeFile(content);
        await output.sync();
      } finally {
        await output.close();
      }
      const destination = join(entry.directory, "thread.jsonl");
      await assertConfined(root, destination, true);
      if ((await exists(destination)) && (await lstat(destination)).nlink !== 1)
        fail("Hard-linked threads are not supported");
      await rename(temporary, destination);
      temporary = undefined;
      return next;
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
      await lock.close();
      await unlink(lockPath);
    }
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export function createStore(options: StoreOptions): LabStore {
  return new LabStore(options);
}
