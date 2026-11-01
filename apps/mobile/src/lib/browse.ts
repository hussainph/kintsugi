import { field } from '@kintsugi/core/frontmatter';
import { hasTags, normalTag, tags as tagsOf, vocabulary } from '@kintsugi/core/tags';

import { docTitle, type LocalDoc } from './library.ts';

/** Browsing the phone's copy of the writing: folders, and filters by status
 *  and tag. Everything is read from each document's own frontmatter, the
 *  same fields the Mac's sidebar reads; nothing here is ever required, and
 *  nothing writes. */

export type Status = 'draft' | 'complete';
export type Filter = { status: Status | null; tags: string[] };
export const NO_FILTER: Filter = { status: null, tags: [] };

export type Row = LocalDoc & { title: string; status: string | null; tags: string[] };
export type FolderRow = { path: string; name: string; count: number };

export const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const baseName = (path: string) => path.split('/').pop() ?? path;

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** What the list shows for a document. */
export function row(doc: LocalDoc): Row {
  return { ...doc, title: docTitle(doc), status: field(doc.text, 'status'), tags: tagsOf(doc.text) };
}

/** Whether `path` is inside `dir` (the vault root is `''`). */
export const within = (path: string, dir: string) => dir === '' || path.startsWith(dir + '/');

export const filtering = (filter: Filter) => filter.status !== null || filter.tags.length > 0;

/** A document passes when it has the status (if one is chosen), every chosen
 *  tag, and every word of the query in its title. */
export function matches(doc: Row, filter: Filter, query = ''): boolean {
  if (filter.status && doc.status !== filter.status) return false;
  if (!hasTags(doc.tags, filter.tags)) return false;
  const title = doc.title.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => !word || title.includes(word));
}

/** One folder, as a file browser shows it: the folders directly inside it
 *  that hold any writing (with how many documents, all the way down), then
 *  its own documents. The phone keeps documents, not folders, so a folder
 *  with nothing in it doesn't appear. */
export function folderView(rows: Row[], dir: string): { folders: FolderRow[]; docs: Row[] } {
  const folders = new Map<string, number>();
  const docs: Row[] = [];
  for (const doc of rows) {
    if (!within(doc.path, dir)) continue;
    const rest = dir ? doc.path.slice(dir.length + 1) : doc.path;
    const slash = rest.indexOf('/');
    if (slash === -1) docs.push(doc);
    else {
      const path = (dir ? dir + '/' : '') + rest.slice(0, slash);
      folders.set(path, (folders.get(path) ?? 0) + 1);
    }
  }
  return {
    folders: [...folders]
      .map(([path, count]) => ({ path, name: baseName(path), count }))
      .sort((a, b) => byName(a.name, b.name)),
    docs: docs.sort((a, b) => byName(baseName(a.path), baseName(b.path))),
  };
}

export type Section = { title: string; folder: string; data: Row[] };

/** Matching documents anywhere under `dir`, one section per folder, `dir`
 *  itself first: what the list shows while searching or filtering. */
export function matchingSections(rows: Row[], dir: string, filter: Filter, query: string, rootName: string): Section[] {
  const folders = new Map<string, Row[]>();
  for (const doc of rows) {
    if (!within(doc.path, dir) || !matches(doc, filter, query)) continue;
    const folder = folderOf(doc.path);
    folders.set(folder, [...(folders.get(folder) ?? []), doc]);
  }
  return [...folders]
    .sort(([a], [b]) => (a === dir ? -1 : b === dir ? 1 : byName(a, b)))
    .map(([folder, data]) => ({
      folder,
      title: folder === '' ? rootName : folder,
      data: data.sort((a, b) => byName(baseName(a.path), baseName(b.path))),
    }));
}

/** Tags in use under `dir`, most used first; chosen tags always stay listed
 *  so they can be let go. */
export function tagsUnder(rows: Row[], dir: string, chosen: string[] = []): string[] {
  const used = vocabulary(rows.filter((d) => within(d.path, dir)).map((d) => d.tags));
  return [...chosen.filter((t) => !used.includes(t)), ...used];
}

/** A filter from a link's query, `?status=draft&tag=craft&tag=fire`, so a
 *  filtered list can be linked to (`kintsugi://folder?path=essays&tag=craft`).
 *  Null when the link chooses nothing. */
export function linkedFilter(params: { status?: string | string[]; tag?: string | string[] }): Filter | null {
  const one = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);
  const status = one(params.status);
  const tags = [params.tag ?? []].flat().flatMap((t) => t.split(',')).map(normalTag).filter((t): t is string => !!t);
  const valid = status === 'draft' || status === 'complete' ? status : null;
  return valid || tags.length ? { status: valid, tags: [...new Set(tags)] } : null;
}

// ---- the chosen filter, shared by every list screen ----------------------

/** The filter follows the owner from the vault into a folder and back, for
 *  as long as the app is open. It isn't saved: opening the app shows
 *  everything. */
export class FilterStore {
  private value: Filter = NO_FILTER;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get = () => this.value;
  set(next: Filter) {
    this.value = next;
    this.listeners.forEach((l) => l());
  }
  toggleStatus(status: Status) {
    this.set({ ...this.value, status: this.value.status === status ? null : status });
  }
  toggleTag(tag: string) {
    const tags = this.value.tags;
    this.set({ ...this.value, tags: tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag] });
  }
  clear() {
    this.set(NO_FILTER);
  }
}
