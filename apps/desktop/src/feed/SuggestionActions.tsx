import { useState } from "react";
import { Button } from "@kintsugi/ui/graphical";
import { toast } from "sonner";
import { feed, refreshPicked, type FeedItem } from "./api";

/**
 * Follow, on a suggested piece (KI-95): its source stays unfollowed until
 * this one click. Why it's suggested is in the item's (?) card, with the
 * rest of its reasons.
 */
export function FollowSuggestion({ item }: { item: FeedItem }) {
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
    <Button variant="ghost" disabled={busy || followed} onClick={() => void follow()}>
      {followed ? "Following" : busy ? "Following…" : "Follow"}
    </Button>
  );
}
