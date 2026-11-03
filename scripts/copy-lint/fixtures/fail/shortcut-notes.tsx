// Notes carry facts, not keys (docs/voice.md › Let the components do the talking).
import { Shortcut, ShortcutHint } from './Shortcuts';

export function Settings() {
  return (
    <div>
      <Row label="Text size" note={<><Shortcut id="textSmaller" /> <Shortcut id="textLarger" /> while writing, <Shortcut id="textReset" /> to reset</>}> {/* expect: shortcut-note */}
        <Stepper />
      </Row>
      <Row label="“Written by a human” statement" note="Text you accept from ⌘K is written by AI."> {/* expect: shortcut-note */}
        <Switch />
      </Row>
      <Row label="Kin" note={<ShortcutHint keys="⌘↩" />}> {/* expect: shortcut-note */}
        <Switch />
      </Row>
      <Row label="Vault" note={<span className="ki-data">⌘O opens another folder</span>}> {/* expect: shortcut-note */}
        <Button>Open another…</Button>
      </Row>
      <span className="ki-settings-note">Press ⌘, for Settings.</span> {/* expect: shortcut-note */}
      <Row label="Monthly cap" note="US dollars. Subscriptions count as $0.">
        <Stepper />
      </Row>
      <Row label="Vault" note={<span className="ki-data">~/Notes</span>}>
        <Button>Open another…<ShortcutHint id="openVault" side="end" /></Button>
      </Row>
    </div>
  );
}

function Row(_: { label: string; note?: React.ReactNode; children?: React.ReactNode }) { return null; }
function Stepper() { return null; }
function Switch() { return null; }
function Button(_: { children?: React.ReactNode }) { return null; }
