// Checks one end-to-end conversation against the expectations in tests/evals/evals.json.

function parsed(call) {
  try {
    return JSON.parse(call.arguments || "{}");
  } catch {
    return {};
  }
}

/** @returns {Array<{ check: string, pass: boolean, detail: string }>} */
export function grade(expect, { toolCalls, answers }) {
  const results = [];
  const add = (check, pass, detail) => results.push({ check, pass, detail });
  const cli = toolCalls.filter((c) => c.name === "run_cli");
  const commandOf = (c) => parsed(c).args?.[0];

  if (expect.readSkill !== undefined) {
    const read = toolCalls.some((c) => c.name === "read_file" && /(^|\/)SKILL\.md$/i.test(String(parsed(c).path ?? "")));
    add("readSkill", read === expect.readSkill, read ? "read SKILL.md" : "did not read SKILL.md");
  }

  for (const [command, min] of Object.entries(expect.calls ?? {})) {
    const n = cli.filter((c) => commandOf(c) === command).length;
    add(`calls.${command}`, n >= min, `${n} call(s), expected at least ${min}`);
  }
  if (expect.calls && Object.keys(expect.calls).length === 0) {
    add("calls.none", cli.length === 0, `${cli.length} CLI call(s), expected none`);
  }

  if (expect.cliOk) {
    const ok = cli.some((c) => commandOf(c) === expect.cliOk && /"ok":true/.test(c.output));
    add("cliOk", ok, ok ? `a ${expect.cliOk} call succeeded` : `no successful ${expect.cliOk} call`);
  }

  const answer = answers.at(-1) ?? "";
  for (const pattern of expect.answer ?? []) {
    add(`answer /${pattern}/`, new RegExp(pattern, "i").test(answer), "");
  }

  if (expect.maxToolCalls !== undefined) {
    add("maxToolCalls", toolCalls.length <= expect.maxToolCalls, `${toolCalls.length} tool call(s), limit ${expect.maxToolCalls}`);
  }
  return results;
}
