import { useReferenceIndex } from "./useReferenceIndex";

/** Library detail and document backlinks share the writing margin's index. */
export function UsedIn({ root, path, onOpen }: {
  root: string | null;
  path: string;
  onOpen: (path: string) => void;
}) {
  const index = useReferenceIndex(root);
  const paths = new Set(index.links.filter((link) => link.resolved === path).map((link) => link.source));
  const documents = index.documents.filter((document) => paths.has(document.path));
  return (
    <section className="space-y-2" aria-label="Used in">
      <h3 className="text-xs font-medium text-muted-foreground">Used in</h3>
      {documents.map((document) => (
        <button key={document.path} onClick={() => onOpen(document.path)} className="block max-w-full truncate text-left text-sm hover:text-primary">
          {document.title || document.path.replace(/^.*\//, "").replace(/\.mdx?$/, "")}
        </button>
      ))}
      {!documents.length && <p className="text-xs text-muted-foreground">{index.loading ? "Finding references…" : index.error ? "References unavailable." : "Not referenced yet."}</p>}
    </section>
  );
}
