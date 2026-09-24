# wiki-interest-skill

An [Agent Skill](https://agentskills.io/specification) that helps B2C founders decide
which topics to build next and which languages to launch in, using
[Wikimedia pageview data](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html).

> Status: the full flow works (topic → data → analysis → one-page PDF) and is tested end to end on Claude Haiku 4.5, see [evals](wiki-interest/evals/README.md).

## Examples

- [Astronomy in Ukrainian, Polish, Czech](examples/astronomy-uk-pl-cs.pdf)
- [Intermittent fasting in 8 languages](examples/intermittent-fasting-8-languages.pdf) (largest report; Polish has no article)

## Layout

```
wiki-interest/          the skill (copy this folder into your agent's skills dir)
  SKILL.md              instructions the agent reads
  scripts/              TypeScript CLI, run directly by Node 22.18+ (no build step)
  references/           methodology the agent reads only when needed
  tests/                unit tests for the offline logic (node:test)
  evals/                end-to-end runs on Claude Haiku 4.5: cases, runner, graded results
  ROADMAP.md            how to grow it into deeper research and larger data
```

## Install

Requires Node.js 22.18+ (runs TypeScript directly, no build step) and internet
access to wikidata.org and wikimedia.org.

```bash
# project-level skill for Claude Code (or ~/.claude/skills/ for all projects)
cp -R wiki-interest /path/to/project/.claude/skills/
npm ci --prefix /path/to/project/.claude/skills/wiki-interest
```

Then ask the agent a question, e.g. *"Is interest in astronomy growing in
Ukrainian Wikipedia, and how much can we trust it? Make a one-page PDF."*

## Quick start (CLI by hand)

```bash
npm ci --prefix wiki-interest

# 1. topic -> data -> analysis; prints JSON including "analysis": <path>
node wiki-interest/scripts/cli.ts run "astronomy" --langs uk,pl,cs

# 2. a short answer; every number in it is checked against the analysis
node wiki-interest/scripts/cli.ts report \
  --analysis <analysis path printed by run> \
  --question "Is interest in astronomy growing in Ukrainian Wikipedia?" \
  --summary "No. Ukrainian interest in astronomy fell 60% year over year ..."
# -> wiki-interest-output/reports/*.pdf (one page) and *.chart.svg
```

The default range is the last 24 complete months, so numbers shift month to
month. Individual steps (`resolve`, `fetch`, `analyze`) are available for
follow-up questions: `node wiki-interest/scripts/cli.ts help`.

Checks: `npm run typecheck --prefix wiki-interest`, `npm test --prefix wiki-interest`
(offline unit tests), `npm run eval --prefix wiki-interest` (Haiku runs, needs
`ANTHROPIC_API_KEY`).

## Design notes

- **Topic identity via Wikidata.** "Astronomy", "Астрономія" and "Astronomie" are
  different titles of the same Wikidata item (Q333). Resolving to a QID first
  makes cross-language comparison exact instead of guessed by the model.
- **Ambiguity is surfaced, not guessed.** "Mercury" returns planet / element / god
  candidates so the agent can ask the user.
- **CLI with JSON output.** Small, explicit steps a cheap model (Haiku 4.5)
  can chain reliably; full data goes to a file, stdout stays compact.
- **Disk cache.** Closed months never change, so they are cached forever;
  follow-up questions reuse them.
- **Trend you can trust.** Year-over-year comparison cancels seasonality;
  share of the whole language edition separates topic interest from overall
  Wikipedia traffic; confidence drops for low volume, short history, spikes and
  inconsistent months. See [methodology](wiki-interest/references/methodology.md).
- **The model writes the answer, the code guards the numbers.** The agent's
  summary answers the user's actual question, but `report` rejects it if it
  contains any number that is not in the analysis (rounding allowed) and
  returns the allowed values so the agent can fix it.
- **One page, always.** Summary length, caveat lines and language count are
  capped; the report fails loudly rather than spilling onto a second page.
- **Fonts.** DejaVu Sans (from npm) covers Latin, Cyrillic and Greek. Scripts it
  can't draw (e.g. Japanese titles) are replaced with a note instead of empty boxes.

## Limitations

- Pageviews show curiosity, not willingness to pay. Use the output to pick what
  to research next, not what to launch.
- One Wikipedia article stands in for a topic; redirects and related articles
  are not counted yet.
- A language edition is not a country (`en`, `es`, `pt` span many).
- Thresholds (10% flat band, 100/300 views per month, 9 of 12 months) are
  reasoned, not statistically calibrated. They are listed in `RULES` and echoed
  in every analysis file.
- Level shifts with an external cause (e.g. search ranking) currently read as
  real declines.
- The PDF font covers Latin, Cyrillic and Greek, not CJK or Arabic titles.
- On Haiku, wording in the chat reply ("market" for a language) doesn't always
  follow the rules; numbers are always checked.

## How AI was used and how I checked it

I built this with Claude Code in short iterations: I set the direction and made
the design calls (TypeScript on plain Node, CLI with JSON output, how confidence
is defined, the agent writing the headline answer while code checks its
numbers), and the agent wrote most of the code. I didn't take its output on
trust. Each layer was checked against something independent of the model:

- **Data:** numbers compared with Wikimedia's own
  [pageviews tool](https://pageviews.wmcloud.org).
- **Logic:** unit tests on synthetic series with known answers (seasonality,
  spikes, Wikipedia-wide decline); rules were broken on purpose to make sure a
  test fails. One test passed without the fix it was written for, and was redone.
- **Real data:** suspicious results were investigated by hand (a spike
  inflating a decline, a false "mixed signal" warning, an 84% drop, a level
  shift with no rename behind it).
- **Output:** every PDF opened and looked at; this caught missing Cyrillic
  glyphs, empty boxes for Japanese and a squashed chart with 8 languages.
- **Target model:** end-to-end runs on Claude Haiku 4.5, repeated, with
  transcripts read by hand. Automatic checks passed 43/44 on a baseline that had
  six real problems; the fixes came from reading. The grader was wrong three
  times too. Details: [evals/README.md](wiki-interest/evals/README.md).

## How to develop it further

Full plan with evidence and success criteria: [ROADMAP.md](wiki-interest/ROADMAP.md).
Every step starts with a failing eval case, then a change, then repeated Haiku runs.

1. **Trust single answers more:** detect structural breaks (a real one in the
   data: `uk` intermittent fasting, June 2025), count redirects, clean the
   baseline, measure topics as clusters of articles, calibrate thresholds on
   thousands of random articles instead of hand-picked cutoffs.
2. **Answer the next questions:** compare many topics at once, discover which of
   all ~250 language editions to target, map languages to countries with
   Wikimedia's per-country data, keep a research log for long sessions.
3. **Scale:** rate-limited batch fetching, DuckDB/Parquet instead of JSON files,
   bulk pageview dumps for wide scans, top-N outputs to keep the agent's
   context small, scheduled watchlists.
4. **Keep quality measurable:** evals in CI (~$0.20 per run on Haiku), verify
   directions and wording in code, not just numbers.
