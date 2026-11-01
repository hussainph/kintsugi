import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { annotations, assemble, contentTypes, parseClipFile, unescape } from "./clips.ts";

const dir = new URL("./fixtures/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, dir), "utf8");
const clips = annotations.map((note) =>
  assemble(parseClipFile(note.path, read(note.path)), note, null),
);

test("one real clip file per content type, every fixture file used", () => {
  assert.deepEqual(clips.map((clip) => clip.type), contentTypes);
  const files = readdirSync(new URL("inspiration/", dir)).filter((f) => f.endsWith(".md"));
  assert.deepEqual(files.sort(), annotations.map((a) => a.path.split("/")[1]).sort());
});

test("clips are what the vault crate wrote: frontmatter, own text, bounded source", () => {
  for (const clip of clips) {
    assert.ok(clip.captured.match(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/), clip.path);
    assert.ok(clip.sourceChars <= 20_000, clip.path);
  }
  const youtube = clips.find((clip) => clip.type === "youtube")!;
  assert.equal(youtube.kind, "video");
  assert.match(youtube.file.source, /^## Intro/);
  const note = clips.find((clip) => clip.type === "note")!;
  assert.match(note.file.own, /^Kintsugi isn't about the gold/);
  assert.equal(note.file.source, "");
});

test("highlights are verbatim passages with the deepest honest link", () => {
  for (const clip of clips) {
    for (const passage of clip.passages) {
      assert.ok(unescape(clip.file.source).replace(/\s+/g, " ").includes(passage.text.replace(/\s+/g, " ")));
    }
  }
  const at = (type: string) => clips.find((clip) => clip.type === type)!.passages[0];
  assert.equal(at("youtube").anchor, "14:48");
  assert.match(at("youtube").href!, /[?&]t=888s$/);
  assert.equal(at("podcast").anchor, "10:17");
  assert.match(at("podcast").href!, /#t=617$/);
  assert.match(at("article").href!, /#:~:text=Half%20the%20ideas%20that,were%20writing%20it\.$/);
  assert.equal(at("paper").deep, false);
  const reddit = clips.find((clip) => clip.type === "reddit")!.passages;
  assert.equal(reddit[0].who, undefined);
  assert.equal(reddit[1].who, "u/theLightSlide");
  assert.equal(at("hn-thread").deep, false);
});

test("notes are dated, ordered and short enough for a thread", () => {
  for (const clip of clips) {
    const times = clip.thread.map((note) => note.at);
    assert.deepEqual([...times].sort(), times, clip.path);
    assert.ok(times.every((at) => at >= clip.captured), clip.path);
    assert.ok(clip.thread.every((note) => note.text.length <= 280), clip.path);
  }
});
