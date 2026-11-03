import { Button } from "@kintsugi/ui/components/button";
import { Radio, RadioGroup } from "@kintsugi/ui/graphical";
import { Minus, Plus } from "@kintsugi/ui/icons";
import { setAppearance, useAppearance, type Appearance } from "@/lib/appearance";
import { setTextSize, stepSize, TEXT_SIZES, useTextSize } from "@/lib/textSize";
import { Group, Page, Row } from "./parts";

const MODES: { value: Appearance; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/** Real app captures from KI-65, downsampled for this gallery. System is the
 * same image split at its midpoint, rather than two squeezed thumbnails. */
function ModePreview({ mode }: { mode: Appearance }) {
  return (
    <span className="ki-appearance-thumbnail" aria-hidden="true">
      <img src={`appearance/${mode === "dark" ? "dark" : "light"}.png`} alt="" />
      {mode === "system" && <img className="ki-appearance-split" src="appearance/dark.png" alt="" />}
    </span>
  );
}

export function AppearanceSettings() {
  const mode = useAppearance();
  const size = useTextSize();
  return (
    <Page title="Appearance">
      <RadioGroup className="ki-appearance-gallery" aria-label="Appearance" value={mode} onValueChange={(value) => setAppearance(value as Appearance)}>
        {MODES.map(({ value, label }) => (
          <label key={value} className="ki-appearance-option">
            <ModePreview mode={value} />
            <span className="ki-settings-inline ki-text-s">
              <Radio.Root value={value}><Radio.Indicator /></Radio.Root>
              {label}
            </span>
          </label>
        ))}
      </RadioGroup>
      <Group className="ki-appearance-writing">
        <Row label="Text size">
          <div className="ki-settings-inline" role="group" aria-label="Text size">
            <Button size="icon-sm" variant="outline" aria-label="Smaller text" disabled={size === TEXT_SIZES[0]} onClick={() => setTextSize(stepSize(size, -1))}>
              <Minus />
            </Button>
            <output className="ki-data ki-settings-size" aria-live="polite">{Math.round(size * 100)}%</output>
            <Button size="icon-sm" variant="outline" aria-label="Larger text" disabled={size === TEXT_SIZES[TEXT_SIZES.length - 1]} onClick={() => setTextSize(stepSize(size, 1))}>
              <Plus />
            </Button>
          </div>
        </Row>
        <Row label="Editor font"><span className="ki-text-s ki-muted">LT Superior Serif</span></Row>
      </Group>
      <section className="ki-appearance-sample" aria-label="Text sample">
        <p className="ki-appearance-sample-title">Kintsugi and gold</p>{/* copy-lint-allow: verbatim Paper writing sample */}
        <p>The first time I saw a kintsugi bowl I thought the gold was decoration. It is not. The gold is a decision: this break is part of the object now, and we are not going to pretend otherwise.</p>{/* copy-lint-allow: verbatim Paper writing sample */}
      </section>
    </Page>
  );
}
