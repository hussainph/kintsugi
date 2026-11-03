// Keys live in the chips and the ⇧⌘/ list, so a note can carry a fact and a
// chip can sit beside a control. Nothing here may be reported.
import { ShortcutHint } from './Shortcuts';

export function Settings() {
  return (
    <div>
      <Row label="Text size">
        <Stepper />
      </Row>
      <Row label="Monthly cap" note="US dollars. Subscriptions count as $0.">
        <Stepper />
      </Row>
      <Row label="Phone access" note="Over Tailscale, while this Mac is awake and Kintsugi is open.">
        <Switch />
      </Row>
      <Row label="Vault" note={<span className="ki-data">~/Notes</span>}>
        <Button>Open another…<ShortcutHint id="openVault" side="end" /></Button>
      </Row>
      <Row label="Exa" note="From EXA_API_KEY">
        <Button>Save</Button>
      </Row>
      <dl>
        <dt>Open another folder</dt>
        <dd><Kbd>⌘O</Kbd></dd>
      </dl>
      <kbd className="tracking-wide">⌘K</kbd>
    </div>
  );
}

function Row(_: { label: string; note?: React.ReactNode; children?: React.ReactNode }) { return null; }
function Stepper() { return null; }
function Switch() { return null; }
function Button(_: { children?: React.ReactNode }) { return null; }
