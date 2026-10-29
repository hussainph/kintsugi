import {
  exactKeys,
  fail,
  object,
  text,
  validateScenario,
  validateStatus,
  validateValues,
  type Control,
  type Scenario,
  type Status,
  type Values,
} from "./schema.ts";

export const EVENT_VERSION = 1 as const;
export type NoteKind = "note" | "critique" | "decision";
export interface Annotation {
  id: string;
  comment: string;
  elementPath?: string;
  resolved: boolean;
  [key: string]: unknown;
}
export type AnnotationInput = {
  id: string;
  comment?: string;
  elementPath?: string;
  resolved?: boolean;
  [key: string]: unknown;
};
export type Action =
  | { type: "note"; kind: NoteKind; text: string }
  | { type: "resolve-critique"; noteId: string }
  | { type: "status"; status: Status }
  | { type: "snapshot"; name: string; values: Values; scenario: Scenario }
  | {
      type: "annotation";
      operation: "add" | "update" | "delete" | "resolve";
      annotation: AnnotationInput;
    };
export interface LabEvent {
  version: 1;
  id: string;
  at: string;
  action: Action;
}
export interface Note {
  id: string;
  at: string;
  kind: NoteKind;
  text: string;
  resolved?: boolean;
}
export interface Snapshot {
  id: string;
  at: string;
  name: string;
  values: Values;
  scenario: Scenario;
}
export interface LabState {
  status: Status;
  notes: Note[];
  snapshots: Snapshot[];
  annotations: Annotation[];
  events: LabEvent[];
  revision: number;
}
export type State = LabState;
export type StateAction = Action;
export type StateEvent = LabEvent;
function identifier(value: unknown, label: string): string {
  const id = text(value, label, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id))
    fail(`${label} has invalid characters`);
  return id;
}
/** JSON-only extension data lets critique adapters preserve useful positioning metadata. */
function jsonData(value: unknown, depth = 0): unknown {
  if (depth > 12) fail("Annotation data is too deeply nested");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.length <= 16000 &&
    !value.includes("\0")
  )
    return value;
  if (Array.isArray(value) && value.length <= 1000)
    return value.map((item) => jsonData(item, depth + 1));
  const input = object(value, "annotation data");
  if (Object.keys(input).length > 100) fail("Too many annotation fields");
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      fail(`Unsafe annotation field: ${key}`);
    result[key] = jsonData(item, depth + 1);
  }
  return result;
}
export function validateAction(
  value: unknown,
  controls?: Record<string, Control>,
): Action {
  const a = object(value, "action");
  switch (a.type) {
    case "note":
      exactKeys(a, ["type", "kind", "text"], "note action");
      if (!["note", "critique", "decision"].includes(a.kind as string))
        fail("Invalid note kind");
      return {
        type: "note",
        kind: a.kind as NoteKind,
        text: text(a.text, "note.text", 16000),
      };
    case "resolve-critique":
      exactKeys(a, ["type", "noteId"], "resolve critique action");
      return {
        type: "resolve-critique",
        noteId: identifier(a.noteId, "noteId"),
      };
    case "status":
      exactKeys(a, ["type", "status"], "status action");
      return { type: "status", status: validateStatus(a.status) };
    case "snapshot":
      exactKeys(a, ["type", "name", "values", "scenario"], "snapshot action");
      return {
        type: "snapshot",
        name: text(a.name, "snapshot.name", 200),
        values: validateValues(a.values, controls),
        scenario: validateScenario(a.scenario),
      };
    case "annotation": {
      exactKeys(a, ["type", "operation", "annotation"], "annotation action");
      if (
        !["add", "update", "delete", "resolve"].includes(a.operation as string)
      )
        fail("Invalid annotation operation");
      object(a.annotation, "annotation");
      const annotation = jsonData(a.annotation) as AnnotationInput;
      annotation.id = identifier(annotation.id, "annotation.id");
      if (a.operation === "add" || annotation.comment !== undefined)
        annotation.comment = text(
          annotation.comment,
          "annotation.comment",
          16000,
        );
      if (annotation.elementPath !== undefined)
        text(annotation.elementPath, "annotation.elementPath", 4000);
      if (
        annotation.resolved !== undefined &&
        typeof annotation.resolved !== "boolean"
      )
        fail("annotation.resolved must be boolean");
      return {
        type: "annotation",
        operation: a.operation as "add" | "update" | "delete" | "resolve",
        annotation,
      };
    }
    default:
      return fail(`Unknown action type: ${String(a.type)}`);
  }
}
export function validateEvent(
  value: unknown,
  controls?: Record<string, Control>,
): LabEvent {
  const event = object(value, "event");
  exactKeys(event, ["version", "id", "at", "action"], "event");
  if (event.version !== EVENT_VERSION)
    fail(`Unsupported event version: ${String(event.version)}`);
  const id = identifier(event.id, "event.id");
  const at = text(event.at, "event.at", 40);
  if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at)
    fail("event.at must be an ISO timestamp");
  return {
    version: EVENT_VERSION,
    id,
    at,
    action: validateAction(event.action, controls),
  };
}
/** Version 0 used the same action envelope; dispatch stays explicit as schemas evolve. */
const migrations: Record<
  number,
  (event: Record<string, unknown>) => Record<string, unknown>
> = {
  0: (event) => ({ ...event, version: 1 }),
};
export function migrateEvent(
  value: unknown,
  controls?: Record<string, Control>,
): LabEvent {
  let event = object(value, "event");
  if (
    typeof event.version !== "number" ||
    !Number.isInteger(event.version) ||
    event.version < 0
  )
    fail("Event version must be a nonnegative integer");
  if (event.version > EVENT_VERSION)
    fail(
      `Future event version ${event.version}; upgrade Lab before editing this thread`,
    );
  while (event.version !== EVENT_VERSION) {
    const migrate = migrations[event.version as number];
    if (!migrate)
      fail(`No migration for event version ${String(event.version)}`);
    event = migrate(event);
  }
  return validateEvent(event, controls);
}
export function initialState(status: Status = "idea"): LabState {
  return {
    status: validateStatus(status),
    notes: [],
    snapshots: [],
    annotations: [],
    events: [],
    revision: 0,
  };
}
/** Pure and immutable. Both transports pass through this reducer and its validators. */
export function reduceEvent(
  state: LabState,
  input: LabEvent,
  controls?: Record<string, Control>,
): LabState {
  const event = validateEvent(input, controls);
  if (state.events.some(({ id }) => id === event.id))
    fail(`Duplicate event id: ${event.id}`);
  const next: LabState = {
    ...state,
    events: [...state.events, event],
    revision: state.revision + 1,
  };
  const action = event.action;
  switch (action.type) {
    case "status":
      next.status = action.status;
      break;
    case "note":
      next.notes = [
        ...state.notes,
        { id: event.id, at: event.at, kind: action.kind, text: action.text },
      ];
      break;
    case "resolve-critique": {
      const note = state.notes.find((note) => note.id === action.noteId);
      if (!note || note.kind !== "critique")
        fail(`Unknown critique note: ${action.noteId}`);
      next.notes = state.notes.map((note) =>
        note.id === action.noteId ? { ...note, resolved: true } : note,
      );
      break;
    }
    case "snapshot":
      next.snapshots = [
        ...state.snapshots,
        {
          id: event.id,
          at: event.at,
          name: action.name,
          values: action.values,
          scenario: action.scenario,
        },
      ];
      break;
    case "annotation": {
      const existing = state.annotations.find(
        (item) => item.id === action.annotation.id,
      );
      if (action.operation === "add") {
        if (existing)
          fail(`Annotation already exists: ${action.annotation.id}`);
        next.annotations = [
          ...state.annotations,
          {
            ...action.annotation,
            comment: action.annotation.comment!,
            resolved: action.annotation.resolved ?? false,
          },
        ];
      } else {
        if (!existing) fail(`Unknown annotation: ${action.annotation.id}`);
        if (action.operation === "delete")
          next.annotations = state.annotations.filter(
            (item) => item.id !== existing.id,
          );
        else
          next.annotations = state.annotations.map((item) =>
            item.id === existing.id
              ? {
                  ...item,
                  ...action.annotation,
                  ...(action.operation === "resolve"
                    ? { resolved: action.annotation.resolved ?? true }
                    : {}),
                }
              : item,
          );
      }
      break;
    }
  }
  return next;
}
export function reduceEvents(
  events: readonly LabEvent[],
  status: Status = "idea",
  controls?: Record<string, Control>,
): LabState {
  return events.reduce(
    (state, event) => reduceEvent(state, event, controls),
    initialState(status),
  );
}
export const reducer = reduceEvent;
