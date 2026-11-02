import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { Input } from "@kintsugi/ui/components/input";
import { blog, importSummary, type BlogStatus } from "@/lib/blog";
import { Group, Page, Row } from "./parts";

/** Settings › Blog: where the blog repository is, and importing its posts
 *  into the vault (a read-only mirror). Provenance lives in Settings › Export. */
export function BlogSettings() {
  const [status, setStatus] = useState<BlogStatus | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  // Typed (or saved) before the stored path arrived: keep his, not the stored one (KI-47).
  const edited = useRef(false);
  // Only the latest status lands: a save made before the first load answers must win.
  const latest = useRef(0);

  useEffect(() => {
    const ticket = ++latest.current;
    blog
      .status()
      .then((s) => {
        if (ticket !== latest.current) return;
        setStatus(s);
        if (!edited.current) setPath(s.path ?? "");
      })
      .catch((e) => toast.error(String(e)));
  }, []);

  const save = async (next: string) => {
    setBusy(true);
    edited.current = true;
    ++latest.current;
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
      ++latest.current;
      setStatus(await blog.status());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const status_ = status?.error ? (
    <span className="ki-error" data-testid="blog-status">{status.error}</span>
  ) : status?.path ? (
    <span data-testid="blog-status">
      {status.site.replace(/^https?:\/\//, "")} · {status.posts ?? 0} post{status.posts === 1 ? "" : "s"}, mirrored read-only in <code className="ki-data">{status.folder}/</code>
    </span>
  ) : (
    <span data-testid="blog-status">You commit and push; Kintsugi never does.</span>
  );

  return (
    <Page title="Blog">
      <Group aria-labelledby="blog-settings">
        <Row label={<span id="blog-settings">Repository</span>} note={status_} className="ki-settings-row-wide">
          <div className="ki-settings-inline">
            <Input
              className="ki-data"
              placeholder="~/Desktop/code/3d-portfolio"
              value={path}
              onChange={(e) => {
                edited.current = true;
                setPath(e.target.value);
              }}
              onKeyDown={(e) => e.key === "Enter" && save(path)}
              aria-label="Blog repository folder"
            />
            <Button size="sm" variant="outline" disabled={busy} onClick={() => save(path)}>Save</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={choose}>Choose…</Button>
          </div>
        </Row>
        <Row label="Posts">
          <Button size="sm" variant="outline" disabled={busy || !status?.path || !!status.error} onClick={importNow}>Import now</Button>
        </Row>
      </Group>
    </Page>
  );
}
