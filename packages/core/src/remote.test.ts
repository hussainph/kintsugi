import assert from "node:assert/strict";
import { test } from "node:test";
import { localStamp, parsePairLink } from "./remote.ts";

test("reads the link from the desktop's QR code", () => {
  assert.deepEqual(parsePairLink("kintsugi://pair?url=https%3A%2F%2Fmac.tail1.ts.net%3A47474&token=AAAA-BBBB"), {
    url: "https://mac.tail1.ts.net:47474",
    token: "AAAA-BBBB",
  });
  assert.deepEqual(parsePairLink("  kintsugi:///pair/?url=http%3A%2F%2F127.0.0.1%3A47474%2F&token=T  "), {
    url: "http://127.0.0.1:47474",
    token: "T",
  });
});

test("rejects anything that isn't a pairing link", () => {
  assert.equal(parsePairLink("https://mac.tail1.ts.net:47474"), null);
  assert.equal(parsePairLink("kintsugi://pair?url=https%3A%2F%2Fmac"), null);
  assert.equal(parsePairLink("kintsugi://pair?url=ftp%3A%2F%2Fmac&token=T"), null);
  assert.equal(parsePairLink("kintsugi://pair?url=https%3A%2F%2Fmac%2Fpath&token=T"), null);
});

test("stamps local time to the minute", () => {
  assert.equal(localStamp(new Date(2026, 9, 29, 9, 4)), "2026-10-29T09:04");
});
