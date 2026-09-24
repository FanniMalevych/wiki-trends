// Keeps the skill's documentation in step with the code an agent will run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYZE_HELP } from "../../scripts/dist/commands/analyze.js";
import { CACHE_HELP } from "../../scripts/dist/commands/cache.js";
import { FETCH_HELP } from "../../scripts/dist/commands/fetch.js";
import { RESOLVE_HELP } from "../../scripts/dist/commands/resolve.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

test("every command option is documented in references/cli.md", () => {
  const doc = read("references/cli.md");
  for (const [name, help] of Object.entries({ ANALYZE_HELP, CACHE_HELP, FETCH_HELP, RESOLVE_HELP })) {
    for (const option of new Set(help.match(/--[a-z-]+/g))) {
      if (option === "--help") continue;
      assert.ok(doc.includes(`\`${option}`), `${option} from ${name} is missing in references/cli.md`);
    }
  }
});

test("SKILL.md follows the Agent Skills format", () => {
  const skill = read("SKILL.md");
  const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill) ?? [];
  assert.ok(frontmatter, "YAML frontmatter");
  const name = /^name: (.+)$/m.exec(frontmatter)?.[1];
  const description = /^description: (.+)$/m.exec(frontmatter)?.[1];
  assert.match(name, /^[a-z0-9-]{1,64}$/);
  assert.equal(name, "wikipedia-interest-trends");
  assert.ok(description && description.length <= 1024, "description ≤ 1024 characters");
  assert.ok(!/<|>/.test(description), "no XML tags in description");
  assert.ok(body.split("\n").length < 500, "body under 500 lines");
});

test("links in SKILL.md and references point to existing files, one level deep", () => {
  for (const file of ["SKILL.md", "references/cli.md", "references/interpretation.md"]) {
    for (const [, target] of read(file).matchAll(/\]\(([^)#]+)\)/g)) {
      if (/^https?:/.test(target)) continue;
      const resolved = join(root, dirname(file), target);
      assert.ok(existsSync(resolved), `${file} links to missing ${target}`);
      if (file === "SKILL.md") assert.ok(!target.includes("/") || target.split("/").length === 2, `${target} nests too deep`);
    }
  }
});
