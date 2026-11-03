import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppearancePanel } from '../../src/components/AppearancePanel';
import PhoneEditor from '../../src/components/editor/PhoneEditor';
import { useAppearance, useResolvedScheme } from '../../src/lib/appearance-store';
import { useTheme } from '../../src/theme';
import './runtime.css';

// Exact production components, not a screenshot reconstruction. Browser-only
// shell stands in for the native navigator, grabber and device KV transport.
function App() {
  const theme = useTheme();
  const { textSize } = useAppearance();
  const dark = useResolvedScheme() === 'dark';
  const editor = useRef(null);
  const fontScale = Number(new URLSearchParams(location.search).get('fontScale') ?? 1);
  const [open, setOpen] = useState(true);
  const [height, setHeight] = useState(520);
  const [text, setText] = useState('A note on the train\n\nThe paragraph stays in place while I change the text size.\n\n## A heading\n\nOne more line to read.');
  const [history, setHistory] = useState(false);
  const expanded = fontScale > 1.2;
  return (
    <div className="runtime-phone" style={{ background: theme.background, color: theme.text }}>
      <header><span>A note on the train</span><button onClick={() => { editor.current?.blur(); setOpen(true); }}>Appearance</button></header>
      <div className="runtime-editor">
        <PhoneEditor ref={editor} docKey="note" text={text} external={null} focus={0} dark={dark} textSize={textSize * fontScale} sources={[]}
          onText={async (_key, next) => setText(next)} onHistory={async (canUndo) => setHistory(canUndo)}
          onFlushed={async () => {}} onShown={async () => {}} onOpen={async () => {}} />
      </div>
      <output hidden data-testid="runtime-history">{String(history)}</output>
      {open && <>
        <div className="runtime-scrim" onClick={() => setOpen(false)} />
        <section className="runtime-sheet" aria-label="Appearance sheet" style={{ background: theme.surface, height: expanded ? '94%' : Math.min(innerHeight * 0.94, height) }}>
          <div className="runtime-grabber" style={{ background: theme.faint }} />
          <AppearancePanel expanded={expanded} onDone={() => setOpen(false)} onContentHeight={(height) => setHeight(Math.max(520, height + 114))} />
          <div className="runtime-home" style={{ background: theme.text }} />
        </section>
      </>}
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App />);
