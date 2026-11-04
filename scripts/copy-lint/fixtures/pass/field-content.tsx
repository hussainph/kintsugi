// Content, live state, and screen-reader text are not field explainers.
export function Sources({ title, author, status }: { title: string; author: string; status: string }) {
  return (
    <div>
      <Input aria-label="Feed URL" />
      <p className="sr-only text-xs text-muted-foreground">Feed URL</p>
      <p role="status" className="text-xs text-muted-foreground">{status}</p>
      <Button>Find again</Button>
      <p role="status" className="text-xs text-muted-foreground">Fetching…</p>
      <Input aria-label="Draft title" />
      <p className="text-xs text-muted-foreground">The body starts empty. {title} goes in the frontmatter.</p>
      <ul>
        <li>
          <p className="text-sm">{title}</p>
          <p className="text-xs text-muted-foreground">{author}</p>
        </li>
      </ul>
      <h2>Feed</h2>
      <p className="text-xs text-muted-foreground">Items expire after 30 days.</p> {/* copy-lint-allow: a retention limit the UI can't show */}
      <p>Not following anything yet.</p>
      <section>
        <p className="text-xs text-muted-foreground">Feed URL</p>
        <Input aria-label="Feed URL" />
      </section>
      <div>
        <p>Source</p>
        <p className="text-xs text-muted-foreground">Ada Writer</p>
      </div>
    </div>
  );
}
