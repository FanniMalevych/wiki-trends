#!/usr/bin/env node
// End-to-end agent tests: a real model uses the skill through tool calls.
//
//   npm run e2e                                  all cases on Gemini (free tier)
//   npm run e2e -- --case q2-astronomy-uk        one case
//   npm run e2e -- --provider openrouter --model <id>
//   npm run e2e -- --list-models                 models available for the key
//   npm run e2e -- --dry-run                     show the prompt and cases, call nothing
//
// Keys come from .env in the skill directory (see .env.example). Transcripts
// and a summary are written to tests/e2e/results/<timestamp>/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PROVIDERS, QuotaExhaustedError, runConversation, systemPrompt } from "./agent.mjs";
import { grade } from "./grade.mjs";

const skillDir = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: {
    provider: { type: "string", default: "gemini" },
    model: { type: "string" },
    case: { type: "string", multiple: true },
    "list-models": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const provider = PROVIDERS[values.provider];
if (!provider) throw new Error(`Unknown --provider "${values.provider}". Use: ${Object.keys(PROVIDERS).join(", ")}.`);
const today = new Date().toISOString().slice(0, 10);
const { cases } = JSON.parse(readFileSync(join(skillDir, "tests/evals/evals.json"), "utf8"));
const selected = values.case ? cases.filter((c) => values.case.includes(c.id)) : cases;
if (selected.length === 0) throw new Error(`No case matches ${values.case}. Cases: ${cases.map((c) => c.id).join(", ")}`);

if (values["dry-run"]) {
  console.log(systemPrompt(skillDir, today));
  console.log(`\n${selected.length} case(s): ${selected.map((c) => c.id).join(", ")}`);
  process.exit(0);
}

if (existsSync(join(skillDir, ".env"))) process.loadEnvFile(join(skillDir, ".env"));
const apiKey = process.env[provider.keyVar];
if (!apiKey) throw new Error(`${provider.keyVar} is not set. Add it to ${join(skillDir, ".env")} (see .env.example).`);

if (values["list-models"]) {
  const res = await fetch(provider.modelsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Listing models failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  for (const m of (await res.json()).data ?? []) console.log(m.id);
  process.exit(0);
}

const model = values.model ?? provider.defaultModel;
if (!model) throw new Error(`Pass --model for provider ${values.provider}.`);

// The CLI gets a shared cache (so follow-up questions can reuse data) and never sees API keys.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY$/.test(k)));
env.WIT_CACHE_DIR = join(skillDir, "tests/e2e/.cache");

const outDir = join(skillDir, "tests/e2e/results", new Date().toISOString().replaceAll(":", "-").slice(0, 19));
mkdirSync(outDir, { recursive: true });
console.log(`${values.provider} / ${model}: ${selected.length} case(s) → ${outDir}\n`);

const summary = [];
for (const c of selected) {
  console.log(`● ${c.id}`);
  const started = Date.now();
  let result;
  let checks;
  try {
    result = await runConversation({ provider, apiKey, model, skillDir, env, turns: c.turns, today, log: console.log });
    checks = grade(c.expect, result);
  } catch (err) {
    if (err instanceof QuotaExhaustedError) {
      console.log(`  ✖ ${err.message}\n\nStopped: ${summary.length} of ${selected.length} case(s) ran.`);
      break;
    }
    result = { error: String(err.message ?? err), toolCalls: [], answers: [], usage: {} };
    checks = [{ check: "run", pass: false, detail: result.error }];
  }
  const passed = checks.every((x) => x.pass);
  for (const x of checks) console.log(`  ${x.pass ? "✔" : "✖"} ${x.check}${x.detail ? ` — ${x.detail}` : ""}`);
  if (result.answers?.length) console.log(`  answer: ${result.answers.at(-1).replaceAll("\n", " ").slice(0, 300)}…`);
  console.log(`  ${passed ? "PASS" : "FAIL"} in ${Math.round((Date.now() - started) / 1000)}s, ${JSON.stringify(result.usage)}\n`);

  writeFileSync(join(outDir, `${c.id}.json`), JSON.stringify({ case: c, model, provider: values.provider, ...result, checks }, null, 1));
  summary.push({ id: c.id, passed, failed: checks.filter((x) => !x.pass).map((x) => x.check), toolCalls: result.toolCalls.length, usage: result.usage });
}

const passedCount = summary.filter((s) => s.passed).length;
writeFileSync(join(outDir, "summary.json"), JSON.stringify({ provider: values.provider, model, date: today, passed: passedCount, total: summary.length, cases: summary }, null, 1));
console.log(`${passedCount}/${summary.length} cases passed.`);
process.exitCode = passedCount === summary.length ? 0 : 1;
