---
name: wiki-interest
description: Measures and compares public interest in topics across Wikipedia language editions using Wikimedia pageview data, and produces a one-page PDF report with a chart. Use when a user asks whether interest in a topic is growing, wants to compare a topic across languages or countries, or needs data to decide which course, topic, market or localization language a B2C product should invest in next.
compatibility: Requires Node.js 22.18+ and internet access to wikidata.org and wikimedia.org.
metadata:
  version: "0.3"
---

# wiki-interest

Answers "is interest in topic X growing, and in which languages?" from Wikipedia
pageviews. All numbers come from the CLI. Never estimate or invent view counts.

## Where things are

`<skill-dir>` below is the exact path from the "Base directory for this skill"
line shown when this skill loaded. Copy it from there; don't assume
`~/.claude/skills/...` and don't search for it.

Run commands from the user's working directory, so outputs land there
(in `./wiki-interest-output/`):

```bash
node <skill-dir>/scripts/cli.ts <command> ...
```

Dependencies are usually installed already. Only if a command fails with
`ERR_MODULE_NOT_FOUND`, run `npm ci --prefix <skill-dir>` once and retry.

Every command prints JSON. On failure it prints `{"error": ...}` and exits 1;
read the error, fix the arguments, retry.

## Standard flow: two commands

**1. Run the analysis**

```bash
node <skill-dir>/scripts/cli.ts run "astronomy" --langs uk,pl,cs
```

- Topic: short English noun phrase for the concept ("intermittent fasting",
  "English language", "astronomy"). For a query in another language add
  `--search-lang uk` (etc.).
- `--langs`: Wikipedia codes (see below). Default range: last 24 complete months.
  Use `--months 36` or `--from 2023-01 --to 2025-12` if the user asks.
- Read `measuring` first: does that description match what the user meant? If
  not, pick from `otherMeanings` and rerun with `--qid`, or rephrase the topic.
- Activity phrases ("learning English", "learning to code") often match a
  product, book or album of that name (e.g. "Learning English" is a Voice of
  America program). Search for the underlying concept instead ("English
  language", "computer programming") and treat it as a proxy.

Other statuses, stop and handle:
- `ambiguous`: several meanings (e.g. "Mercury": planet / element / god). Pick
  by `description` if the user's intent is clear, otherwise ask. Rerun with `--qid`.
- `not_found`: try the English term, a synonym, or `--search-lang`.
- `no_articles`: none of the languages cover it. Suggest a broader topic.
- Some languages in `missingLangs` but others have data: don't stop. Finish the
  request (analysis + report) with the languages that have data, state the gap
  up front, and offer a broader topic as a follow-up.

**2. Write the answer and build the report**

Write 2-4 sentences that answer the user's actual question (e.g. "should we
launch this course?", "which language next?"). Use only numbers from the `run`
output; rounding is fine. Mention confidence and the most important caveat.

**Always say what was measured.** If you picked one meaning of an ambiguous
topic ("Mercury" → the planet) or used a proxy article ("learning English" →
"English language"), say so in the first sentence of both the summary and your
reply, e.g. "Measured via the 'English language' article, the closest topic
with articles in all five languages: ...".

```bash
node <skill-dir>/scripts/cli.ts report --analysis <analysis path> \
  --question "<the user's question>" \
  --summary "<your 2-4 sentences>"
```

If the summary is rejected, the error lists `unsupported` numbers and the
`allowed` values. Rewrite with allowed values and rerun. Never pass numbers you
computed yourself.

Then reply to the user with the same answer plus the `pdf` path. Anything you
add in the reply must also come from the command output.

## Wording rules

- Say "Ukrainian-language Wikipedia" / "Ukrainian-language readers", not
  "Ukraine" or "the Ukrainian market": a language edition is not a country.
- `viewsPerMillion` is "views per million views of that Wikipedia", not per capita.
- A missing article means low coverage in that language, not low demand.
- Changes under ±10% are "flat" (the CLI's `direction`), never "growing" or
  "declining". Use the CLI's `direction`, don't reinterpret it.
- Don't speculate beyond the data (competition, market size, pricing). If you
  suggest a reason, label it as a hypothesis to check.
- Pageviews show curiosity, not willingness to pay: recommend what to *research
  next*, not what to launch.

## Reading the analysis

- Lead with `direction` + `confidence`, then the numbers. Pass on every item in
  `caveats`; they are the reasons confidence is not high.
- `change`: human views, last 12 months vs the 12 before (seasonality cancels out).
- `shareChange`: same, as a share of all views in that language edition. If it
  disagrees with `change`, the move is mostly Wikipedia-wide traffic, not the topic.
- `medianMonthlyChange`, `consistency` ("9/12"): broad-based change or a couple of
  months? News/viral months appear in `spikes`.
- `change` always compares the last 12 months with the 12 before. For a
  3+ year question use `yearly` (views per 12-month block, oldest first) and
  `multiYearChange` (oldest to newest block).
- Across languages: `viewsPerMillion` = interest level adjusted for edition size;
  `change` = momentum. Never rank by raw views.
- `missingLangs`: no article in that language. Say so; it means low coverage, not zero demand.
- `confidence: low` means "not enough evidence", not "declining".
- Method details: [references/methodology.md](references/methodology.md). Read
  only if the user questions the method.

## Follow-up questions

Data is cached, so reruns are cheap. Reuse the `qid` from the previous output:

- Other languages or range: `run --qid Q333 --langs de,fr --months 36`
- Short event window: `fetch --qid Q333 --langs uk --from 2025-01 --to 2025-03 --granularity daily`,
  then `analyze --dataset <path>`
- Several related topics (e.g. "astronomy" and "astrophysics"): one `run` per topic,
  then compare their `change` and `viewsPerMillion` in your answer.

## Language codes

Wikipedia codes, not country codes: `en` English, `uk` Ukrainian, `pl` Polish,
`cs` Czech, `de` German, `fr` French, `es` Spanish, `it` Italian, `pt` Portuguese,
`ro` Romanian, `tr` Turkish, `ja` Japanese, `ko` Korean, `ar` Arabic, `hi` Hindi.
A language is not a country: `en`, `es`, `pt`, `ar` span many countries, and
many people read another language's Wikipedia. Max 8 languages per report.

## Data caveats to state when relevant

- Human traffic (`agent=user`) to the exact article; redirects and related
  articles are not counted.
- Pageviews measure curiosity, not willingness to pay.
- Search engines and AI assistants increasingly answer questions directly,
  lowering Wikipedia visits for many topics; `shareChange` only partly corrects this.
