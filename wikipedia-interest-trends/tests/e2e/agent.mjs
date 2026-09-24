// A minimal agent loop for end-to-end tests: it presents the skill the way an
// agent platform does (name + description up front, SKILL.md read on demand)
// and gives the model two tools: read files in the skill, and run its CLI.
// Talks to any OpenAI-compatible chat-completions API (Gemini, OpenRouter).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const PROVIDERS = {
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    keyVar: "GEMINI_API_KEY",
    defaultModel: "gemini-3.5-flash", // a pinned version: "-latest" aliases change and were overloaded (503) when tested
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    modelsUrl: "https://openrouter.ai/api/v1/models",
    keyVar: "OPENROUTER_API_KEY",
    defaultModel: undefined, // pick one with --model, e.g. a ":free" model that supports tools
  },
};

const MAX_OUTPUT_CHARS = 20_000;
const MAX_STEPS_PER_TURN = 12;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file inside the skill directory, e.g. SKILL.md or references/cli.md.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to the skill directory" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_cli",
      description: "Run `node scripts/dist/cli.js <args...>` in the skill directory and return its output.",
      parameters: {
        type: "object",
        properties: {
          args: { type: "array", items: { type: "string" }, description: 'Arguments, e.g. ["analyze", "--title", "Astronomy", "--from", "en", "--lang", "uk"]' },
        },
        required: ["args"],
      },
    },
  },
];

function skillFrontmatter(skillDir) {
  const text = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const field = (name) => new RegExp(`^${name}: (.+)$`, "m").exec(text)?.[1] ?? "";
  return { name: field("name"), description: field("description") };
}

export function systemPrompt(skillDir, today) {
  const { name, description } = skillFrontmatter(skillDir);
  return [
    "You are a helpful assistant. You can use Agent Skills: packaged instructions plus scripts.",
    "",
    "Available skills:",
    `- name: ${name}`,
    `  description: ${description}`,
    "  instructions: SKILL.md (read it with read_file before using the skill)",
    "",
    "Use a skill only when the request matches its description. Tools: read_file reads files in the skill",
    "directory; run_cli runs the skill's command-line tool there. Answer the user in plain prose.",
    `Today's date is ${today}.`,
  ].join("\n");
}

function truncate(text) {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]` : text;
}

function runTool(call, { skillDir, env }) {
  let args;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return "Error: tool arguments are not valid JSON.";
  }
  if (call.function.name === "read_file") {
    const target = resolve(skillDir, String(args.path ?? ""));
    if (relative(skillDir, target).startsWith("..")) return "Error: only files inside the skill directory can be read.";
    try {
      return truncate(readFileSync(target, "utf8"));
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }
  if (call.function.name === "run_cli") {
    if (!Array.isArray(args.args) || !args.args.every((a) => typeof a === "string")) {
      return 'Error: "args" must be an array of strings.';
    }
    // No shell: arguments go straight to the CLI, so nothing else can be executed.
    const r = spawnSync(process.execPath, ["scripts/dist/cli.js", ...args.args], {
      cwd: skillDir,
      env,
      encoding: "utf8",
      timeout: 180_000,
    });
    return truncate([r.stdout, r.stderr && `stderr: ${r.stderr}`, `exit code: ${r.status}`].filter(Boolean).join("\n"));
  }
  return `Error: unknown tool ${call.function.name}.`;
}

/** Thrown when the provider's daily quota is used up: retrying cannot help, so the run stops. */
export class QuotaExhaustedError extends Error {}

const REQUEST_TIMEOUT_MS = 120_000;

async function complete(provider, apiKey, body, log) {
  for (let attempt = 0; ; attempt++) {
    let res;
    let text;
    try {
      res = await fetch(provider.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      if (err.name !== "TimeoutError" || attempt >= 2) throw err;
      log(`  (no response in ${REQUEST_TIMEOUT_MS / 1000}s, retrying)`);
      continue;
    }
    if (res.ok) return JSON.parse(text);

    // Gemini names the exhausted quota, e.g. "…RequestsPerDayPerProjectPerModel-FreeTier".
    if (res.status === 429 && /PerDay/i.test(text)) {
      throw new QuotaExhaustedError(
        `Daily quota for ${body.model} is used up (free tier). It resets daily; try another --model or run again later.`,
      );
    }
    // Per-minute limits and temporary overload: wait as the API suggests, a few times.
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const hinted = Number(/retry in ([\d.]+)s/i.exec(text)?.[1] ?? res.headers.get("retry-after"));
      const wait = Number.isFinite(hinted) && hinted > 0 ? (hinted + 1) * 1000 : 10_000 * 2 ** attempt;
      log(`  (HTTP ${res.status}, waiting ${Math.round(wait / 1000)}s)`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Model API returned ${res.status}: ${text.slice(0, 500)}`);
  }
}

/**
 * Runs a conversation of one or more user turns. Returns the transcript,
 * every tool call with its result, the final answers and token usage.
 */
export async function runConversation({ provider, apiKey, model, skillDir, env, turns, today, log = () => {} }) {
  const messages = [{ role: "system", content: systemPrompt(skillDir, today) }];
  const toolCalls = [];
  const answers = [];
  const usage = { input: 0, output: 0, requests: 0 };

  for (const turn of turns) {
    messages.push({ role: "user", content: turn });
    let answer = null;
    for (let step = 0; step < MAX_STEPS_PER_TURN && answer === null; step++) {
      const response = await complete(provider, apiKey, { model, messages, tools: TOOLS, tool_choice: "auto" }, log);
      usage.requests++;
      usage.input += response.usage?.prompt_tokens ?? 0;
      usage.output += response.usage?.completion_tokens ?? 0;
      const message = response.choices?.[0]?.message;
      if (!message) throw new Error(`No message in response: ${JSON.stringify(response).slice(0, 300)}`);
      // Keep the message exactly as returned: some providers attach data (e.g.
      // Gemini thought signatures) that must be sent back unchanged.
      messages.push(message);

      if (message.tool_calls?.length) {
        for (const call of message.tool_calls) {
          const output = runTool(call, { skillDir, env });
          log(`  → ${call.function.name} ${call.function.arguments}`);
          toolCalls.push({ turn: answers.length, name: call.function.name, arguments: call.function.arguments, output });
          messages.push({ role: "tool", tool_call_id: call.id, content: output });
        }
      } else {
        answer = message.content ?? "";
      }
    }
    answers.push(answer ?? "(no answer: step limit reached)");
  }
  return { messages, toolCalls, answers, usage };
}
