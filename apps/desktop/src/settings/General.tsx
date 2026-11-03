import { Button } from "@kintsugi/ui/components/button";
import { Minus, Plus } from "@kintsugi/ui/icons";
import { setTextSize, stepSize, TEXT_SIZES, useTextSize } from "@/lib/textSize";
import { Group, Page, Row } from "./parts";
import { OptionalTools } from "./OptionalTools";
import { ShortcutHint } from "@/components/Shortcuts";

type Props = {
  /** The open vault's folder. */
  root: string | null;
  onOpenVault: () => void;
};

/** Settings › General: the vault, the editor's text size, and optional tools. */
export function GeneralSettings({ root, onOpenVault }: Props) {
  const size = useTextSize();
  return (
    <Page title="General">
      <Group>
        <Row label="Vault" note={root && <span className="ki-data">{root}</span>}>
          <Button size="sm" variant="outline" className="relative" onClick={onOpenVault}>
            Open another…<ShortcutHint id="openVault" side="end" />
          </Button>
        </Row>
      </Group>
      <Group title="Writing">
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
      </Group>
      <OptionalTools />
    </Page>
  );
}
