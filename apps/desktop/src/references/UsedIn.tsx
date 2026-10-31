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
    <section className="ki-stack-xs" aria-label="Used in">
      <h3 className="ki-text-s ki-medium">Used in</h3>
      {documents.map((document) => (
        <button key={document.path} onClick={() => onOpen(document.path)} className="ki-used-in-link ki-text-s block max-w-full truncate rounded-(--radius-xs) text-left hover:underline">
          {document.title || document.path.replace(/^.*\//, "").replace(/\.mdx?$/, "")}
        </button>
      ))}
      {!documents.length && <p className={`ki-text-xs ${index.error ? "ki-error" : "ki-muted"}`} role={index.error ? "alert" : "status"}>{index.loading ? "Finding references…" : index.error ? "References unavailable." : "Not referenced yet."}</p>}
    </section>
  );
}
