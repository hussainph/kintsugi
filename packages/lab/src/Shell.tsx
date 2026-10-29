import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  defaultScenario,
  reconcileValues,
  kinds,
  statuses,
  type Entry,
  type Scenario,
  type Values,
} from "./schema";
import type { ControlsAdapter, CritiqueAdapter } from "./adapters/types";
import { Frame } from "./Frame";
import { defaults } from "./Preview";
import { request, useEntryState, type ClientState } from "./client";
import { AnalysisView } from "./views/AnalysisView";

export type ShellProps = {
  entries: Entry[];
  title?: string;
  subtitle?: string;
  mark?: ReactNode;
  projectName?: string;
  version?: string;
  controls?: ControlsAdapter;
  critique?: CritiqueAdapter;
  mcpEndpoint?: string;
};
const label = (value: string) =>
  value.replace(/-/g, " ").replace(/^./, (letter) => letter.toUpperCase());
const icons: Record<string, string> = {
  foundation: "◈",
  component: "▣",
  pattern: "▦",
  page: "▤",
  experiment: "✳",
};
function route() {
  const query = new URLSearchParams(location.search);
  return query.get("entry") || query.get("view") || "home";
}
export function Shell({
  entries,
  title = "Design Lab",
  subtitle = "A workbench for the details.",
  mark = "◈",
  projectName = title,
  version = "0.1",
  controls,
  critique,
  mcpEndpoint,
}: ShellProps) {
  const [page, setPage] = useState(route);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [group, setGroup] = useState("");
  const [status, setStatus] = useState("");
  const [archived, setArchived] = useState(false);
  const [states, setStates] = useState<Record<string, ClientState>>({});
  const [error, setError] = useState("");
  const [scenario, setScenario] = useState<Scenario>(() => ({
    ...defaultScenario,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  useEffect(() => {
    const back = () => setPage(route());
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  useEffect(() => {
    let active = true;
    if (
      entries.some((entry) => entry.meta.id === page) &&
      location.hash !== `#${page}`
    ) {
      history.replaceState(
        {},
        "",
        `${location.pathname}${location.search}#${page}`,
      );
    }
    Promise.allSettled(
      entries.map(
        async (entry) =>
          [
            entry.meta.id,
            await request<ClientState>(
              `state?id=${encodeURIComponent(entry.meta.id)}`,
            ),
          ] as const,
      ),
    )
      .then((items) => {
        if (active) {
          setStates(
            Object.fromEntries(
              items.flatMap((item) =>
                item.status === "fulfilled" ? [item.value] : [],
              ),
            ),
          );
          const failures = items.flatMap((item, index) =>
            item.status === "rejected"
              ? [`${entries[index].meta.id}: ${String(item.reason)}`]
              : [],
          );
          setError(
            failures.length
              ? `${failures.join("; ")}. Totals exclude unreadable threads.`
              : "",
          );
        }
      })
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [entries, page]);
  const navigate = (next: string) => {
    const entry = entries.some((entry) => entry.meta.id === next);
    history.pushState(
      {},
      "",
      next === "home"
        ? location.pathname
        : entry
          ? `?entry=${encodeURIComponent(next)}#${next}`
          : `?view=${next}`,
    );
    setPage(next);
    window.scrollTo(0, 0);
  };
  const active = entries.find((entry) => entry.meta.id === page);
  const groups = [...new Set(entries.map((entry) => entry.meta.group))].sort();
  const filtered = entries.filter((entry) => {
    const currentStatus = states[entry.meta.id]?.status ?? entry.meta.status;
    return (
      (!kind || entry.meta.kind === kind) &&
      (!group || entry.meta.group === group) &&
      (!status || currentStatus === status) &&
      (currentStatus !== "archived" || archived || !!search) &&
      `${entry.meta.title} ${entry.meta.summary} ${entry.meta.id} ${entry.meta.group} ${entry.meta.tickets.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase())
    );
  });
  const inProgress = entries.filter((entry) =>
    ["exploring", "refining"].includes(
      states[entry.meta.id]?.status ?? entry.meta.status,
    ),
  );
  return (
    <div className="lab-shell">
      <aside className="lab-nav" aria-label="Lab navigation">
        <button className="lab-brand" onClick={() => navigate("home")}>
          <span className="lab-mark">{mark}</span>
          <span>
            {title}
            <small>DESIGN WORKBENCH</small>
          </span>
        </button>
        <div className="lab-nav-section">
          <p>WORKSPACE</p>
          <Nav
            active={page === "home"}
            onClick={() => navigate("home")}
            icon="⌂"
          >
            Overview
          </Nav>
          <Nav
            active={page === "catalog"}
            onClick={() => {
              setKind("");
              navigate("catalog");
            }}
            icon="⊞"
          >
            All entries <small>{entries.length}</small>
          </Nav>
          <Nav
            active={page === "analyze"}
            onClick={() => navigate("analyze")}
            icon="⌁"
          >
            Analyze
          </Nav>
        </div>
        <div className="lab-nav-section">
          <p>THE SYSTEM</p>
          {kinds.map((item) => (
            <Nav
              key={item}
              icon={icons[item]}
              active={page === "catalog" && kind === item}
              onClick={() => {
                setKind(item);
                navigate("catalog");
              }}
            >
              {label(item)}s{" "}
              <small>
                {entries.filter((entry) => entry.meta.kind === item).length}
              </small>
            </Nav>
          ))}
        </div>
        <div className="lab-nav-section lab-nav-groups">
          <p>WHERE IT LIVES</p>
          {groups.map((item) => (
            <Nav
              key={item}
              active={page === "catalog" && group === item}
              onClick={() => {
                setGroup(item);
                setKind("");
                navigate("catalog");
              }}
              icon="·"
            >
              {label(item)}
            </Nav>
          ))}
        </div>
        <div className="lab-nav-foot">
          <span className="lab-live-dot" /> Local & file-backed
          <small>Nothing ships from here.</small>
        </div>
      </aside>
      <main className="lab-main">
        <header className="lab-topbar">
          <span>
            <span className="lab-breadcrumb">Workspace</span>
            <span className="lab-slash">/</span>
            {active
              ? active.meta.title
              : page === "analyze"
                ? "Analyze"
                : page === "catalog"
                  ? "Catalog"
                  : "Overview"}
          </span>
          <span className="lab-top-note">
            {projectName.toUpperCase()} <span> / </span> LAB{" "}
            <span className="lab-version">v{version}</span>
          </span>
        </header>
        {error && (
          <div role="alert" className="lab-alert">
            Catalog history unavailable: {error}
          </div>
        )}
        {active ? (
          <EntryWorkspace
            key={active.meta.id}
            entry={active}
            scenario={scenario}
            setScenario={setScenario}
            controls={controls}
            critique={critique}
            mcpEndpoint={mcpEndpoint}
            onNavigate={navigate}
          />
        ) : page === "analyze" ? (
          <AnalysisView />
        ) : (
          <div className="lab-catalog-page">
            {page === "home" ? (
              <>
                <div className="lab-eyebrow">
                  <span className="lab-live-dot" /> A PRACTICE, NOT A FINISH
                  LINE
                </div>
                <div className="lab-intro">
                  <div>
                    <h1>
                      A little space
                      <br />
                      to get it right.
                    </h1>
                    <p>
                      {subtitle} Explore the system, try a direction,
                      <br className="lab-wide-break" /> and leave a little
                      context for the next pass.
                    </p>
                  </div>
                  <div className="lab-intro-stamp">
                    <span>◈</span>
                    <small>
                      MAKE ROOM
                      <br />
                      FOR THE DETAILS
                    </small>
                  </div>
                </div>
                <div className="lab-stats">
                  <Stat number={entries.length} title="Entries in the system" />
                  <Stat number={inProgress.length} title="Taking shape" />
                  <Stat
                    number={Object.values(states).reduce(
                      (n, state) => n + state.snapshots.length,
                      0,
                    )}
                    title="Saved directions"
                  />
                  <Stat
                    number={Object.values(states).reduce(
                      (n, state) =>
                        n +
                        state.annotations.filter((item) => !item.resolved)
                          .length +
                        state.notes.filter(
                          (note) => note.kind === "critique" && !note.resolved,
                        ).length,
                      0,
                    )}
                    title="Open critiques"
                  />
                </div>
              </>
            ) : (
              <div className="lab-catalog-heading">
                <div className="lab-eyebrow">THE WHOLE, IN ITS PARTS</div>
                <h1>{kind ? `${label(kind)}s` : "All entries"}</h1>
                <p>Live pieces of the product, with room to explore.</p>
              </div>
            )}
            <section className="lab-catalog-section">
              <div className="lab-section-heading">
                <h2>
                  {page === "home" ? "On the workbench" : "Catalog"}{" "}
                  <small>{filtered.length}</small>
                </h2>
                <span>Explore, refine, repeat.</span>
              </div>
              <div className="lab-filters">
                <label className="lab-search">
                  <span>⌕</span>
                  <input
                    aria-label="Search entries"
                    placeholder="Find an entry, a thought, a ticket…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <select
                  aria-label="Filter kind"
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                >
                  <option value="">All kinds</option>
                  {kinds.map((kind) => (
                    <option key={kind}>{kind}</option>
                  ))}
                </select>
                <select
                  aria-label="Filter group"
                  value={group}
                  onChange={(event) => setGroup(event.target.value)}
                >
                  <option value="">All groups</option>
                  {groups.map((group) => (
                    <option key={group}>{group}</option>
                  ))}
                </select>
                <select
                  aria-label="Filter status"
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                >
                  <option value="">All statuses</option>
                  {statuses.map((status) => (
                    <option key={status}>{status}</option>
                  ))}
                </select>
                <label className="lab-checkbox">
                  <input
                    type="checkbox"
                    checked={archived}
                    onChange={(event) => setArchived(event.target.checked)}
                  />
                  Archived
                </label>
              </div>
              <div className="lab-entry-grid">
                {filtered.map((entry) => (
                  <EntryCard
                    key={entry.meta.id}
                    entry={entry}
                    status={states[entry.meta.id]?.status ?? entry.meta.status}
                    onOpen={() => navigate(entry.meta.id)}
                  />
                ))}
              </div>
              {!filtered.length && (
                <p className="lab-empty">
                  No entries match. Try a different filter.
                </p>
              )}
            </section>
            {page === "home" && (
              <RecentActivity
                entries={entries}
                states={states}
                onOpen={navigate}
              />
            )}
            <footer className="lab-footer">
              <span>Good things take a few passes.</span>
              <span>Built from the real product. Safe to play.</span>
            </footer>
          </div>
        )}
      </main>
    </div>
  );
}
function Nav({
  children,
  active,
  onClick,
  icon,
}: {
  children: ReactNode;
  active: boolean;
  onClick: () => void;
  icon: string;
}) {
  return (
    <button
      className={`lab-nav-item ${active ? "is-active" : ""}`}
      onClick={onClick}
    >
      <span>{icon}</span>
      {children}
    </button>
  );
}
function Stat({ number, title }: { number: number; title: string }) {
  return (
    <div>
      <strong>{String(number).padStart(2, "0")}</strong>
      <span>{title}</span>
    </div>
  );
}
function EntryCard({
  entry,
  status,
  onOpen,
}: {
  entry: Entry;
  status: string;
  onOpen: () => void;
}) {
  return (
    <button className="lab-entry-card" onClick={onOpen}>
      <div
        className={`lab-card-art kind-${entry.meta.kind}`}
        aria-hidden="true"
      >
        <span>{icons[entry.meta.kind]}</span>
        <small>
          {entry.meta.kind === "foundation"
            ? "Aa  /  01"
            : entry.meta.kind === "experiment"
              ? "WHAT IF…"
              : entry.meta.kind === "page"
                ? "A PLACE TO THINK"
                : "FORM & FUNCTION"}
        </small>
        <span className="lab-art-lines" />
      </div>
      <div className="lab-card-body">
        <div className="lab-card-meta">
          <span>{label(entry.meta.group)}</span>
          <Status value={status} />
        </div>
        <h3>
          {entry.meta.title}
          <span>↗</span>
        </h3>
        <p>{entry.meta.summary}</p>
        <div className="lab-card-foot">
          <span>{label(entry.meta.kind)}</span>
          <span>
            {entry.stories.length}{" "}
            {entry.stories.length === 1 ? "story" : "stories"}
          </span>
        </div>
      </div>
    </button>
  );
}
function Status({ value }: { value: string }) {
  return (
    <span className={`lab-status status-${value}`}>
      <i />
      {value}
    </span>
  );
}
function RecentActivity({
  entries,
  states,
  onOpen,
}: {
  entries: Entry[];
  states: Record<string, ClientState>;
  onOpen: (id: string) => void;
}) {
  const recent = entries
    .flatMap((entry) =>
      (states[entry.meta.id]?.events ?? []).map((event) => ({ entry, event })),
    )
    .sort((a, b) => b.event.at.localeCompare(a.event.at))
    .slice(0, 5);
  return (
    <section className="lab-recent">
      <div className="lab-section-heading">
        <h2>A trail of small decisions</h2>
        <span>Recent activity</span>
      </div>
      {recent.length ? (
        recent.map(({ entry, event }) => (
          <button key={event.id} onClick={() => onOpen(entry.meta.id)}>
            <span>{icons[entry.meta.kind]}</span>
            <strong>{entry.meta.title}</strong>
            <span>Exploration updated</span>
            <time>
              {new Date(event.at).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </time>
            <span>↗</span>
          </button>
        ))
      ) : (
        <p className="lab-empty">
          Notes, critiques and snapshots leave their trail here.
        </p>
      )}
    </section>
  );
}

function EntryWorkspace({
  entry,
  scenario,
  setScenario,
  controls,
  critique,
  mcpEndpoint,
  onNavigate,
}: {
  entry: Entry;
  scenario: Scenario;
  setScenario: (scenario: Scenario) => void;
  controls?: ControlsAdapter;
  critique?: CritiqueAdapter;
  mcpEndpoint?: string;
  onNavigate: (id: string) => void;
}) {
  const { state, error, busy, send, retry, refresh } = useEntryState(
    entry.meta.id,
  );
  const [storyId, setStoryId] = useState(entry.stories[0].id);
  const [values, setValues] = useState<Values>(() => defaults(entry));
  const [reset, setReset] = useState(0);
  const [tab, setTab] = useState("design");
  const [annotate, setAnnotate] = useState(false);
  const [snapshotName, setSnapshotName] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [brief, setBrief] = useState("");
  const changeValues = useCallback((next: Values) => setValues(next), []);
  const restore = (next: Values, nextScenario?: Scenario) => {
    const restored = reconcileValues(next, entry.controls);
    setValues(restored.values);
    setCopyMessage(
      restored.issues.length
        ? `Saved controls changed: ${restored.issues.join(", ")}. Current defaults used.`
        : "Saved values restored on the current story.",
    );
    setReset((value) => value + 1);
    if (nextScenario) setScenario(nextScenario);
  };
  const save = async () => {
    try {
      await send({
        type: "snapshot",
        name: snapshotName.trim(),
        values,
        scenario,
      });
      setSnapshotName("");
    } catch {
      /* State hook displays retry. */
    }
  };
  const copy = async () => {
    const output = [
      `# ${entry.meta.title}`,
      entry.meta.summary,
      "## Apply tuned values",
      ...Object.entries(entry.controls).map(
        ([name, control]) =>
          `- \`${name}\`: \`${JSON.stringify(values[name])}\` → \`${control.target}\``,
      ),
      "## Sources",
      ...entry.meta.sources.map((file) => `- \`${file}\``),
      "## Scenario",
      "```json",
      JSON.stringify(scenario, null, 2),
      "```",
      "## Open critiques",
      ...(state?.notes
        .filter((note) => note.kind === "critique" && !note.resolved)
        .map((note) => `- ${note.text}`) ?? []),
      ...(state?.annotations
        .filter((item) => !item.resolved)
        .map(
          (item) =>
            `- ${item.comment}${item.elementPath ? ` (\`${item.elementPath}\`)` : ""}`,
        ) ?? []),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(output);
      setCopyMessage("Brief copied");
    } catch {
      setBrief(output);
      setCopyMessage("Select and copy the brief below");
    }
  };
  const Panel = controls?.Panel;
  const Toolbar = critique?.Toolbar;
  return (
    <div className="lab-entry-page">
      <div className="lab-entry-heading">
        <div>
          <button className="lab-back" onClick={() => onNavigate("catalog")}>
            ← Catalog
          </button>
          <div className="lab-eyebrow">
            {label(entry.meta.kind)} / {label(entry.meta.group)}
          </div>
          <h1>{entry.meta.title}</h1>
          <p>{entry.meta.summary}</p>
          {entry.meta.question && (
            <p className="lab-hypothesis">Question: {entry.meta.question}</p>
          )}
        </div>
        <div className="lab-entry-actions">
          <select
            aria-label="Entry status"
            value={state?.status ?? entry.meta.status}
            disabled={!state || busy}
            onChange={(event) => {
              void send({ type: "status", status: event.target.value }).catch(
                () => {},
              );
            }}
          >
            {statuses.map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
          <button className="lab-primary" onClick={copy}>
            Copy for agent ↗
          </button>
          <span role="status">{copyMessage}</span>
        </div>
      </div>
      {brief && (
        <textarea
          className="lab-brief"
          aria-label="Agent brief"
          readOnly
          value={brief}
          onFocus={(event) => event.target.select()}
        />
      )}
      {error && (
        <div className="lab-alert" role="alert">
          {error}{" "}
          <button
            onClick={() => {
              void retry().catch(() => {});
            }}
          >
            Retry
          </button>
        </div>
      )}
      <ScenarioBar value={scenario} onChange={setScenario} />
      <div
        className="lab-workspace-tabs"
        role="tablist"
        aria-label="Entry activities"
      >
        {["design", "compare", "thread", "sources"].map((item) => (
          <button
            key={item}
            role="tab"
            aria-selected={tab === item}
            onClick={() => {
              setTab(item);
              if (item === "thread" && !busy) void refresh();
            }}
          >
            {label(item)}
            {item === "thread" && (
              <small>
                {(state?.notes.length ?? 0) + (state?.annotations.length ?? 0)}
              </small>
            )}
          </button>
        ))}
        <span>Live product · isolated fixtures</span>
        {Toolbar && (
          <button
            disabled={!state || busy}
            aria-pressed={annotate}
            onClick={() => setAnnotate(!annotate)}
          >
            {annotate ? "Stop annotating" : "Annotate ⊕"}
          </button>
        )}
      </div>
      {tab === "design" && (
        <div className="lab-design-layout">
          <section className="lab-stage">
            <div className="lab-stage-toolbar">
              <select
                aria-label="Story"
                value={storyId}
                onChange={(event) => setStoryId(event.target.value)}
              >
                {entry.stories.map((story) => (
                  <option key={story.id} value={story.id}>
                    {story.title}
                  </option>
                ))}
              </select>
              <span>
                {scenario.width}px <span>·</span>{" "}
                {Math.round(scenario.textScale * 100)}%
              </span>
            </div>
            <div className="lab-stage-canvas">
              <Frame
                entry={entry}
                storyId={storyId}
                scenario={scenario}
                values={values}
                height={scenario.width < 500 ? 780 : 600}
              />
            </div>
            <div className="lab-stage-caption">
              <span>
                {entry.meta.id} / {storyId}
              </span>
              <span>Changes stay here until you apply them.</span>
            </div>
          </section>
          <aside className="lab-inspector">
            <div className="lab-inspector-heading">
              <h2>Make it yours</h2>
              <button onClick={() => restore(defaults(entry))}>Reset</button>
            </div>
            <p className="lab-inspector-copy">
              Tune a direction, then keep the one that feels right.
            </p>
            {Object.keys(entry.controls).length && Panel ? (
              <Panel
                key={`${entry.meta.id}-${reset}`}
                entryId={`${entry.meta.id}-${reset}`}
                controls={entry.controls}
                initialValues={values}
                onChange={changeValues}
              />
            ) : (
              <p className="lab-empty">
                This entry is a study of the live source. No dials declared.
              </p>
            )}
            {!!entry.variants?.length && (
              <label className="lab-field">
                Start from a variant
                <select
                  aria-label="Apply variant"
                  defaultValue=""
                  onChange={(event) => {
                    const variant = entry.variants?.find(
                      (variant) => variant.id === event.target.value,
                    );
                    if (variant) restore(variant.values);
                  }}
                >
                  <option value="" disabled>
                    Choose a direction
                  </option>
                  {entry.variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {variant.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="lab-snapshot-form">
              <h3>Keep a direction</h3>
              <input
                aria-label="Snapshot name"
                placeholder="Give this snapshot a name…"
                value={snapshotName}
                onChange={(event) => setSnapshotName(event.target.value)}
              />
              <button
                className="lab-primary"
                disabled={!snapshotName.trim() || !state || busy}
                onClick={save}
              >
                {busy ? "Saving…" : "Save snapshot"}
              </button>
              <small>Values + scenario, reusable across stories.</small>
            </div>
            {state?.snapshots.map((snapshot) => (
              <button
                className="lab-saved-snapshot"
                key={snapshot.id}
                onClick={() => restore(snapshot.values, snapshot.scenario)}
              >
                <span>◈ {snapshot.name}</span>
                <small>Restore ↗</small>
              </button>
            ))}
          </aside>
        </div>
      )}
      {tab === "compare" && (
        <Compare
          entry={entry}
          storyId={storyId}
          scenario={scenario}
          values={values}
          state={state}
        />
      )}
      {tab === "thread" && <Thread state={state} busy={busy} send={send} />}
      {tab === "sources" && (
        <section className="lab-sources">
          <h2>Built from the real thing.</h2>
          <p>
            These are live imports, not copies. Apply an exploration
            deliberately in the source.
          </p>
          {entry.meta.sources.map((source) => (
            <code key={source}>{source}</code>
          ))}
          <h3>Connected work</h3>
          <div>
            {entry.meta.tickets.map((ticket) => (
              <span className="lab-ticket" key={ticket}>
                {ticket}
              </span>
            ))}
          </div>
          {entry.meta.related.map((id) => (
            <button
              className="lab-related"
              key={id}
              onClick={() => onNavigate(id)}
            >
              {id} ↗
            </button>
          ))}
        </section>
      )}
      {annotate && state && Toolbar && (
        <Toolbar
          entryId={entry.meta.id}
          endpoint={mcpEndpoint}
          onAnnotation={(operation, annotation) => {
            void send({ type: "annotation", operation, annotation }).catch(
              () => {},
            );
          }}
        />
      )}
    </div>
  );
}
function ScenarioBar({
  value,
  onChange,
}: {
  value: Scenario;
  onChange: (scenario: Scenario) => void;
}) {
  return (
    <div className="lab-scenario" aria-label="Global scenario">
      <span>SCENARIO</span>
      <label>
        Theme
        <select
          aria-label="Theme"
          value={value.theme}
          onChange={(event) =>
            onChange({
              ...value,
              theme: event.target.value as Scenario["theme"],
            })
          }
        >
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label>
        Viewport
        <select
          aria-label="Viewport width"
          value={value.width}
          onChange={(event) =>
            onChange({ ...value, width: Number(event.target.value) })
          }
        >
          {![1440, 1280, 1024, 768, 430, 390, 375].includes(value.width) && (
            <option value={value.width}>Custom · {value.width}</option>
          )}
          {[
            [1440, "Desktop · 1440"],
            [1280, "Laptop · 1280"],
            [1024, "Small window · 1024"],
            [768, "Tablet · 768"],
            [430, "Phone · 430"],
            [390, "Phone · 390"],
            [375, "Compact phone · 375"],
          ].map(([width, title]) => (
            <option key={width} value={width}>
              {title}
            </option>
          ))}
        </select>
      </label>
      <label>
        Text
        <select
          aria-label="Text scale"
          value={value.textScale}
          onChange={(event) =>
            onChange({ ...value, textScale: Number(event.target.value) })
          }
        >
          {![0.85, 1, 1.15, 1.3, 1.5].includes(value.textScale) && (
            <option value={value.textScale}>
              Custom · {Math.round(value.textScale * 100)}%
            </option>
          )}
          {[0.85, 1, 1.15, 1.3, 1.5].map((scale) => (
            <option key={scale} value={scale}>
              {Math.round(scale * 100)}%
            </option>
          ))}
        </select>
      </label>
      <label>
        Density
        <select
          aria-label="Density"
          value={value.density}
          onChange={(event) =>
            onChange({
              ...value,
              density: event.target.value as Scenario["density"],
            })
          }
        >
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </label>
      <label className="lab-checkbox">
        <input
          type="checkbox"
          checked={value.reducedMotion}
          onChange={(event) =>
            onChange({ ...value, reducedMotion: event.target.checked })
          }
        />
        Reduced motion
      </label>
    </div>
  );
}
function Compare({
  entry,
  storyId,
  scenario,
  values,
  state,
}: {
  entry: Entry;
  scenario: Scenario;
  values: Values;
  state?: ClientState;
  storyId: string;
}) {
  const candidates = useMemo(
    () => [
      ...entry.stories.map((story) => ({
        id: `story-${story.id}`,
        title: story.title,
        storyId: story.id,
        values,
        scenario,
      })),
      ...(entry.variants ?? []).map((variant) => ({
        id: `variant-${variant.id}`,
        title: variant.title,
        storyId,
        values: { ...defaults(entry), ...variant.values },
        scenario,
      })),
      ...(state?.snapshots ?? []).map((snapshot) => ({
        ...snapshot,
        id: `snapshot-${snapshot.id}`,
        title: snapshot.name,
        storyId,
      })),
    ],
    [entry, values, scenario, state, storyId],
  );
  const [selected, setSelected] = useState<string[]>(() =>
    candidates.slice(0, 2).map((item) => item.id),
  );
  return (
    <section className="lab-compare">
      <div className="lab-section-heading">
        <div>
          <h2>A second point of view.</h2>
          <p>
            Compare up to four stories, variants or saved directions. Variants
            and saved values use the selected story:{" "}
            {entry.stories.find((story) => story.id === storyId)?.title}.
          </p>
        </div>
      </div>
      <div className="lab-compare-choices">
        {candidates.map((item) => (
          <label key={item.id}>
            <input
              type="checkbox"
              checked={selected.includes(item.id)}
              disabled={!selected.includes(item.id) && selected.length >= 4}
              onChange={() =>
                setSelected(
                  selected.includes(item.id)
                    ? selected.filter((id) => id !== item.id)
                    : [...selected, item.id],
                )
              }
            />
            {item.title}
          </label>
        ))}
      </div>
      <div className="lab-compare-grid">
        {candidates
          .filter((item) => selected.includes(item.id))
          .map((item) => (
            <article key={item.id}>
              <h3>
                {item.title}
                <small>
                  {item.scenario.width}px · {item.scenario.theme}
                </small>
              </h3>
              <Frame
                entry={entry}
                storyId={item.storyId}
                scenario={item.scenario}
                values={item.values}
                height={640}
              />
            </article>
          ))}
      </div>
    </section>
  );
}
function Thread({
  state,
  busy,
  send,
}: {
  state?: ClientState;
  busy: boolean;
  send: (action: Record<string, unknown>) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState("note");
  return (
    <section className="lab-thread">
      <h2>Leave the thinking here.</h2>
      <p>
        A running record of notes, critiques and decisions. Nothing is
        overwritten.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await send({ type: "note", kind, text: text.trim() });
            setText("");
          } catch {
            /* Error shown by parent. */
          }
        }}
      >
        <textarea
          aria-label="Thread note"
          placeholder="What did you notice? What should we try next?"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div>
          <select
            aria-label="Note kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="note">Note</option>
            <option value="critique">Critique</option>
            <option value="decision">Decision</option>
          </select>
          <button
            className="lab-primary"
            disabled={!text.trim() || !state || busy}
          >
            Add to thread
          </button>
        </div>
      </form>
      <div className="lab-thread-list">
        {state?.notes
          .slice()
          .reverse()
          .map((note) => (
            <article key={note.id}>
              <div>
                <span className="lab-eyebrow">
                  {note.resolved ? "Resolved critique" : note.kind}
                </span>
                <time>{new Date(note.at).toLocaleString()}</time>
                {note.kind === "critique" && !note.resolved && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      void send({
                        type: "resolve-critique",
                        noteId: note.id,
                      }).catch(() => {});
                    }}
                  >
                    Resolve
                  </button>
                )}
              </div>
              <p>{note.text}</p>
            </article>
          ))}
        {state?.annotations.map((annotation) => (
          <article key={annotation.id}>
            <div>
              <span className="lab-eyebrow">
                {annotation.resolved ? "Resolved critique" : "Open critique"}
              </span>
              {!annotation.resolved && (
                <button
                  onClick={() => {
                    void send({
                      type: "annotation",
                      operation: "resolve",
                      annotation: { id: annotation.id },
                    }).catch(() => {});
                  }}
                >
                  Resolve
                </button>
              )}
            </div>
            <p>{annotation.comment}</p>
            <code>{annotation.elementPath}</code>
          </article>
        ))}
        {!state?.notes.length && !state?.annotations.length && (
          <p className="lab-empty">
            The first thought is a good place to start.
          </p>
        )}
      </div>
      <details className="lab-event-history">
        <summary>Append-only event history · {state?.revision ?? 0}</summary>
        <pre>{JSON.stringify(state?.events, null, 2)}</pre>
      </details>
    </section>
  );
}
