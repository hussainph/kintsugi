import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createStore } from "./store.ts";
import {
  defaultScenario,
  defaultValues,
  fail,
  object,
  validateStatus,
  type Values,
} from "./schema.ts";
import { validateAction, type Action } from "./state.ts";

const usage = `Lab — offline, file-backed exploration state
Usage: lab [--root <workspace>] [--entries <directory>] <command> [--json]
  list [--include-archived]
  show <kind/slug>
  note <kind/slug> <text...> [--kind note|critique|decision] [--revision N]
  status <kind/slug> <idea|exploring|refining|ready|shipped|archived> [--revision N]
  snapshot <kind/slug> <name> [--values '{"control":value}'] [--scenario '{...}'] [--revision N]
  check
Snapshot values and scenario are merged over their declared defaults.
No running server is needed. State lives beside each entry in thread.jsonl.`;
interface CliIO {
  out: (message: string) => void;
}
const valueFlags = [
  "root",
  "entries",
  "kind",
  "revision",
  "values",
  "scenario",
];
const booleanFlags = ["json", "include-archived", "help"];
function parse(args: string[]): {
  positional: string[];
  flags: Map<string, string | true>;
} {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (flags.has(name)) fail(`Duplicate option --${name}`);
    if (booleanFlags.includes(name)) flags.set(name, true);
    else if (valueFlags.includes(name)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--"))
        fail(`--${name} requires a value`);
      flags.set(name, value);
    } else fail(`Unknown option ${token}`);
  }
  return { positional, flags };
}
function json(value: string | true | undefined, label: string): unknown {
  if (typeof value !== "string") fail(`${label} needs JSON`);
  try {
    return JSON.parse(value);
  } catch {
    return fail(`${label} is not valid JSON`);
  }
}
export async function runCli(
  args: string[],
  io: CliIO = { out: console.log },
): Promise<void> {
  const { positional, flags } = parse(args);
  if (flags.has("help") || !positional.length) {
    io.out(usage);
    return;
  }
  const [command, id, ...rest] = positional;
  const allowed: Record<string, string[]> = {
    list: ["include-archived"],
    show: [],
    note: ["kind", "revision"],
    status: ["revision"],
    snapshot: ["values", "scenario", "revision"],
    check: [],
  };
  if (!Object.hasOwn(allowed, command))
    fail(`Unknown command ${command}\n${usage}`);
  for (const key of flags.keys())
    if (!["root", "entries", "json", ...allowed[command]].includes(key))
      fail(`--${key} is not valid for ${command}`);
  const store = createStore({
    root: resolve(String(flags.get("root") ?? process.cwd())),
    entriesDir: String(flags.get("entries") ?? "entries"),
  });
  const catalog = await store.catalog();
  const print = (value: unknown) => io.out(JSON.stringify(value, null, 2));
  if (command === "check") {
    if (id) fail("check does not accept arguments");
    for (const entry of catalog) await store.read(entry.meta.id);
    if (flags.has("json")) print({ entries: catalog.length, valid: true });
    else
      io.out(
        `Validated ${catalog.length} entries and their complete state logs.`,
      );
    return;
  }
  if (command === "list") {
    if (id) fail("list does not accept arguments");
    const rows = [];
    for (const entry of catalog) {
      const state = await store.read(entry.meta.id);
      if (state.status !== "archived" || flags.has("include-archived"))
        rows.push({
          ...entry.meta,
          status: state.status,
          revision: state.revision,
        });
    }
    if (flags.has("json")) print(rows);
    else
      io.out(
        rows.map((row) => `${row.id}\t${row.status}\t${row.title}`).join("\n"),
      );
    return;
  }
  if (!id) fail(`${command} requires an entry id`);
  const entry = catalog.find((item) => item.meta.id === id);
  if (!entry) fail(`Unknown entry: ${id}`);
  const state = await store.read(id);
  if (command === "show") {
    if (rest.length) fail("show accepts only an entry id");
    print({ ...entry, state });
    return;
  }
  let action: Action;
  if (command === "note") {
    action = validateAction(
      { type: "note", kind: flags.get("kind") ?? "note", text: rest.join(" ") },
      entry.controls,
    );
  } else if (command === "status") {
    if (rest.length !== 1) fail("status requires exactly one lifecycle value");
    action = { type: "status", status: validateStatus(rest[0]) };
  } else {
    if (rest.length !== 1)
      fail("snapshot requires one name (quote names containing spaces)");
    const values = flags.has("values")
      ? object(json(flags.get("values"), "--values"), "values")
      : {};
    const scenario = flags.has("scenario")
      ? object(json(flags.get("scenario"), "--scenario"), "scenario")
      : {};
    action = validateAction(
      {
        type: "snapshot",
        name: rest[0],
        values: { ...defaultValues(entry.controls), ...values } as Values,
        scenario: { ...defaultScenario, ...scenario },
      },
      entry.controls,
    );
  }
  const revisionFlag = flags.get("revision");
  if (
    revisionFlag !== undefined &&
    (typeof revisionFlag !== "string" || !/^\d+$/.test(revisionFlag))
  )
    fail("--revision must be a nonnegative integer");
  const revision =
    revisionFlag === undefined ? state.revision : Number(revisionFlag);
  const next = await store.append(id, revision, action);
  if (flags.has("json")) print(next);
  else io.out(`${id}: ${action.type} saved (revision ${next.revision})`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
