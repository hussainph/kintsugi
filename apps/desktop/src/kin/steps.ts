import { BookOpen, Brain, Compass, FolderOpen, Globe, Search, Sparkles, type IconComponent } from "@kintsugi/ui/icons";
import { domain } from "@/lib/web";

/** A tool call as the chat shows it: what Kin did, in a few words. */
export type StepView = { label: string; icon: IconComponent };

const quoted = (text: unknown) => `“${String(text ?? "").trim()}”`;

/** "Searched “kiln”", "Read drafts/x.md": what Kin is doing, briefly. */
export function describeStep(name: string, args: unknown): StepView {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "search":
      return { label: `Searched ${quoted(a.query)}`, icon: Search };
    case "read":
      return { label: String(a.path ?? "").startsWith("@out/") ? "Read more of a result" : `Read ${String(a.path ?? "a file")}`, icon: BookOpen };
    case "list":
      return { label: `Looked in ${String(a.path || "the vault")}`, icon: FolderOpen };
    case "web_search":
      return { label: `Searched the web for ${quoted(a.query)}`, icon: Globe };
    case "web_fetch":
      return { label: `Read ${domain(String(a.url ?? "")) ?? "a web page"}`, icon: Globe };
    case "memory":
      return { label: "Updated its notes", icon: Brain };
    case "skill":
      return { label: a.name ? `Used the ${String(a.name)} skill` : "Used a skill", icon: Sparkles };
    case "tool": {
      const inner = (a.args ?? {}) as Record<string, unknown>;
      if (a.name === "history") return { label: inner.query ? `Searched our history for ${quoted(inner.query)}` : "Read our history", icon: Search };
      if (a.name === "shortlist" || a.name === "similar_to" || a.name === "top_topics" || a.name === "taste_profile" || a.name === "explain")
        return { label: "Ranked the Feed", icon: Compass };
      if (a.name === "outline") return { label: `Outlined ${String(inner.path ?? "a document")}`, icon: BookOpen };
      if (a.name === "recent") return { label: "Listed recent documents", icon: FolderOpen };
      return { label: `Used ${String(a.name ?? "a tool")}`, icon: Sparkles };
    }
    default:
      return { label: `Used ${name}`, icon: Sparkles };
  }
}

/** "2.4s", "12s", "1m 5s". */
export function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${Math.max(0.1, Math.round(s * 10) / 10)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** The folded steps' one line: "3 steps · 6s", or "Thought for 4s" with none. */
export function stepsSummary(steps: number, ms: number | undefined): string | null {
  const took = ms !== undefined ? duration(ms) : null;
  if (!steps) return took && ms! >= 2000 ? `Thought for ${took}` : null;
  return [`${steps} step${steps === 1 ? "" : "s"}`, took].filter(Boolean).join(" · ");
}

/** A provider that stopped answering, as the wire layer words it. */
export const isTimeout = (error: string) => /stopped responding|timed? ?out/i.test(error);

/** "$0.004", "$0.12"; nothing for a free reply. */
export function cost(usd: number | undefined): string | null {
  if (!usd) return null;
  if (usd < 0.001) return "<$0.001";
  return `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

/** The model's id, without its provider: "kimi-k3". */
export const modelShort = (model: string | undefined) => (model ? model.slice(model.indexOf("/") + 1) : null);
