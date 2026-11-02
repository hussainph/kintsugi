import { toast } from 'sonner';
export function Library({ empty }: { empty: boolean }) {
  const subtitle = 'A sanctuary for your thoughts.'; // expect: tone-word
  if (empty) toast('Saved. Breathe.'); // expect: tone-word
  return (
    <div>
      <h1>Inspiration</h1>
      <p>Your library is quietly waiting.</p> {/* expect: tone-word */}
      <p>ABOUT THIS NOTE</p> {/* expect: all-caps */}
      <p>Not saved — try again</p> {/* expect: em-dash */}
      <button title="Leverage your clips">Save</button> {/* expect: slop-word */}
      <input placeholder="Sit with a passage…" /> {/* expect: tone-word */}
      <p aria-label="Kin isn't a search box, it's a friend">Kin</p> {/* expect: binary-contrast */}
      <p>{empty ? 'Not just a list.' : 'Saved'}</p> {/* expect: binary-contrast */}
      <p>The best part: it learns.</p> {/* expect: colon-reveal */}
      <p>Mending with gold, along the seams.</p> {/* expect: tone-word tone-word */}
      <p>{subtitle}</p>
      <p>Saved.</p> {/* copy-lint-allow */} {/* expect: allow-reason */}
    </div>
  );
}
