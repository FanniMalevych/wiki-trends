// A minimal agent loop for end-to-end tests: it presents the skill the way an
// agent platform does (name + description up front, SKILL.md read on demand)
// and gives the model two tools: read files in the skill, and run its CLI.
// Providers: Claude via the Anthropic SDK, and Gemini through its
// OpenAI-compatible chat-completions API via fetch.
import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const PROVIDERS = {
  anthropic: {
    kind: "anthropic",
    keyVar: "ANTHROPIC_API_KEY",
    defaultModel: "claude-haiku-4-5",
    // USD per million tokens, for the cost line in results.
    prices: { "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  },
  gemini: {
    kind: "openai",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    keyVar: "GEMINI_API_KEY",
    defaultModel: "gemini-3.5-flash", // a pinned version: "-latest" aliases change and were overloaded (503) when tested
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

function runTool(name, argumentsJson, { skillDir, env }) {
  let args;
  try {
    args = JSON.parse(argumentsJson || "{}");
  } catch {
    return "Error: tool arguments are not valid JSON.";
  }
  if (name === "read_file") {
    const target = resolve(skillDir, String(args.path ?? ""));
    if (relative(skillDir, target).startsWith("..")) return "Error: only files inside the skill directory can be read.";
    try {
      return truncate(readFileSync(target, "utf8"));
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }
  if (name === "run_cli") {
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
  return `Error: unknown tool ${name}.`;
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

// A session hides the provider's message format. next() returns the model's
// tool calls (arguments as a JSON string) or its final text, plus token usage.

function openAiSession({ provider, apiKey, model, system, log }) {
  const messages = [{ role: "system", content: system }];
  return {
    messages,
    addUser: (text) => messages.push({ role: "user", content: text }),
    async next() {
      const response = await complete(provider, apiKey, { model, messages, tools: TOOLS, tool_choice: "auto" }, log);
      const message = response.choices?.[0]?.message;
      if (!message) throw new Error(`No message in response: ${JSON.stringify(response).slice(0, 300)}`);
      // Keep the message exactly as returned: some providers attach data (e.g.
      // Gemini thought signatures) that must be sent back unchanged.
      messages.push(message);
      return {
        usage: { input: response.usage?.prompt_tokens ?? 0, output: response.usage?.completion_tokens ?? 0 },
        calls: (message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
        text: message.content ?? "",
      };
    },
    addToolResults: (results) => {
      for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
    },
  };
}

function anthropicSession({ apiKey, model, system }) {
  // The SDK retries rate limits and server errors itself.
  const client = new Anthropic({ apiKey, maxRetries: 4, timeout: REQUEST_TIMEOUT_MS });
  const tools = TOOLS.map(({ function: f }) => ({ name: f.name, description: f.description, input_schema: f.parameters }));
  const messages = [];
  return {
    messages,
    addUser: (text) => messages.push({ role: "user", content: text }),
    async next() {
      const response = await client.messages.create({
        model,
        max_tokens: 16000,
        system,
        tools,
        messages,
        // No prompt caching: these conversations stay below Haiku's minimum
        // cacheable prefix for most steps, and measured runs showed cache
        // writes (+25% cost) with no reads.
      });
      messages.push({ role: "assistant", content: response.content });
      const u = response.usage;
      return {
        usage: {
          input: u.input_tokens,
          output: u.output_tokens,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        },
        calls: response.content
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input) })),
        text: response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
      };
    },
    addToolResults: (results) =>
      messages.push({ role: "user", content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.output })) }),
  };
}

export async function listModels(provider, apiKey) {
  if (provider.kind === "anthropic") {
    const ids = [];
    for await (const m of new Anthropic({ apiKey }).models.list()) ids.push(m.id);
    return ids;
  }
  const res = await fetch(provider.modelsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Listing models failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()).data ?? []).map((m) => m.id);
}

/** USD for the given usage, or null when the model's price is not known (e.g. free tiers). */
export function costOf(provider, model, usage) {
  const p = provider.prices?.[model];
  if (!p) return null;
  const usd = (usage.input * p.input + usage.output * p.output + (usage.cacheRead ?? 0) * p.cacheRead + (usage.cacheWrite ?? 0) * p.cacheWrite) / 1e6;
  return Math.round(usd * 10000) / 10000;
}

/**
 * Runs a conversation of one or more user turns. Returns the transcript,
 * every tool call with its result, the final answers and token usage.
 */
export async function runConversation({ provider, apiKey, model, skillDir, env, turns, today, log = () => {} }) {
  const system = systemPrompt(skillDir, today);
  const session =
    provider.kind === "anthropic"
      ? anthropicSession({ apiKey, model, system })
      : openAiSession({ provider, apiKey, model, system, log });
  const toolCalls = [];
  const answers = [];
  const usage = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (const turn of turns) {
    session.addUser(turn);
    let answer = null;
    for (let step = 0; step < MAX_STEPS_PER_TURN && answer === null; step++) {
      const reply = await session.next();
      usage.requests++;
      for (const [k, v] of Object.entries(reply.usage)) usage[k] += v;

      if (reply.calls.length) {
        const results = reply.calls.map((call) => {
          const output = runTool(call.name, call.arguments, { skillDir, env });
          log(`  → ${call.name} ${call.arguments}`);
          toolCalls.push({ turn: answers.length, name: call.name, arguments: call.arguments, output });
          return { id: call.id, output };
        });
        session.addToolResults(results);
      } else {
        answer = reply.text;
      }
    }
    answers.push(answer ?? "(no answer: step limit reached)");
  }
  return { messages: session.messages, toolCalls, answers, usage };
}
