import assert from "node:assert/strict";
import { test } from "node:test";
import { hideMargin, marginState, noticeStash, parseSaved, PULSE_MS, stashNotice, setMarginWhere, showMargin, tabsFor, toggleMargin, toggleTab, visibleTab } from "./state.ts";

test("the old reference margin's saved choice carries over", () => {
  assert.deepEqual(parseSaved("visible"), { open: true, tab: "references" });
  assert.deepEqual(parseSaved("hidden"), { open: false, tab: "kin" });
  assert.deepEqual(parseSaved(null), { open: false, tab: "kin" });
  assert.deepEqual(parseSaved('{"open":true,"tab":"stash"}'), { open: true, tab: "stash" });
  assert.deepEqual(parseSaved('{"open":true,"tab":"nope"}'), { open: true, tab: "kin" });
  assert.deepEqual(parseSaved("{broken"), { open: false, tab: "kin" });
});

test("a tab's key shows it, or closes the margin when it's showing", () => {
  setMarginWhere("writing");
  hideMargin();
  toggleTab("references");
  assert.equal(visibleTab(), "references");
  toggleTab("stash");
  assert.equal(visibleTab(), "stash");
  toggleTab("stash");
  assert.equal(visibleTab(), null);
  // The margin's own key brings back the last tab.
  toggleMargin();
  assert.equal(visibleTab(), "stash");
  toggleMargin();
  assert.equal(visibleTab(), null);
});

test("away from the editor the margin is Kin alone; a writing tab waits for the draft", () => {
  assert.deepEqual(tabsFor("away"), ["kin"]);
  setMarginWhere("writing");
  showMargin("references");
  setMarginWhere("away");
  assert.equal(visibleTab(), null, "References doesn't show over the Feed");
  toggleMargin();
  assert.equal(visibleTab(), "kin");
  toggleMargin();
  assert.equal(visibleTab(), null);
  showMargin("references");
  setMarginWhere("writing");
  assert.equal(visibleTab(), "references", "back in the draft, the tab he chose");
  assert.equal(marginState().open, true);
  hideMargin();
});

test("a stash shows in the Stash tab's row, else as one pulse on the margin button or the tab", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  setMarginWhere("writing");
  showMargin("stash");
  assert.equal(noticeStash(), "row");
  assert.equal(stashNotice()?.at, "row", "the live region also hears a visible stash");
  hideMargin();
  assert.equal(noticeStash(), "margin");
  const first = stashNotice();
  assert.equal(first?.at, "margin");
  showMargin("kin");
  assert.equal(noticeStash(), "tab");
  assert.equal(stashNotice()?.at, "tab");
  assert.notEqual(stashNotice()?.n, first?.n, "each stash restarts the pulse");
  setMarginWhere("away");
  assert.equal(noticeStash(), "margin", "away from the editor there is no Stash tab header");
  t.mock.timers.tick(PULSE_MS);
  assert.equal(stashNotice(), null, "it pulses once, then goes");
  hideMargin();
  setMarginWhere("writing");
});
