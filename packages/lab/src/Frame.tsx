import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  reconcileValues,
  type Entry,
  type Scenario,
  type Values,
} from "./schema";

export function Frame({
  entry,
  storyId,
  scenario,
  values,
  height = 580,
}: {
  entry: Entry;
  storyId: string;
  scenario: Scenario;
  values: Values;
  height?: number;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [available, setAvailable] = useState(scenario.width);
  const scale = Math.min(1, available / scenario.width);
  const reconciled = useMemo(
    () => reconcileValues(values, entry.controls),
    [values, entry.controls],
  );
  const send = useCallback(
    () =>
      frame.current?.contentWindow?.postMessage(
        { type: "lab:scenario", scenario, values: reconciled.values },
        location.origin,
      ),
    [scenario, reconciled],
  );
  useEffect(() => {
    const node = holder.current;
    if (!node) return;
    const observer = new ResizeObserver(([size]) =>
      setAvailable(size.contentRect.width),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    send();
    const ready = (event: MessageEvent) => {
      if (
        event.origin === location.origin &&
        event.source === frame.current?.contentWindow &&
        event.data?.type === "lab:ready"
      )
        send();
    };
    window.addEventListener("message", ready);
    return () => window.removeEventListener("message", ready);
  }, [send]);
  return (
    <>
      {!!reconciled.issues.length && (
        <p className="lab-frame-warning" role="status">
          Saved controls changed: {reconciled.issues.join(", ")}. Current
          defaults used.
        </p>
      )}
      <div
        ref={holder}
        className="lab-frame-holder"
        style={{ height: height * scale }}
      >
        <iframe
          ref={frame}
          title={`${entry.meta.title} · ${storyId}`}
          src={`?preview=${encodeURIComponent(entry.meta.id)}&story=${encodeURIComponent(storyId)}`}
          onLoad={send}
          style={{
            width: scenario.width,
            height,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        />
      </div>
    </>
  );
}
