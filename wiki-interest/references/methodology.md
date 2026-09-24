# Methodology

How `analyze` turns pageviews into a direction and a confidence level.
Thresholds live in `RULES` in `scripts/analyze.ts` and are echoed in every
`*.analysis.json` file, so any verdict can be traced back to them.

## Data

- Source: Wikimedia Pageviews API, `agent=user` (automated traffic excluded),
  `all-access` (desktop + mobile web + app).
- One article per language, matched through its Wikidata item, so every
  language measures the same concept.
- Baseline: total human views of the whole language edition over the same
  months, used to separate topic interest from overall Wikipedia traffic.
- Months with no API row are `null`, not zero (article did not exist yet, or
  had almost no views). They are never silently treated as real zeros in trends.

## Direction

`change` = views in the last 12 months / views in the 12 months before − 1.
Comparing whole years cancels seasonality (school year, holidays, New Year
resolutions). `|change| < 10%` is "flat".

With less than 24 months, the range is split into halves instead. Seasonality
is then not controlled, so confidence is always low.

## Confidence

Starts at high and is lowered by each problem found:

| Check | Why it matters | Effect |
|---|---|---|
| < 24 months of data | seasonality not controlled | → low |
| ≥ 3 empty months in earlier year | "growth" is the article being created | → low |
| < 100 views/month | a handful of readers swing the percentage | → low |
| < 300 views/month | still noisy | one step down |
| < 7 of 12 same-month pairs agree with direction | change is not broad-based | → low |
| 7–8 of 12 agree | mixed | one step down |
| median same-month change has a different direction | a few unusual months drive the total | one step down |
| top 2 recent months > 40% of recent views | event-driven spike | one step down |
| share of edition moves differently from raw views | Wikipedia-wide traffic effect | one step down |

## Comparing languages

- `viewsPerMillion`: article views per million views of that language edition.
  Makes a 1.5M-article edition comparable with a 7M one.
- Rank momentum by `change`, level by `viewsPerMillion`. A small-but-growing
  audience and a large-but-flat one are different opportunities.

## Known limitations

- Pageviews show curiosity, not purchase intent or ability to pay.
- One article is a proxy for a topic. Readers may land on related articles or
  redirects that are not counted.
- A language is not a market: `en`, `es`, `pt`, `ar` span many countries; many
  readers use a second language's Wikipedia.
- Traffic from search engines and AI assistants changes over time and affects
  all articles; the share-of-edition check reduces but does not remove this.
- A missing article in a language means low coverage there, not zero demand.
