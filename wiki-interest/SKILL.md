---
name: wiki-interest
description: Measures and compares public interest in topics across Wikipedia language editions using Wikimedia pageview data, and produces a one-page PDF report with a chart. Use when a user asks whether interest in a topic is growing, wants to compare a topic across languages or countries, or needs data to decide which course, topic, market or localization language a B2C product should invest in next.
compatibility: Requires Node.js 22.18+ and internet access to wikidata.org and wikimedia.org.
metadata:
  version: "0.2"
---

# wiki-interest

Answers "is interest in topic X growing, and in which languages?" from Wikipedia
pageviews. All numbers come from the CLI. Never estimate or invent view counts.

## Setup (once)

```bash
npm ci --prefix <skill-dir>
```

Run commands from the user's working directory, so outputs land there
(in `./wiki-interest-output/`):

```bash
node <skill-dir>/scripts/cli.ts <command> ...
```

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
- Check `topic.description` matches what the user meant. If not, pick from
  `otherMeanings` and rerun with `--qid`.

Other statuses, stop and handle:
- `ambiguous`: several meanings (e.g. "Mercury": planet / element / god). Pick
  by `description` if the user's intent is clear, otherwise ask. Rerun with `--qid`.
- `not_found`: try the English term, a synonym, or `--search-lang`.
- `no_articles`: none of the languages cover it. Suggest a broader topic.

**2. Write the answer and build the report**

Write 2-4 sentences that answer the user's actual question (e.g. "should we
launch this course?", "which language next?"). Use only numbers from the `run`
output; rounding is fine. Mention confidence and the most important caveat.

```bash
node <skill-dir>/scripts/cli.ts report --analysis <analysis path> \
  --question "<the user's question>" \
  --summary "<your 2-4 sentences>"
```

If the summary is rejected, the error lists `unsupported` numbers and the
`allowed` values. Rewrite with allowed values and rerun. Never pass numbers you
computed yourself.

Then reply to the user with the same answer plus the `pdf` path.

## Reading the analysis

- Lead with `direction` + `confidence`, then the numbers. Pass on every item in
  `caveats`; they are the reasons confidence is not high.
- `change`: human views, last 12 months vs the 12 before (seasonality cancels out).
- `shareChange`: same, as a share of all views in that language edition. If it
  disagrees with `change`, the move is mostly Wikipedia-wide traffic, not the topic.
- `medianMonthlyChange`, `consistency` ("9/12"): broad-based change or a couple of
  months? News/viral months appear in `spikes`.
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
