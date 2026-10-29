import { Agentation } from "agentation";
import type { CritiqueAdapter, CritiqueProps } from "./types";

function Toolbar({ entryId, endpoint, onAnnotation }: CritiqueProps) {
  // No endpoint by default. Persistence is the host's thread, not this vendor's storage.
  return (
    <Agentation
      key={entryId}
      appName={`Lab · ${entryId}`}
      useHashLocation
      enableKeyboardShortcuts={false}
      endpoint={endpoint}
      onAnnotationAdd={(annotation) => onAnnotation("add", annotation)}
      onAnnotationUpdate={(annotation) => onAnnotation("update", annotation)}
      onAnnotationDelete={(annotation) => onAnnotation("delete", annotation)}
      onAnnotationsClear={(annotations) =>
        annotations.forEach((annotation) => onAnnotation("delete", annotation))
      }
    />
  );
}
export const agentationAdapter: CritiqueAdapter = {
  name: "Agentation",
  Toolbar,
  license: "PolyForm Shield 1.0.0 (source-available)",
};
