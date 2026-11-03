import { Button } from "@kintsugi/ui/components/button";
import { Group, Page, Row } from "./parts";
import { OptionalTools } from "./OptionalTools";
import { ShortcutHint } from "@/components/Shortcuts";

type Props = {
  /** The open vault's folder. */
  root: string | null;
  onOpenVault: () => void;
};

/** Settings › General: the vault and optional tools. */
export function GeneralSettings({ root, onOpenVault }: Props) {
  return (
    <Page title="General">
      <Group>
        <Row label="Vault" note={root && <span className="ki-data">{root}</span>}>
          <Button size="sm" variant="outline" className="relative" onClick={onOpenVault}>
            Open another…<ShortcutHint id="openVault" side="end" />
          </Button>
        </Row>
      </Group>
      <OptionalTools />
    </Page>
  );
}
