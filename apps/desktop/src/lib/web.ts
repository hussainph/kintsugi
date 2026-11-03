import { invoke } from "@tauri-apps/api/core";

/** Mirrors `ai::web::Provider`. */
export type WebProvider = "exa" | "brave" | "tavily";

/** Mirrors `ai::web::View`. Holds no key: keys never leave Rust. */
export type WebSettings = {
  enabled: boolean;
  /** His pick, if any. */
  provider: WebProvider | null;
  /** What `web_search` uses now. */
  active: WebProvider | null;
  providers: { id: WebProvider; name: string; key: "settings" | "environment" | null }[];
};

/** Mirrors `ai::web::Source`: one search result or a page Kin read. */
export type WebSource = { url: string; title: string; snippet?: string; date?: string; favicon?: string };

/** Mirrors `ai::web::WebCall`: a web search or page read that worked. */
export type WebCall = { tool: "search" | "fetch"; query?: string; provider?: string; results: WebSource[] };

export const web = {
  settings: () => invoke<WebSettings>("web_settings"),
  setEnabled: (enabled: boolean) => invoke<WebSettings>("web_set_enabled", { enabled }),
  setProvider: (provider: WebProvider | null) => invoke<WebSettings>("web_set_provider", { provider }),
  /** An empty or null key removes the saved one. */
  setKey: (provider: WebProvider, key: string | null) => invoke<WebSettings>("web_set_key", { provider, key }),
};

/** Where each provider hands out keys. */
export const KEY_PAGES: Record<WebProvider, string> = {
  exa: "https://dashboard.exa.ai/api-keys",
  brave: "https://api-dashboard.search.brave.com/app/keys",
  tavily: "https://app.tavily.com/home",
};

/** "en.wikipedia.org" → "wikipedia.org"; null for a URL that doesn't parse. */
export function domain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** A Markdown link for the document: `[Title](url)`, brackets escaped. */
export function markdownLink(source: Pick<WebSource, "url" | "title">): string {
  const title = (source.title || domain(source.url) || source.url).replace(/[[\]\\]/g, (c) => `\\${c}`).replace(/\s+/g, " ").trim();
  const url = source.url.replace(/[()\s]/g, (c) => (c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c)));
  return `[${title}](${url})`;
}

/** The results worth showing once: pages read first, then search results, each URL once. */
export function sourcesOf(calls: WebCall[]): WebSource[] {
  const seen = new Set<string>();
  const out: WebSource[] = [];
  for (const call of [...calls.filter((c) => c.tool === "fetch"), ...calls.filter((c) => c.tool === "search")]) {
    for (const result of call.results) {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      out.push(result);
    }
  }
  return out;
}
