import { useState } from "react";
import { Button, Popover } from "@kintsugi/ui/graphical";
import { CircleHelp } from "@kintsugi/ui/icons";
import { toast } from "sonner";
import { feed, refreshPicked, type FeedItem } from "./api";

/** Suggested sources stay unfollowed until this explicit action. */
export function SuggestionActions({ item }: { item: FeedItem }) {
  const [busy, setBusy] = useState(false);
  const [followed, setFollowed] = useState(false);
  if (!item.suggestion) return null;
  const follow = async () => {
    setBusy(true);
    try {
      await feed.followSuggestion(item.id);
      setFollowed(true);
      refreshPicked();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Popover.Root>
        <Popover.Trigger render={<Button variant="ghost" aria-label="About this suggestion" />}><CircleHelp className="size-4" /></Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner>
            <Popover.Popup className="max-w-[300px]">
              <p>{item.suggestion.reason}</p>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <Button variant="ghost" disabled={busy || followed} onClick={() => void follow()}>{followed ? "Following" : busy ? "Following…" : "Follow"}</Button>
    </>
  );
}
