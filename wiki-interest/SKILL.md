---
name: wiki-interest
description: Measures and compares public interest in topics across Wikipedia language editions using Wikimedia pageview data. Use when a user asks whether interest in a topic is growing, wants to compare a topic across languages or countries, or needs data to decide which course, topic, market or localization language a B2C product should invest in next.
compatibility: Requires Node.js 22.18+ and internet access to wikidata.org and wikimedia.org.
metadata:
  version: "0.1"
---

# wiki-interest

Answers "is interest in topic X growing, and in which languages?" from Wikipedia
pageviews. All numbers come from the CLI. Never estimate or invent view counts.

## Setup (once)

```bash
cd <skill-dir> && npm ci
```

Run commands from the skill directory: `node scripts/cli.ts <command>`.
Every command prints JSON. On failure it prints `{"error": ...}` and exits 1.

## Workflow

1. **Resolve the topic** into a Wikidata item (QID). Article titles differ per
   language, so never guess titles yourself.

   ```bash
   node scripts/cli.ts resolve "intermittent fasting" --langs pl,cs
   ```

   - `status: "ok"`: use `topic.qid`. Check `topic.description` matches what the user meant.
   - `status: "ambiguous"`: several meanings (e.g. "Mercury": planet / element / god).
     Pick from `candidates` by description, or ask the user if intent is unclear.
   - `status: "not_found"`: retry with the English term or `--search-lang <lang>`
     for a query written in another language (e.g. `--search-lang uk`).
   - `missingLangs`: that language edition has **no article** on this topic.
     Tell the user; absence of an article is itself a signal of low coverage.

2. **Fetch pageviews** for the chosen QID:

   ```bash
   node scripts/cli.ts fetch --qid Q1666254 --langs pl,cs --months 24
   ```

   Options: `--from 2024-01 --to 2025-12` instead of `--months`;
   `--granularity daily` for short windows (spikes, events).
   Default is the last 24 complete months, monthly.

   Output is a summary plus `dataset`: the path of a JSON file with every data
   point. Pass that path to later steps instead of refetching. Results are cached,
   so rerunning with other languages or ranges is cheap.

## Language codes

Wikipedia codes, not country codes: `uk` Ukrainian, `pl` Polish, `cs` Czech,
`en` English, `de` German, `es` Spanish, `pt` Portuguese, `ja` Japanese.
Language editions do not map cleanly to countries (e.g. `en`, `es`, `pt` are
multi-country, and many Ukrainians also read `ru`/`en`).

## Data caveats to state in answers

- Views are human traffic (`agent=user`) to the exact article title. Redirects
  and other articles on the same subject are not counted.
- Pageviews measure curiosity, not willingness to pay.
- Raw view counts are not comparable across languages of different size:
  `languageEditionTotalViews` in the fetch summary gives the scale.
