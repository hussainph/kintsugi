// Nothing here may be reported.
import { useState } from 'react';
import { Kbd } from './kbd';

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return <span className={cn('ml-auto text-xs tracking-widest', className)} {...props} />;
}

export function Clean({ kind }: { kind: string }) {
  const [state] = useState('idle');
  const label = kind.toUpperCase(); // a method, not a style
  const sql = 'SELECT id FROM clips WHERE seam IS NULL AND gold IS NOT NULL';
  if (kind === 'GOLD SEAM') return null; // comparisons are code
  const color = { gold: '#c9a227', backgroundColor: 'gold' };
  return (
    <div className="text-xl font-medium tracking-tight" data-state={state}>
      <h1>Inspiration</h1>
      <p>3 new posts</p>
      <p>Nothing saved yet. Share a link from Safari to add one.</p>
      <p>Kin couldn’t reach your Mac. It’ll send when the Mac is back.</p>
      <p>Export as PDF, HTML or MDX via the API URL.</p>
      <kbd className="tracking-wide">⌘K</kbd>
      <Kbd className="tracking-widest">⇧⌘P</Kbd>
      <CommandShortcut>⌘J</CommandShortcut>
      <p style={{ letterSpacing: -0.2 }}>Tight heading</p>
      <p style={{ letterSpacing: 'normal' }}>Normal</p>
      <p>Mending with gold.</p> {/* copy-lint-allow: fixture shows the escape hatch */}
      <p>{label}{sql}{color.gold}</p>
    </div>
  );
}
