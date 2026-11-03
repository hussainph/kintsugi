// What he can do with an item or a story, shared by cards, rows, the story
// page and the article page. Each change is announced so every place that
// shows the item updates; Not interested also reloads the lists (the
// backend emits feed:changed).
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { discuss as discussWithKin } from "@/lib/chat";
import { feed, refreshPicked, type FeedItem as Item, type Place, type Story } from "./api";
import { itemTitle, webUrl } from "./model";

const ITEM_CHANGED = "kintsugi:feed-item";

/** Tells every view that shows these items about their new state. */
export const announce = (items: Item[]) => window.dispatchEvent(new CustomEvent<Item[]>(ITEM_CHANGED, { detail: items }));

/** Calls `listener` with each item another view changed. */
export function useItemChanges(listener: (item: Item) => void) {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => {
    const handler = (e: Event) => (e as CustomEvent<Item[]>).detail.forEach((item) => latest.current(item));
    window.addEventListener(ITEM_CHANGED, handler);
    return () => window.removeEventListener(ITEM_CHANGED, handler);
  }, []);
}

export const openClip = (path: string) => window.dispatchEvent(new CustomEvent("kintsugi:open-clip", { detail: { path } }));

async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (e) {
    toast.error(String(e));
    return undefined;
  }
}

export const chipFor = (item: Item) => ({ kind: "feed", path: String(item.id), label: itemTitle(item) });

/**
 * One article's actions. A like changes the heart and nothing else on
 * screen (KI-91: no report on what moved in ranking).
 */
export function itemActions(item: Item, place: Place) {
  return {
    like: async () => {
      const next = await run(() => feed.act(item.id, item.liked ? "unlike" : "like", place));
      if (!next) return;
      announce([next]);
      refreshPicked();
    },
    save: async (before?: () => Promise<boolean>) => {
      if (item.savedPath) return openClip(item.savedPath);
      if (before && !(await before())) return;
      const next = await run(() => feed.save(item.id, place));
      if (!next?.savedPath) return;
      announce([next]);
      refreshPicked();
      const path = next.savedPath;
      toast("Saved to Inspiration", {
        description: next.note ? "Your note went with it." : undefined,
        action: { label: "Open", onClick: () => openClip(path) },
      });
    },
    dismiss: async () => {
      const next = await run(() => feed.act(item.id, "notInterested", place));
      if (!next) return false;
      announce([next]);
      refreshPicked();
      toast("Not interested", {
        action: {
          label: "Undo",
          onClick: () =>
            void feed
              .act(item.id, "undoNotInterested", place)
              .then((undone) => {
                announce([undone]);
                refreshPicked();
              })
              .catch((e) => toast.error(String(e))),
        },
      });
      return true;
    },
    discuss: () => {
      void feed.act(item.id, "discuss", place).catch(() => {});
      discussWithKin(chipFor(item));
    },
    openOriginal: () => {
      const link = webUrl(item.url);
      if (!link) return;
      void feed.act(item.id, "openOriginal", place).catch(() => {});
      void openUrl(link).catch((e) => toast.error(String(e)));
    },
  };
}

/**
 * A story's actions: Like and Save act on its lead article (one clip per
 * article he saves); Not interested hides every article in it.
 */
export function storyActions(story: Story, place: Place) {
  const lead = itemActions(story.lead, place);
  return {
    like: lead.like,
    save: lead.save,
    dismiss: async () => {
      const ids = story.items.map((i) => i.id);
      const hidden = await run(() => feed.dismissMany(ids, false, place));
      if (!hidden) return false;
      announce(hidden);
      refreshPicked();
      toast("Not interested", {
        action: {
          label: "Undo",
          onClick: () =>
            void feed
              .dismissMany(hidden.map((i) => i.id), true, place)
              .then((back) => {
                announce(back);
                refreshPicked();
              })
              .catch((e) => toast.error(String(e))),
        },
      });
      return true;
    },
    discuss: () => {
      void feed.act(story.lead.id, "discuss", place).catch(() => {});
      discussWithKin(story.items.map(chipFor));
    },
  };
}
