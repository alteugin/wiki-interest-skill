# wiki-interest-skill

An [Agent Skill](https://agentskills.io/specification) that helps B2C founders decide
which topics to build next and which languages to launch in, using
[Wikimedia pageview data](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html).

> Work in progress: the full flow works (topic → data → analysis → one-page PDF). Next: end-to-end testing on Claude Haiku 4.5.

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
```

## Quick start

```bash
npm ci --prefix wiki-interest

# 1. topic -> data -> analysis (prints JSON, including the analysis file path)
node wiki-interest/scripts/cli.ts run "astronomy" --langs uk,pl,cs

# 2. the agent writes a short answer; every number in it is checked against the analysis
node wiki-interest/scripts/cli.ts report \
  --analysis wiki-interest-output/data/Q333_uk-pl-cs_2024-09_2026-08_monthly.analysis.json \
  --question "Is interest in astronomy growing in Ukrainian Wikipedia?" \
  --summary "No. Ukrainian interest in astronomy fell 60% year over year ..."
# -> wiki-interest-output/reports/*.pdf (one page) and *.chart.svg
```

Individual steps (`resolve`, `fetch`, `analyze`) are available for follow-up
questions; see `node wiki-interest/scripts/cli.ts help`.

Checks: `npm run typecheck --prefix wiki-interest` and `npm test --prefix wiki-interest`.

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
