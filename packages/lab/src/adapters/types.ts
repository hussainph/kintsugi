import type { ComponentType } from "react";
import type { Control, Values } from "../schema";

/** Integration-neutral boundary. Entry definitions never import a vendor. */
export type ControlsPanelProps = {
  entryId: string;
  controls: Record<string, Control>;
  initialValues: Values;
  onChange: (values: Values) => void;
};
export type ControlsAdapter = {
  Panel: ComponentType<ControlsPanelProps>;
  name: string;
};
export type CritiqueAnnotation = {
  id: string;
  comment: string;
  elementPath?: string;
  [key: string]: unknown;
};
export type CritiqueProps = {
  entryId: string;
  endpoint?: string;
  onAnnotation: (
    operation: "add" | "update" | "delete",
    annotation: CritiqueAnnotation,
  ) => void;
};
export type CritiqueAdapter = {
  Toolbar: ComponentType<CritiqueProps>;
  name: string;
  license: string;
};
