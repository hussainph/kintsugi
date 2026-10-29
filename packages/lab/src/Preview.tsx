import {
  Component,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  defaultScenario,
  validateScenario,
  validateValues,
  type Entry,
  type Scenario,
  type Values,
} from "./schema";

declare global {
  interface Window {
    __LAB_STORIES__?: Array<{ entryId: string; storyId: string }>;
    __LAB_READY__?: boolean;
    __LAB_ERROR__?: string;
  }
}
export function defaults(entry: Entry): Values {
  return Object.fromEntries(
    Object.entries(entry.controls).map(([name, control]) => [
      name,
      control.default,
    ]),
  );
}

class Boundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    window.__LAB_ERROR__ = `${error.message}\n${info.componentStack}`;
  }
  render() {
    return this.state.error ? (
      <pre role="alert">Story failed: {this.state.error}</pre>
    ) : (
      this.props.children
    );
  }
}

function RenderStory({
  story,
  scenario,
  values,
}: {
  story: Entry["stories"][number];
  scenario: Scenario;
  values: Values;
}) {
  return story.render({ scenario, values });
}

/** A frame is a real viewport, with its own portal roots and fixture bridge. */
export function Preview({ entry, storyId }: { entry: Entry; storyId: string }) {
  const [scenario, setScenario] = useState<Scenario>(defaultScenario);
  const [values, setValues] = useState<Values>(() => defaults(entry));
  const story = entry.stories.find((item) => item.id === storyId);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== window.parent ||
        event.data?.type !== "lab:scenario"
      )
        return;
      // Same-origin is necessary, but malformed messages still must not mutate a story.
      try {
        const nextScenario = validateScenario(event.data.scenario);
        const nextValues = validateValues(event.data.values, entry.controls);
        setScenario(nextScenario);
        setValues({ ...defaults(entry), ...nextValues });
      } catch {
        // An invalid preview protocol message is ignored, never trusted as UI state.
      }
    };
    window.addEventListener("message", receive);
    window.__LAB_READY__ = true;
    window.parent.postMessage(
      { type: "lab:ready", entryId: entry.meta.id },
      location.origin,
    );
    return () => {
      window.removeEventListener("message", receive);
      window.__LAB_READY__ = false;
    };
  }, [entry.meta.id]);
  useEffect(() => {
    document.documentElement.classList.toggle(
      "dark",
      scenario.theme === "dark",
    );
    document.documentElement.dataset.labDensity = scenario.density;
    document.documentElement.dataset.labReducedMotion = String(
      scenario.reducedMotion,
    );
    document.documentElement.style.fontSize = `${scenario.textScale * 100}%`;
    document.documentElement.style.setProperty(
      "--lab-text-scale",
      String(scenario.textScale),
    );
    document.documentElement.style.colorScheme = scenario.theme;
  }, [scenario]);
  if (!story) throw new Error(`Missing story ${entry.meta.id}/${storyId}`);
  return (
    <Boundary>
      <div
        className="lab-preview-root"
        data-lab-entry={entry.meta.id}
        data-lab-story={story.id}
      >
        <RenderStory story={story} scenario={scenario} values={values} />
      </div>
    </Boundary>
  );
}
