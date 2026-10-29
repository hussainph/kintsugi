import { useState } from "react";
import {
  defineEntry,
  type EntryMeta,
  type Control,
  type Values,
} from "@kintsugi/lab";
import { Button } from "@kintsugi/ui/components/button";
export const meta: EntryMeta = {
  id: "component/button",
  title: "Button",
  kind: "component",
  group: "system",
  status: "exploring",
  sources: ["packages/ui/src/components/button.tsx"],
  tickets: ["KI-15"],
  related: [
    "component/dialog",
    "foundation/color",
    "foundation/radius-and-elevation",
  ],
  summary:
    "Product button variants and sizes with real focus, disabled, pressed and click behavior.",
};
export const controls: Record<string, Control> = {
  label: {
    type: "text",
    default: "Keep something",
    target: "packages/ui/src/components/button.tsx#children",
  },
  size: {
    type: "select",
    default: "default",
    options: ["xs", "sm", "default", "lg"],
    target: "packages/ui/src/components/button.tsx#size",
  },
  disabled: {
    type: "boolean",
    default: false,
    target: "packages/ui/src/components/button.tsx#disabled",
  },
};
function Buttons({ values }: { values: Values }) {
  const [pressed, setPressed] = useState("No action yet.");
  return (
    <div className="mx-auto flex min-h-svh max-w-3xl flex-col justify-center gap-8 p-8">
      <div>
        <p className="mb-2 text-xs text-muted-foreground">
          Actions, with the same words
        </p>
        <h1 className="text-2xl font-medium">Quiet until you need them.</h1>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        {(
          [
            "default",
            "secondary",
            "outline",
            "ghost",
            "destructive",
            "link",
          ] as const
        ).map((variant) => (
          <div className="flex flex-col items-start gap-3" key={variant}>
            <Button
              variant={variant}
              size={values.size as "default" | "xs" | "sm" | "lg"}
              disabled={Boolean(values.disabled)}
              onClick={() => setPressed(`${variant}: kept in this preview.`)}
            >
              {String(values.label)}
            </Button>
            <code className="text-[11px] text-muted-foreground">{variant}</code>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-4">
        {(["xs", "sm", "default", "lg"] as const).map((size) => (
          <Button
            key={size}
            size={size}
            variant="outline"
            onClick={() => setPressed(`${size} button pressed.`)}
          >
            {size}
          </Button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground" role="status">
        {pressed}
      </p>
    </div>
  );
}
export default defineEntry({
  meta,
  controls,
  stories: [
    {
      id: "default",
      title: "Actions and hierarchy",
      render: ({ values }) => <Buttons values={values} />,
    },
  ],
  variants: [
    { id: "unavailable", title: "Disabled", values: { disabled: true } },
    { id: "compact", title: "Compact action", values: { size: "xs" } },
  ],
});
