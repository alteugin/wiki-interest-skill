# wiki-interest-skill

An [Agent Skill](https://agentskills.io/specification) that helps B2C founders decide
which topics to build next and which languages to launch in, using
[Wikimedia pageview data](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html).

> Work in progress: resolve, fetch and analyze are done; charts and PDF reports are next.

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
cd wiki-interest
npm ci
node scripts/cli.ts resolve "astronomy" --langs uk,pl,cs
node scripts/cli.ts fetch --qid Q333 --langs uk,pl,cs --months 24
node scripts/cli.ts analyze --dataset <path printed by fetch>
npm run typecheck
npm test
```

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
