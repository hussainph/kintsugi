// Writes README's shortcut tables from the registry
// (src/lib/shortcuts.ts). `pnpm shortcuts:readme`; the desktop tests fail
// until README matches.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { README_END, README_START, readmeTables } from "../src/lib/shortcuts.ts";

const path = resolve(import.meta.dirname, "../../../README.md");
const readme = readFileSync(path, "utf8");
const start = readme.indexOf(README_START);
const end = readme.indexOf(README_END);
if (start < 0 || end < start) throw new Error(`README.md needs the lines\n${README_START}\n${README_END}`);
writeFileSync(path, `${readme.slice(0, start + README_START.length)}\n\n${readmeTables()}\n\n${readme.slice(end)}`);
console.log("README.md: shortcut tables written");
