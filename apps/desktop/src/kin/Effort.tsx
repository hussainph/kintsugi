import { useState } from "react";
import { Slider } from "@kintsugi/ui/graphical";
import { cn } from "@kintsugi/ui/lib/utils";
import { levelName, type ThinkingLevel } from "@/lib/ai";

type Props = {
  /** The levels the model supports, weakest first (`effortLevels`). */
  levels: ThinkingLevel[];
  /** The level it runs at now; moved to the nearest supported one. */
  value: ThinkingLevel | null | undefined;
  onChange: (level: ThinkingLevel) => void;
  /** Names the slider for assistive tech ("Chat effort"). */
  label: string;
  disabled?: boolean;
  className?: string;
};

const ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The supported level nearest `level`: itself, else the next stronger, else the next weaker (Rust's `Model::clamp`). */
function nearest(levels: ThinkingLevel[], level: ThinkingLevel | null | undefined): number {
  if (!level) return Math.min(levels.indexOf("medium"), levels.length - 1);
  const at = levels.indexOf(level);
  if (at >= 0) return at;
  const rank = ORDER.indexOf(level);
  const stronger = levels.findIndex((l) => ORDER.indexOf(l) > rank);
  return stronger >= 0 ? stronger : levels.length - 1;
}

/**
 * How hard the model thinks: a small stepped slider over the levels it
 * supports, with the level's name beside it. Renders nothing for a model
 * with one level or none (`effortLevels`).
 */
export function Effort({ levels, value, onChange, label, disabled, className }: Props) {
  // While dragging, the thumb and the name follow the pointer; the level is
  // saved when it's let go.
  const [moving, setMoving] = useState<number | null>(null);
  if (levels.length < 2) return null;
  const index = Math.max(0, nearest(levels, value));
  const shown = moving ?? index;
  return (
    <Slider.Root
      className={cn("ki-effort", className)}
      value={shown}
      min={0}
      max={levels.length - 1}
      step={1}
      disabled={disabled}
      onValueChange={(next) => setMoving(next as number)}
      onValueCommitted={(next) => {
        setMoving(null);
        const level = levels[next as number];
        if (level && level !== levels[index]) onChange(level);
      }}
      data-level={levels[shown]}
    >
      <Slider.Control className="ki-effort-control">
        <Slider.Track>
          <Slider.Indicator />
          <Slider.Thumb aria-label={label} getAriaValueText={(_, v) => levelName(levels[v] ?? levels[shown])} />
        </Slider.Track>
      </Slider.Control>
      <span className="ki-effort-value" aria-hidden>{levelName(levels[shown])}</span>
    </Slider.Root>
  );
}
