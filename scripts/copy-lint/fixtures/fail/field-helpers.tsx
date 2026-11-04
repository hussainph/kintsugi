// Following's conditional field helpers must not slip past the copy lint.
export function Following({ tab }: { tab: string }) {
  return (
    <form>
      {tab === 'hn' ? (
        <div>
          <div><Input aria-label="Minimum points" /><Button>Follow</Button></div>
          <p className="text-xs text-muted-foreground">Through hnrss.org.</p> {/* expect: over-explaining */}
        </div>
      ) : (
        <div className="flex gap-2">
          <Input aria-label="Feed URL" />
          <Button>Follow</Button>
        </div>
      )}
      {tab === 'url' && <p className="text-xs text-muted-foreground">RSS, Atom, JSON Feed, or a page that links to one.</p>} {/* expect: over-explaining */}
      {tab === 'youtube' && (<p className="text-xs text-muted-foreground">YouTube’s feeds sometimes stall; Kintsugi keeps trying.</p>)} {/* expect: over-explaining */}
      {tab === 'x' ? <p className="text-sm text-muted-foreground">Through FxTwitter, best-effort. No X account needed.</p> : null} {/* expect: over-explaining */}
    </form>
  );
}

export function Field() {
  return (
    <div>
      <Input aria-label="Feed URL" />
      <p className="text-sm text-muted-foreground">A blog or feed link.</p> {/* expect: over-explaining */}
    </div>
  );
}
