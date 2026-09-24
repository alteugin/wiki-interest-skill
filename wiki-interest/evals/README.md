# Evals: does the skill work on a cheap model?

End-to-end runs of Claude Code on **Claude Haiku 4.5** with only this skill
installed. Each case is a realistic founder question; the agent has to find
the skill, run the CLI, write an answer and (when asked) produce the PDF.

```bash
# needs ANTHROPIC_API_KEY in the environment or in .env (skill or repo root)
node evals/run.ts                          # all cases
node evals/run.ts --case mercury-ambiguous # one case
node evals/run.ts --model claude-sonnet-5  # another model
```

Each run writes a graded summary to `evals/results/<timestamp>_<model>.md`.
Transcripts and workspaces stay in `../.eval-runs/` (git-ignored).

## How a run is isolated

- A fresh workspace per case with a **copy** of the skill in
  `.claude/skills/wiki-interest` (node_modules and the HTTP cache are symlinked).
- An empty `CLAUDE_CONFIG_DIR`, so no personal CLAUDE.md, skills, plugins or MCP
  servers leak in. The agent sees this skill plus Claude Code's built-ins.
  (`--bare` was tried first and rejected: it does not load project skills at all.)
- Tools limited to `Skill`, `Read`, `Glob`, `Grep` and `node`/`npm`/`ls`/`cat`
  in Bash, so a run that tries to bypass the skill (curl, python, ad-hoc
  scripts) shows up as blocked attempts in the transcript.

## What is checked automatically

| Check | Why |
|---|---|
| finished, skill used, used the CLI | the skill is discovered and actually drives the work |
| no hand-written analysis code | the agent doesn't bypass the skill with curl/python/`node -e` |
| no unneeded `npm ci` | setup instructions are followed (cost and speed) |
| PDF produced | when the user asked for a report |
| **chat answer: no invented numbers** | every number in the final reply is matched against the analysis files, using the same checker `report` applies to the PDF summary |
| mentions … | case-specific content: the missing Polish article, the chosen meaning of an ambiguous topic, the proxy article, the 3-year breakdown |

Automatic checks are necessary but not sufficient: every run was also read by
hand, and most of the fixes below came from that reading, not from a red check.

## Cases (`cases.json`)

| Case | What it probes |
|---|---|
| `fasting-pl-cs` | task example 1; Polish Wikipedia has **no article** on the topic |
| `astronomy-uk-trust` + follow-up | task example 2; "how much can we trust it"; follow-up adds languages and asks for 3 years |
| `english-learning-langs` | task example 3; "learning English" has no cross-language article, needs a proxy |
| `mercury-ambiguous` | ambiguous topic (planet / element / god) |
| `ukrainian-query` | question written in Ukrainian |

## Iteration log

Each row is a run on Claude Haiku 4.5; files are in `results/` (named by UTC
time). "Auto" is the automatic score; "found by reading" is what the manual
read-through of transcripts and answers turned up. Total spend for all runs:
about $2.40.

| Run | Setup | Auto | Found by reading | Fix |
|---|---|---|---|---|
| `07-53-35` | normal Claude Code config (95 skills, MCP servers) | 5/7 | Agent looked for a nonexistent folder, tried curl and ad-hoc JS, invoked the skill only after being blocked | Not a skill bug: noise from unrelated skills. Built isolated runs. |
| `07-59-47` | `--bare` | 5/7 | Project skills are not loaded in bare mode | Isolation via empty `CLAUDE_CONFIG_DIR` instead |
| `08-01-19` | **baseline**, 5 cases | 43/44 | (A) "Mercury" → planet chosen silently; (B) "learning English" measured via "English language" without saying so; (C) "last 3 years" answered with a 2-year comparison; (D) `npm ci` in 3/6 runs; (E) guessed skill path; (F) "Ukraine market", "per capita" | A, B, D, E, F: SKILL.md. C: **code**, `yearly` + `multiYearChange` for 36+ months |
| `08-05-51` | after fixes | 57/57 | +2% share called "growing"; speculation about competitors | Wording rules: ±10% is flat; no speculation beyond data |
| `08-10-02` | full | 56/57 | Fasting: agent stopped to ask instead of making the Czech-only report the user asked for | Rule: missing languages → finish with the rest, state the gap |
| `08-12`…`08-13` | fasting ×3 | 26/27 | The one failure was a **grader** bug (regex missed "doesn't have") | Regex fixed |
| `08-14-14` | full | 57/58 | "learning English" resolved to **Voice of America's "Learning English" program**; agent built a report on it | **Code**: `run` prints `measuring` + `checkTopic` first; SKILL.md explains activity phrases matching products |
| `08-17`…`08-18` | english ×3 | 28/30 | Right topic 3/3; proxy stated 2/3; one failure was a grader regex (hyphen) | Regex fixed; remaining miss is a known limitation |
| `08-19-26` | full | 56/57 | Agent assumed `~/.claude/skills/...`; the harness symlink hid the skill from the sandboxed agent, so it couldn't recover | SKILL.md: use the "Base directory" line. Harness: install a real copy |
| `08-23-26`, `08-26-08`, `08-28-58` | **final, 3 full runs** | 58/58, 57/58, 57/57 | The one failure: a timestamp inside a file link in the answer was read as a number (grader) | Links/paths stripped before the number check |

## Final state (3 full runs, 173 checks)

- **172/173 automatic checks** passed; the one failure was a grader artifact
  (verified by hand and fixed afterwards).
- **No invented numbers** in any PDF summary (enforced by `report`) or in any
  chat reply (checked by the eval).
- Right topic every time, including "learning English" (3/3 via "English
  language") and the ambiguous "Mercury" (asked the user, or named the planet).
- No unneeded `npm ci`, no bypassing the skill with custom code.
- About **$0.04 and 25 s per question** on Haiku 4.5 (4-6 agent turns).

## Known limitations of the agent's writing

These are wording issues in the chat reply that code cannot fully enforce:

- Haiku still often says "market" or "Ukraine" for a language edition
  (2-8 times per 5-case run) despite the wording rule. The PDF table and
  footer always use language names.
- Stating the proxy topic in the chat reply: followed in most runs, not all.
- Qualitative claims ("accelerating decline") are not machine-checked; only
  numbers are.

## Lessons

- Automatic checks passed on runs that had real problems (43/44 at baseline);
  most fixes came from reading transcripts.
- The grader itself was wrong three times (two regexes, one number filter).
  Every red check was confirmed in the transcript before changing the skill.
- One run per case is not enough: the "learning English" false match showed up
  in 1 of 3 runs. Changes were confirmed with repeated runs.
- Where a rule matters, move it from prose into code (number checks,
  `measuring` first in the output); Haiku follows structure more reliably than
  instructions.
