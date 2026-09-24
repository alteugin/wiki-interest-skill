// End-to-end eval: runs Claude Code headless (default model: Haiku 4.5) on each
// case with only this skill installed, saves transcripts, and grades the runs.
//
//   node evals/run.ts                       # all cases
//   node evals/run.ts --case mercury-ambiguous --model claude-haiku-4-5
//
// When ANTHROPIC_API_KEY is set (environment, or .env in the skill or repo root),
// runs are isolated: an empty CLAUDE_CONFIG_DIR means no user CLAUDE.md, skills,
// plugins or MCP servers, so only this skill is available. (--bare is not an
// option: it skips project skills entirely.)

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { LangAnalysis } from "../scripts/analyze.ts";
import { checkSummary } from "../scripts/verify.ts";

interface Turn {
  prompt: string;
  mustMention?: string[];
  expectReport?: boolean;
}
interface Case extends Turn {
  id: string;
  note: string;
  followUp?: Turn;
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
}

interface TurnResult {
  finalText: string;
  toolCalls: ToolCall[];
  costUsd: number;
  turns: number;
  durationMs: number;
  sessionId: string;
  exitCode: number;
}

const SKILL_DIR = path.resolve(import.meta.dirname, "..");
const TOOLS = ["Skill", "Read", "Glob", "Grep", "Bash(node:*)", "Bash(npm:*)", "Bash(ls:*)", "Bash(cat:*)"];

function loadDotEnv(): void {
  for (const file of [path.join(SKILL_DIR, ".env"), path.join(SKILL_DIR, "..", ".env")]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
    }
  }
}

function runClaude(cwd: string, prompt: string, model: string, isolated: boolean, configDir: string, resume?: string): Promise<{ lines: string[]; exitCode: number }> {
  const args = [
    "-p", prompt,
    "--model", model,
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", "30",
    "--allowedTools", ...TOOLS,
    ...(isolated ? ["--strict-mcp-config"] : []),
    ...(resume ? ["--resume", resume] : []),
  ];
  return new Promise((resolve, reject) => {
    const env = isolated ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env;
    const child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ lines: out.split("\n").filter(Boolean), exitCode: code ?? 1 }));
  });
}

type Json = Record<string, any>;

function parseTranscript(lines: string[], exitCode: number): TurnResult {
  const calls = new Map<string, ToolCall>();
  const order: string[] = [];
  let finalText = "";
  let costUsd = 0, turns = 0, durationMs = 0, sessionId = "";
  for (const line of lines) {
    let ev: Json;
    try {
      ev = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    if (ev.session_id) sessionId = ev.session_id;
    if (ev.type === "assistant") {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "tool_use") {
          calls.set(block.id, { name: block.name, input: block.input ?? {}, result: "", isError: false });
          order.push(block.id);
        }
      }
    } else if (ev.type === "user") {
      for (const block of ev.message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        call.result = typeof block.content === "string"
          ? block.content
          : (block.content ?? []).map((c: Json) => c.text ?? "").join("\n");
        call.isError = !!block.is_error;
      }
    } else if (ev.type === "result") {
      finalText = ev.result ?? "";
      costUsd = ev.total_cost_usd ?? 0;
      turns = ev.num_turns ?? 0;
      durationMs = ev.duration_ms ?? 0;
    }
  }
  return { finalText, toolCalls: order.map((id) => calls.get(id)!), costUsd, turns, durationMs, sessionId, exitCode };
}

/** Every language analysis produced in this workspace, for checking the chat answer's numbers. */
function workspaceAnalyses(cwd: string): { langs: Record<string, LangAnalysis>; range: { from: string; to: string } } {
  const dir = path.join(cwd, "wiki-interest-output", "data");
  const langs: Record<string, LangAnalysis> = {};
  const range = { from: "9999-12", to: "0000-01" };
  if (!existsSync(dir)) return { langs, range };
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".analysis.json"))) {
    const a = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { langs: Record<string, LangAnalysis>; range: { from: string; to: string } };
    for (const [lang, r] of Object.entries(a.langs)) langs[`${f}:${lang}`] = r;
    if (a.range.from < range.from) range.from = a.range.from;
    if (a.range.to > range.to) range.to = a.range.to;
  }
  return { langs, range };
}

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

function grade(turn: Turn, r: TurnResult, cwd: string, pdfsBefore: number): Check[] {
  const bash = r.toolCalls.filter((c) => c.name === "Bash").map((c) => String(c.input.command ?? ""));
  const cli = bash.filter((c) => c.includes("cli.ts"));
  const results = r.toolCalls.map((c) => c.result).join("\n");
  const reportsDir = path.join(cwd, "wiki-interest-output", "reports");
  const pdfs = existsSync(reportsDir) ? readdirSync(reportsDir).filter((f) => f.endsWith(".pdf")).length : 0;
  const skillUsed = r.toolCalls.some((c) => c.name === "Skill" || (c.name === "Read" && String(c.input.file_path ?? "").endsWith("SKILL.md")));

  const checks: Check[] = [
    { name: "finished", pass: r.exitCode === 0 && r.finalText.length > 0, detail: `exit ${r.exitCode}` },
    { name: "skill used", pass: skillUsed || cli.length > 0 },
    { name: "used the CLI", pass: cli.length > 0, detail: `${cli.length} calls` },
    {
      name: "no hand-written analysis code",
      pass: !bash.some((c) => /python|node -e|curl|wget/.test(c)),
    },
    {
      name: "no unneeded npm ci",
      pass: !bash.some((c) => c.includes("npm ci")) || results.includes("ERR_MODULE_NOT_FOUND"),
    },
    {
      name: "summary rejections",
      pass: true,
      detail: String((results.match(/Summary rejected/g) ?? []).length),
    },
  ];
  if (turn.expectReport !== undefined) {
    const made = pdfs > pdfsBefore;
    checks.push({ name: turn.expectReport ? "PDF produced" : "no PDF needed", pass: turn.expectReport ? made : true, detail: `${pdfs - pdfsBefore} new` });
  }
  const { langs, range } = workspaceAnalyses(cwd);
  if (Object.keys(langs).length) {
    // Same check report applies to the PDF summary, applied to the chat reply.
    // Dates, QIDs and file names are not claims, so they are stripped first.
    const claims = r.finalText.replace(/(file|https?):\/\/\S+|\S+\.(pdf|svg|json)\b|Q\d+|\d{4}-\d{2}(-\d{2})?|`[^`]*`/g, "");
    const unsupported = checkSummary(claims, langs, range).unsupported;
    checks.push({ name: "chat answer: no invented numbers", pass: unsupported.length === 0, detail: unsupported.join(", ") || undefined });
  }
  for (const pattern of turn.mustMention ?? []) {
    checks.push({ name: `mentions /${pattern.slice(0, 40)}/`, pass: new RegExp(pattern, "i").test(r.finalText) });
  }
  return checks;
}

async function runCase(c: Case, model: string, isolated: boolean, outRoot: string) {
  const cwd = path.join(outRoot, c.id);
  // Install a real copy, like a user would: the agent is sandboxed to its working
  // directory, so a symlink to the skill would hide its files from the agent.
  // Dependencies and the HTTP cache are shared via symlinks to keep runs light.
  const installed = path.join(cwd, ".claude", "skills", "wiki-interest");
  const skip = new Set(["node_modules", ".cache", "evals", "tests", ".env"]);
  await cp(SKILL_DIR, installed, {
    recursive: true,
    filter: (src) => !skip.has(path.relative(SKILL_DIR, src).split(path.sep)[0] ?? ""),
  });
  await mkdir(path.join(SKILL_DIR, ".cache"), { recursive: true });
  await symlink(path.join(SKILL_DIR, "node_modules"), path.join(installed, "node_modules"));
  await symlink(path.join(SKILL_DIR, ".cache"), path.join(installed, ".cache"));

  const turns: { turn: Turn; result: TurnResult; checks: Check[] }[] = [];
  let sessionId: string | undefined;
  for (const [i, turn] of [c, ...(c.followUp ? [c.followUp] : [])].entries()) {
    const reportsDir = path.join(cwd, "wiki-interest-output", "reports");
    const before = existsSync(reportsDir) ? readdirSync(reportsDir).filter((f) => f.endsWith(".pdf")).length : 0;
    const configDir = path.join(outRoot, ".claude-config", c.id);
    await mkdir(configDir, { recursive: true });
    const { lines, exitCode } = await runClaude(cwd, turn.prompt, model, isolated, configDir, sessionId);
    await writeFile(path.join(cwd, `transcript-${i + 1}.jsonl`), lines.join("\n"));
    const result = parseTranscript(lines, exitCode);
    sessionId = result.sessionId || undefined;
    turns.push({ turn, result, checks: grade(turn, result, cwd, before) });
  }
  return { id: c.id, note: c.note, turns };
}

function toMarkdown(model: string, isolated: boolean, runs: Awaited<ReturnType<typeof runCase>>[]): string {
  const out = [`# Eval run: ${model}${isolated ? " (isolated config)" : " (user config loaded)"}`, "", `Date: ${new Date().toISOString()}`, ""];
  let total = 0, passed = 0, cost = 0;
  for (const run of runs) {
    out.push(`## ${run.id}`, "", `_${run.note}_`, "");
    run.turns.forEach(({ turn, result, checks }, i) => {
      cost += result.costUsd;
      out.push(`**Turn ${i + 1}:** ${turn.prompt}`, "");
      out.push(`turns: ${result.turns}, time: ${(result.durationMs / 1000).toFixed(0)}s, cost: $${result.costUsd.toFixed(4)}`, "");
      for (const ch of checks) {
        total++;
        if (ch.pass) passed++;
        out.push(`- ${ch.pass ? "✅" : "❌"} ${ch.name}${ch.detail ? ` (${ch.detail})` : ""}`);
      }
      const cli = result.toolCalls
        .filter((c) => c.name === "Bash")
        .map((c) => `    ${String(c.input.command).replace(/\s+/g, " ").slice(0, 220)}`);
      if (cli.length) out.push("", "Commands:", "", ...cli);
      out.push("", "Answer:", "", ...result.finalText.split("\n").map((l) => `> ${l}`), "");
    });
  }
  out.splice(3, 0, `Checks passed: ${passed}/${total}. Total cost: $${cost.toFixed(4)}`, "");
  return out.join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      case: { type: "string" },
      model: { type: "string", default: "claude-haiku-4-5" },
      out: { type: "string" },
    },
  });
  loadDotEnv();
  const isolated = !!process.env.ANTHROPIC_API_KEY;
  if (!isolated) console.error("ANTHROPIC_API_KEY not set: using your normal Claude Code config (your CLAUDE.md, skills and MCP servers will load).");

  const cases = JSON.parse(readFileSync(path.join(import.meta.dirname, "cases.json"), "utf8")) as Case[];
  const selected = values.case ? cases.filter((c) => c.id === values.case) : cases;
  if (selected.length === 0) throw new Error(`No case "${values.case}". Known: ${cases.map((c) => c.id).join(", ")}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // Workspaces live outside the skill: each one symlinks the skill in, and a
  // workspace inside the skill would make the agent see its own past runs.
  const outRoot = path.resolve(values.out ?? path.join(SKILL_DIR, "..", ".eval-runs"), stamp);
  await mkdir(outRoot, { recursive: true });

  // Sequential on purpose: workspaces share one node_modules, and parallel agents
  // running `npm ci` would clobber each other.
  const runs = [];
  for (const c of selected) {
    console.error(`running ${c.id}...`);
    runs.push(await runCase(c, values.model!, isolated, outRoot));
  }
  // Results are committed: keep them readable and free of local user paths.
  const report = toMarkdown(values.model!, isolated, runs)
    .replaceAll(outRoot, "<run>")
    .replaceAll(os.homedir(), "~");
  await writeFile(path.join(outRoot, "results.md"), report);
  // Keep the graded summary with the skill as evidence; transcripts stay local.
  await mkdir(path.join(import.meta.dirname, "results"), { recursive: true });
  await writeFile(path.join(import.meta.dirname, "results", `${stamp}_${values.model}.md`), report);
  console.log(report);
  console.log(`\nSaved to ${outRoot}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
