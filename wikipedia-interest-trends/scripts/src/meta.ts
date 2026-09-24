import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// This file compiles to scripts/dist/meta.js, so the skill root is two levels up.
export const SKILL_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;
