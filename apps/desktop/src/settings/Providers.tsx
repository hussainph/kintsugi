import { openUrl } from "@tauri-apps/plugin-opener";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@kintsugi/ui/components/button";
import { Input } from "@kintsugi/ui/components/input";
import { SelectField } from "@kintsugi/ui/graphical";
import { credentialLabel, credentials, shown, type CredentialView, type SignInEvent } from "@/lib/ai";
import { Group, Page, Row } from "./parts";

const PROBLEM: CredentialView["auth"][] = ["unsupported_login", "expired_login"];

type Prompt = Extract<SignInEvent, { type: "prompt" }>;

/** A sign-in under way, as its events have shown it so far. */
type Flow = {
  provider: string;
  id: string | null;
  prompt: Prompt | null;
  page: string | null;
  device: { userCode: string; verificationUri: string } | null;
  progress: string | null;
};

/** OpenCode's or Pi's credential, which comes before anything saved here. */
const fromElsewhere = (p: CredentialView) => (p.source === "opencode" || p.source === "pi") && (p.auth === "api_key" || p.auth === "login");

const open = (url: string) => void openUrl(url).catch((e) => toast.error(String(e)));

/** The host and path of a sign-in page, for reading out. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/** Settings › Providers: where each provider's credential comes from, and
 *  Kintsugi's own keys and sign-ins. Keys go to Rust and are never read back. */
export function ProviderSettings() {
  const [list, setList] = useState<CredentialView[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<Flow | null>(null);
  const flowId = useRef<string | null>(null);
  /** The sign-in this page is following; events from any other are dropped. */
  const current = useRef<object | null>(null);

  const reload = useCallback(() => credentials.list().then(setList).catch((e) => toast.error(String(e))), []);

  useEffect(() => {
    void reload();
    // Leaving Settings ends a sign-in in progress.
    return () => {
      current.current = null;
      if (flowId.current) void credentials.cancel(flowId.current);
    };
  }, [reload]);

  const run = async (action: () => Promise<CredentialView[]>, done: string) => {
    setBusy(true);
    try {
      setList(await action());
      toast(done);
      return true;
    } catch (e) {
      toast.error(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async (p: CredentialView) => {
    const key = draft.trim();
    if (!key) return;
    if (await run(() => credentials.setKey(p.id, key), "Key saved.")) {
      setDraft("");
      setEditing(null);
    }
  };

  const onEvent = (provider: CredentialView, token: object) => (event: SignInEvent) => {
    if (current.current !== token) return;
    if (event.type === "done" || event.type === "failed") {
      current.current = null;
      flowId.current = null;
      setFlow(null);
      setAnswer("");
      if (event.type === "done") toast(`Signed in to ${provider.name}.`);
      else toast.error(event.message);
      void reload();
      return;
    }
    if (event.type === "auth_url" && event.open) open(event.url);
    setFlow((f) => {
      if (!f || f.provider !== provider.id) return f;
      switch (event.type) {
        case "prompt":
          return { ...f, prompt: event };
        case "auth_url":
          return { ...f, page: event.url };
        case "device_code":
          return { ...f, device: { userCode: event.userCode, verificationUri: event.verificationUri } };
        case "progress":
          // Past the browser: nothing left to paste.
          return { ...f, progress: event.message, prompt: f.prompt?.kind === "paste" ? null : f.prompt };
        default:
          return f;
      }
    });
  };

  const signIn = async (p: CredentialView) => {
    setEditing(null);
    setAnswer("");
    setFlow({ provider: p.id, id: null, prompt: null, page: null, device: null, progress: null });
    const token = {};
    current.current = token;
    flowId.current = null;
    try {
      const id = await credentials.signIn(p.id, onEvent(p, token));
      // Cancelled while it was starting: stop it now.
      if (current.current !== token) return void credentials.cancel(id);
      flowId.current = id;
      setFlow((f) => (f && f.provider === p.id ? { ...f, id } : f));
    } catch (e) {
      if (current.current !== token) return;
      current.current = null;
      setFlow(null);
      toast.error(String(e));
    }
  };

  const cancel = () => {
    current.current = null;
    if (flowId.current) void credentials.cancel(flowId.current);
    flowId.current = null;
    setFlow(null);
    setAnswer("");
  };

  const reply = async (value: string) => {
    if (!flow?.id || !flow.prompt) return;
    const prompt = flow.prompt;
    setFlow({ ...flow, prompt: null });
    setAnswer("");
    try {
      await credentials.answer(flow.id, prompt.id, value);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const visible = list?.filter(shown) ?? [];
  const rows = visible.filter((p) => p.listed || picked.includes(p.id));
  const others = visible.filter((p) => !p.listed && !picked.includes(p.id));

  return (
    <Page title="Providers">
      <Group data-testid="credentials" aria-busy={busy}>
        {rows.map((p) => {
          const inFlow = flow?.provider === p.id;
          const shadowed = fromElsewhere(p);
          return (
            <Fragment key={p.id}>
              <Row
                label={p.name}
                note={inFlow ? "Signing in…" : <span className={PROBLEM.includes(p.auth) ? "ki-error" : undefined}>{credentialLabel(p)}</span>}
                data-provider={p.id}
                htmlFor={editing === p.id ? `key-${p.id}` : undefined}
                className={editing === p.id ? "ki-settings-row-wide" : undefined}
              >
                <div className="ki-settings-inline">
                  {editing === p.id ? (
                    <>
                      <Input
                        id={`key-${p.id}`}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus
                        className="ki-data"
                        placeholder="API key"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveKey(p);
                          if (e.key === "Escape") {
                            e.stopPropagation();
                            setEditing(null);
                          }
                        }}
                        aria-label={`${p.name} API key`}
                      />
                      <Button size="sm" variant="outline" disabled={busy || !draft.trim()} onClick={() => void saveKey(p)}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : inFlow ? null : (
                    <>
                      {p.saved && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => credentials.remove(p.id), p.saved === "oauth" ? "Signed out." : "Key removed.")}>
                          {p.saved === "oauth" ? "Sign out" : "Remove key"}
                        </Button>
                      )}
                      {!shadowed && p.apiKey && p.saved !== "oauth" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !!flow}
                          onClick={() => {
                            setDraft("");
                            setEditing(p.id);
                          }}
                        >
                          {p.saved === "api_key" ? "Replace key" : "Add key"}
                        </Button>
                      )}
                      {!shadowed && p.signIn && !p.saved && (
                        <Button size="sm" disabled={busy || !!flow} onClick={() => void signIn(p)}>
                          Sign in
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </Row>
              {inFlow && flow && <SignInPanel flow={flow} name={p.name} answer={answer} setAnswer={setAnswer} onReply={(v) => void reply(v)} onCancel={cancel} />}
            </Fragment>
          );
        })}
      </Group>
      {others.length > 0 && (
        <Group data-testid="add-provider">
          <Row label="Add a provider" className="[&_.field-label]:sr-only">
            <SelectField<string>
              key={picked.length}
              label="Add a provider"
              placeholder="Choose"
              value={undefined}
              onValueChange={(id) => id && setPicked((list) => [...list, id])}
              options={others.map((p) => ({ value: p.id, label: p.name }))}
            />
          </Row>
        </Group>
      )}
    </Page>
  );
}

type PanelProps = {
  flow: Flow;
  name: string;
  answer: string;
  setAnswer: (value: string) => void;
  onReply: (value: string) => void;
  onCancel: () => void;
};

/** One sign-in in progress: what it asks, the code to enter, the page to finish on. */
function SignInPanel({ flow, name, answer, setAnswer, onReply, onCancel }: PanelProps) {
  const { prompt, device, page, progress } = flow;
  const copy = async (code: string) => {
    await navigator.clipboard.writeText(code);
    toast("Code copied.");
  };

  const input = prompt?.kind === "text" || prompt?.kind === "paste";
  const submit = () => {
    const value = prompt?.kind === "paste" ? answer.trim() : answer;
    if (prompt?.kind !== "paste" || value) onReply(value);
  };

  return (
    <div className="ki-settings-row ki-settings-row-wide" data-testid="sign-in" data-sign-in={flow.provider} aria-live="polite">
      <div className="ki-settings-label">
        {prompt?.kind === "select" && <span className="ki-text-s">{prompt.message}</span>}
        {device && (
          <span className="ki-settings-inline">
            <span className="ki-data ki-device-code" data-testid="device-code">
              {device.userCode}
            </span>
            <span className="ki-muted ki-text-s">at {shortUrl(device.verificationUri)}</span>
          </span>
        )}
        {page && !device && <span className="ki-text-s">Finish signing in to {name} in your browser.</span>}
        {progress && <span className="ki-settings-note">{progress}</span>}
        {!prompt && !device && !page && !progress && <span className="ki-muted ki-text-s">Starting…</span>}
      </div>
      <div className="ki-sign-in-actions">
        {prompt?.kind === "select" &&
          prompt.options?.map((o) => (
            <Button key={o.id} size="sm" variant="outline" onClick={() => onReply(o.id)}>
              {o.label}
            </Button>
          ))}
        {device && (
          <Button size="sm" variant="ghost" onClick={() => void copy(device.userCode)}>
            Copy code
          </Button>
        )}
        {(device || page) && (
          <Button size="sm" variant="outline" onClick={() => open(device?.verificationUri ?? page!)}>
            Open page
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {input && prompt && (
        <div className="ki-settings-inline ki-sign-in-input">
          <Input
            autoFocus
            spellCheck={false}
            className="ki-data"
            placeholder={prompt.kind === "paste" ? prompt.message : prompt.placeholder}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            aria-label={prompt.message}
          />
          <Button size="sm" variant="outline" disabled={prompt.kind === "paste" && !answer.trim()} onClick={submit}>
            Continue
          </Button>
        </div>
      )}
    </div>
  );
}
