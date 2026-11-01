import { ArrowLeft, BookOpen, Paperclip, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { parseIsbn, isbnUrl } from "@kintsugi/core/books";
import { Button } from "@kintsugi/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@kintsugi/ui/components/dialog";
import { Input } from "@kintsugi/ui/components/input";
import { Textarea } from "@kintsugi/ui/components/textarea";
import type { DesktopClipCapture } from "@kintsugi/core/clips";
import { clips, type BookHit } from "./api";
import { anyFileCapture, bookByline, bookCapture, FILE_ACCEPT, fileFields, textCapture } from "./capture";

type Capture = (value: DesktopClipCapture) => Promise<string>;

export function CaptureDialog({ open, onClose, capture }: { open: boolean; onClose: () => void; capture: Capture }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File>();
  const [saving, setSaving] = useState(false);
  const [books, setBooks] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const close = () => { setBooks(false); onClose(); };
  const save = async () => {
    const value = textCapture(text);
    if (!value && !file) return;
    setSaving(true);
    try {
      const attached = file ? await anyFileCapture(file) : undefined;
      await capture({ ...(value ?? attached!), ...(attached ? fileFields(attached) : {}) });
      setText("");
      setFile(undefined);
      close();
    } catch (e) { toast.error(String(e)); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) close(); }}>
      <DialogContent className="sm:max-w-md motion-reduce:animate-none">
        <DialogHeader>
          <DialogTitle>{books ? "Keep a book" : "Keep a little inspiration"}</DialogTitle>
          <DialogDescription>{books ? "Find it by title, author or ISBN." : "A link, a passage, an image, a PDF, or a thought of your own."}</DialogDescription>
        </DialogHeader>
        {books ? <BookSearch saving={saving} setSaving={setSaving} capture={capture} onSaved={close} onBack={() => setBooks(false)} /> : <>
          <Textarea autoFocus aria-label="URL or text to capture" placeholder="What would you like to keep?" className="min-h-36 resize-y select-text" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
            if (e.metaKey && e.key === "Enter") { e.preventDefault(); void save(); }
          }} />
          <div className="flex items-center justify-between gap-3">
            <input ref={picker} type="file" accept={FILE_ACCEPT} className="hidden" aria-label="Choose an image, PDF or EPUB" onChange={(e) => setFile(e.target.files?.[0])} />
            <div className="flex min-w-0 items-center">
              <Button variant="ghost" onClick={() => picker.current?.click()} className="min-w-0 text-muted-foreground" title="An image, a PDF or an EPUB"><Paperclip /><span className="truncate">{file?.name ?? "Add a file"}</span></Button>
              {!file && <Button variant="ghost" onClick={() => setBooks(true)} className="text-muted-foreground"><BookOpen />Find a book</Button>}
            </div>
            <Button disabled={saving || (!text.trim() && !file)} onClick={save}>{saving ? "Saving…" : "Keep it"}</Button>
          </div>
        </>}
      </DialogContent>
    </Dialog>
  );
}

type Results = { query: string; hits: BookHit[]; error?: string };

function BookSearch({ saving, setSaving, capture, onSaved, onBack }: { saving: boolean; setSaving: (saving: boolean) => void; capture: Capture; onSaved: () => void; onBack: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results>();
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);
  const term = query.trim();
  const isbn = parseIsbn(term);

  const search = (value: string) => {
    const current = ++seq.current;
    if (value.length < 2) { setResults(undefined); setSearching(false); return; }
    setSearching(true);
    clips.bookSearch(value)
      .then((hits) => { if (current === seq.current) setResults({ query: value, hits }); })
      .catch((e) => { if (current === seq.current) setResults({ query: value, hits: [], error: String(e) }); })
      .finally(() => { if (current === seq.current) setSearching(false); });
  };
  // Open Library is rate limited: wait for a pause in typing.
  useEffect(() => {
    const timer = window.setTimeout(() => search(term), 450);
    return () => window.clearTimeout(timer);
  }, [term]);
  useEffect(() => () => { seq.current++; }, []);

  const keep = async (value: DesktopClipCapture) => {
    setSaving(true);
    try { await capture(value); onSaved(); }
    catch (e) { toast.error(String(e)); }
    finally { setSaving(false); }
  };
  const hits = results?.query === term ? results.hits : results?.hits ?? [];
  const showIsbn = isbn && !hits.some((hit) => hit.isbn === isbn);

  return <>
    <div className="relative">
      <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground/60" />
      <Input autoFocus type="search" aria-label="Book title, author or ISBN" placeholder="The Left Hand of Darkness, or an ISBN" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
        if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
        e.preventDefault();
        if (isbn && !hits.length) void keep(bookCapture({ url: isbnUrl(isbn) }));
        else search(term);
      }} className="border-0 bg-muted/60 pl-9 shadow-none select-text focus-visible:ring-1" />
    </div>
    <div className="-mx-2 max-h-80 min-h-24 overflow-y-auto" aria-busy={searching}>
      <ul aria-label="Books" className="space-y-0.5">
        {showIsbn && <li><button type="button" disabled={saving} onClick={() => void keep(bookCapture({ url: isbnUrl(isbn) }))} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50">
          <Cover />
          <span className="min-w-0"><span className="block truncate text-sm">Keep ISBN {isbn}</span><span className="block truncate text-xs text-muted-foreground">Details arrive from Open Library</span></span>
        </button></li>}
        {hits.map((hit) => <li key={hit.key}><button type="button" disabled={saving} onClick={() => void keep(bookCapture(hit))} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50">
          <Cover url={hit.coverUrl} />
          <span className="min-w-0"><span className="line-clamp-2 text-sm leading-snug">{hit.title}</span><span className="block truncate text-xs text-muted-foreground">{bookByline(hit) || "Unknown author"}</span></span>
        </button></li>)}
      </ul>
      <p role="status" className="px-2 py-3 text-xs text-muted-foreground">{
        searching ? "Looking…"
          : results?.error ? results.error
          : results && results.query === term && !hits.length ? (isbn ? "Not in the catalog yet, but you can keep the ISBN." : "No books found. Try fewer words, or an ISBN.")
          : !term ? "From Open Library. Choose a book to keep it." : ""
      }</p>
    </div>
    <div className="flex items-center justify-between gap-3">
      <Button variant="ghost" onClick={onBack} disabled={saving} className="-ml-2 text-muted-foreground"><ArrowLeft />Something else</Button>
      {saving && <span className="text-xs text-muted-foreground" role="status">Saving…</span>}
    </div>
  </>;
}

/** Remote covers load directly; a missing or broken cover falls back quietly. */
function Cover({ url }: { url?: string | null }) {
  const [failed, setFailed] = useState(false);
  return <span className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted/70">
    {url && !failed ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-cover" /> : <BookOpen className="size-4 stroke-1 text-muted-foreground/60" />}
  </span>;
}
