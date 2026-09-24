// The end-to-end harness itself, tested without calling a model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { systemPrompt } from "../e2e/agent.mjs";
import { grade } from "../e2e/grade.mjs";

const skillDir = fileURLToPath(new URL("../../", import.meta.url));
const call = (name, args, output = "") => ({ name, arguments: JSON.stringify(args), output });

test("system prompt shows only the skill's name and description, like skill discovery", () => {
  const prompt = systemPrompt(skillDir, "2026-09-24");
  assert.match(prompt, /name: wikipedia-interest-trends/);
  assert.match(prompt, /description: Measures whether public interest/);
  assert.match(prompt, /Today's date is 2026-09-24/);
  assert.doesNotMatch(prompt, /## Workflow/); // the body is loaded on demand
});

test("grade passes a transcript that follows the skill", () => {
  const checks = grade(
    { readSkill: true, calls: { analyze: 1 }, cliOk: "analyze", answer: ["declin", "confiden"], maxToolCalls: 3 },
    {
      toolCalls: [
        call("read_file", { path: "SKILL.md" }),
        call("run_cli", { args: ["analyze", "--title", "Astronomy"] }, '{"ok":true,"data":{}}'),
      ],
      answers: ["Interest is declining; confidence is medium."],
    },
  );
  assert.ok(checks.every((c) => c.pass), JSON.stringify(checks));
});

test("grade reports each failed expectation", () => {
  const checks = grade(
    { readSkill: true, calls: { analyze: 1 }, cliOk: "analyze", answer: ["confiden"], maxToolCalls: 1 },
    {
      toolCalls: [call("run_cli", { args: ["fetch"] }, '{"ok":false}'), call("run_cli", { args: ["analyze"] }, '{"ok":false}')],
      answers: ["Interest grows 12% a year."],
    },
  );
  const failed = checks.filter((c) => !c.pass).map((c) => c.check);
  assert.deepEqual(failed, ["readSkill", "cliOk", "answer /confiden/", "maxToolCalls"]);
});

test("grade expects no tool use for out-of-scope questions", () => {
  const expect = { readSkill: false, calls: {}, answer: ["paris"], maxToolCalls: 0 };
  assert.ok(grade(expect, { toolCalls: [], answers: ["Paris."] }).every((c) => c.pass));
  assert.ok(grade(expect, { toolCalls: [call("read_file", { path: "SKILL.md" })], answers: ["Paris."] }).some((c) => !c.pass));
});

test("every eval case has turns and checks", () => {
  const { cases } = JSON.parse(readFileSync(new URL("../evals/evals.json", import.meta.url), "utf8"));
  const ids = new Set();
  for (const c of cases) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.ok(c.turns.length > 0 && c.expect.answer.length > 0, c.id);
    for (const pattern of c.expect.answer) new RegExp(pattern, "i"); // throws on an invalid regex
  }
});
