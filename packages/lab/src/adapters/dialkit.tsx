import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  DialRoot,
  DialTimeline,
  useDialKitController,
  useDialTimeline,
  type DialConfig,
} from "dialkit";
import "dialkit/styles.css";
import type { Control, Values } from "../schema";
import type { ControlsAdapter, ControlsPanelProps } from "./types";

function configFor(
  controls: Record<string, Control>,
  values: Values,
): DialConfig {
  return Object.fromEntries(
    Object.entries(controls).map(([key, control]) => {
      const value = values[key] ?? control.default;
      if (control.type === "number")
        return [
          key,
          [value, control.min ?? 0, control.max ?? 100, control.step ?? 1],
        ];
      if (control.type === "select")
        return [
          key,
          { type: "select", default: value, options: control.options },
        ];
      if (control.type === "color" || control.type === "text")
        return [key, { type: control.type, default: value }];
      return [key, value];
    }),
  ) as DialConfig;
}

function Panel({
  entryId,
  controls,
  initialValues,
  onChange,
}: ControlsPanelProps) {
  // The shell remounts this panel only when intentionally restoring a version.
  const [config] = useState(() => configFor(controls, initialValues));
  const dial = useDialKitController("Live values", config, {
    id: `lab-${entryId}`,
    persist: false,
  });
  const serialized = JSON.stringify(dial.values);
  useEffect(() => {
    const scalar = Object.fromEntries(
      Object.entries(JSON.parse(serialized)).filter(([, value]) =>
        ["string", "number", "boolean"].includes(typeof value),
      ),
    );
    onChange(scalar as Values);
  }, [serialized, onChange]);
  return (
    <div className="lab-dials">
      <DialRoot mode="inline" theme="light" productionEnabled versions="menu" />
    </div>
  );
}
export const dialkitAdapter: ControlsAdapter = { name: "Dialkit", Panel };

/** A vendor-contained timeline: sampled presentation values never escape into entry metadata. */
export function MotionStudy({
  children,
  reducedMotion = false,
  duration = 0.24,
  name = "Opening study",
}: {
  children: (style: CSSProperties) => ReactNode;
  reducedMotion?: boolean;
  duration?: number;
  name?: string;
}) {
  const timeline = useDialTimeline(name, {
    enter: {
      at: 0,
      duration,
      from: { y: 12, opacity: 0 },
      to: { y: 0, opacity: 1 },
      transition: { type: "spring", bounce: 0 },
    },
  });
  return (
    <>
      <button className="lab-study-replay" onClick={() => timeline.replay()}>
        Replay opening
      </button>
      {children({
        opacity: timeline.enter.current.opacity,
        transform: reducedMotion
          ? "none"
          : `translateY(${timeline.enter.current.y}px)`,
      })}
      <DialTimeline productionEnabled defaultOpen />
    </>
  );
}
