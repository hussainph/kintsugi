import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { Input } from "@kintsugi/ui/components/input";
import { blog, importSummary, type BlogStatus } from "@/lib/blog";

/** Settings → Blog: where the blog repository is, and importing its posts
 *  into the vault (a read-only mirror). Provenance lives in Settings → Export. */
export function BlogSettings() {
  const [status, setStatus] = useState<BlogStatus | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    blog.status().then((s) => { setStatus(s); setPath(s.path ?? ""); }).catch((e) => toast.error(String(e)));
  }, []);

  const save = async (next: string) => {
    setBusy(true);
    try {
      const s = await blog.configure({ path: next });
      setStatus(s);
      setPath(s.path ?? "");
      if (s.path && !s.error) toast(importSummary(await blog.import()));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const choose = async () => {
    const picked = await pickFolder({ directory: true, title: "Choose the blog repository" });
    if (typeof picked === "string") await save(picked);
  };

  const importNow = async () => {
    setBusy(true);
    try {
      toast(importSummary(await blog.import()));
      setStatus(await blog.status());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 text-sm" aria-labelledby="blog-settings">
      <h3 id="blog-settings" className="font-medium">Blog</h3>
      <div className="flex items-center gap-2">
        <Input
          className="h-8 font-mono text-xs"
          placeholder="~/Desktop/code/3d-portfolio"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save(path)}
          aria-label="Blog repository folder"
        />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => save(path)}>Save</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={choose}>Choose…</Button>
      </div>
      {status?.error ? (
        <p className="text-destructive" data-testid="blog-status">{status.error}</p>
      ) : status?.path ? (
        <p className="text-muted-foreground" data-testid="blog-status">
          {status.site.replace(/^https?:\/\//, "")} · {status.posts ?? 0} post{status.posts === 1 ? "" : "s"}, mirrored read-only in <code>{status.folder}/</code> so [[links]] and @ reach them.
        </p>
      ) : (
        <p className="text-muted-foreground" data-testid="blog-status">
          The repository Publish writes into. You commit and push; Kintsugi never does.
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">The sources appendix and the “written by a human” statement are under Export.</p>
        <Button size="sm" variant="ghost" disabled={busy || !status?.path || !!status.error} onClick={importNow}>Import posts now</Button>
      </div>
    </section>
  );
}
