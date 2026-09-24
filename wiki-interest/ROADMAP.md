# Roadmap: from basic questions to real research

The skill answers one question well today: *how is interest in one topic moving
across a few chosen languages, and how far can we trust it?* This is how I'd
grow it, in order. Each step starts from something we actually saw in the data
or in the Haiku evals, and ends with how we'd know it worked.

**Working rule for every step:** first add an eval case that fails
(`evals/cases.json`), then change code or `SKILL.md`, then rerun on Haiku 4.5
several times. Logic that matters moves into code; `SKILL.md` stays short.

## Stage 1: trust the single-topic answer more

The current verdict rests on one article and heuristic thresholds.

| Change | Why (evidence) | Verified by |
|---|---|---|
| **Detect structural breaks** (a level shift that persists, e.g. ≥50% for 3+ months) and report them as a caveat, not as "interest fell" | `uk` "Інтервальне голодування" drops from ~800 to ~200 views/month in June 2025 and stays there. No rename or redirect explains it (checked the move log), so the cause is external, most likely search ranking. Today this reads as a real decline. | unit tests with synthetic step changes; the `uk` case gets a caveat |
| **Count redirects and renames**: sum views of all titles that redirect to the article, and follow page moves | Views are counted per exact title; a rename splits history in two | compare with [pageviews.wmcloud.org](https://pageviews.wmcloud.org) "redirects" view |
| **Cleaner baseline**: subtract the Main Page and special pages from the language total | They are the top entries of every edition's top list and swing the "share" metric | share change before/after on the eval topics |
| **Topic = cluster of articles**, not one: the main article plus closely related ones (Wikidata "subclass of", "part of", or a user-given list), reported per article and in total | "Learning English" has no article in 4 of 5 languages; one article is a thin proxy for a course topic | eval case where the answer changes with the cluster |
| **Calibrate thresholds statistically**: backtest `RULES` on a few thousand random articles (how often does "growing, high confidence" appear on noise, e.g. with shuffled months?) and replace hand-picked cutoffs with a seasonal trend test (e.g. seasonal Mann-Kendall) and a confidence interval on the change | 10%, 300 views/month and 9/12 are sensible guesses, not measured error rates | a published false-positive rate in `methodology.md` |

## Stage 2: answer the questions founders actually ask next

Evals show the next question is rarely "one topic, 3 languages". It's "which
of these?" and "where else?".

| Change | What it answers |
|---|---|
| **`compare` over many topics** → a topics × languages matrix (momentum and level), one report | "Which of our 15 candidate courses has the most momentum in Polish?" |
| **Language discovery**: for one topic, scan every edition that has the article (astronomy has 254) and rank by `viewsPerMillion` and `change` | "Where should we localize next?" without the user pre-picking languages |
| **Language → audience**: add Wikimedia's per-country breakdown of each edition (`top-by-country`; e.g. `uk.wikipedia` readers are mostly in UA, then US, PL, GB, DE) | turns "Ukrainian-language readers" into an honest statement about countries |
| **Topic discovery**: from a seed topic, find related articles that are rising (Wikidata neighbours, monthly top-1000 lists per edition) | "What adjacent topics are growing that we haven't considered?" |
| **Research log**: a small manifest per project (questions, QIDs, chosen proxies, assumptions, report paths) that the agent reads on follow-ups | long multi-turn research without the agent re-deciding what "the topic" meant |
| **Triangulation**: optional second signal (e.g. search trends, app-store keywords) shown next to Wikipedia with an agreement flag | Wikipedia measures curiosity, not demand; one source shouldn't decide an investment |

## Stage 3: larger data volumes

Today each topic × language is 2 REST calls, cached as JSON files on disk.
Scanning 250 languages × 50 topics is ~25,000 calls: fine once, slow and
impolite if repeated.

1. **Rate limiting and batching** in the HTTP client (a concurrency cap and a
   token bucket), respecting Wikimedia's API etiquette; resumable jobs.
2. **Columnar local store**: replace per-request JSON files with DuckDB or
   Parquet, so matrices across thousands of series are one query, not
   thousands of file reads.
3. **Bulk dumps instead of the API** for wide scans: Wikimedia publishes
   complete pageview dumps; a monthly job loads only the needed editions.
4. **Keep the agent's context small**: commands return ranked top-N tables and
   write everything else to files. This is what makes Haiku viable today,
   and it matters more as data grows.
5. **Watchlists**: scheduled monthly refresh for a saved set of topics and
   languages, with a short "what changed" digest.

## Stage 4: keep quality measurable

- **Evals in CI** on every change to `SKILL.md` or `scripts/`: the full suite on
  Haiku costs about $0.20 per run. Track pass rate over 3 runs, not a single run.
- **Grow the suite from real use**: every confusing user question becomes a case.
- **Check claims, not just numbers**: today `report` verifies numbers. Next,
  verify directions ("declining" must match `direction`) and banned wording
  ("market" for a language edition), which evals show Haiku still gets wrong.
- **Model matrix**: run the same suite on a stronger model to see which failures
  are the skill's fault and which are the model's.

## What I would do first

1. Structural-break detection: small change, removes the most misleading
   verdict we saw in real data.
2. Language discovery across all editions: the highest-value new question
   for a localization decision, and it reuses everything that exists.
3. Direction and wording checks in `report`: moves the remaining Haiku failures
   from prose rules into code, which evals showed works better.
