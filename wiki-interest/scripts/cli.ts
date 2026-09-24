import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  articleViews,
  EARLIEST_MONTH,
  type Granularity,
  lastCompleteMonths,
  type Point,
  projectViews,
} from "./pageviews.ts";
import { analyzeLang, compareLangs, type LangAnalysis, type LangInput, RULES } from "./analyze.ts";
import { resolveQid, resolveTopic } from "./wikidata.ts";

const USAGE = `wiki-interest: Wikipedia pageview trends per topic and language.
All commands print JSON to stdout.

  resolve <topic> --langs uk,pl,cs [--search-lang en]
  resolve --qid Q333 --langs uk,pl,cs
      Topic -> Wikidata item (QID) -> article title in each language.
      status "ambiguous" returns candidates: pick one and pass its --qid.

  fetch --qid Q333 --langs uk,pl,cs [--months 24 | --from YYYY-MM --to YYYY-MM]
        [--granularity monthly|daily] [--out-dir ./wiki-interest-output]
      Downloads human pageviews for each article plus the whole-language
      baseline, saves a dataset file and prints a compact summary with its path.

  analyze --dataset <path from fetch>
      Direction (growing/flat/declining), year-over-year change, change in share
      of the language edition, confidence (high/medium/low) with caveats, spikes,
      and a cross-language comparison. Saves <dataset>.analysis.json.
`;

class UsageError extends Error {}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message, ...(error instanceof UsageError ? { usage: USAGE } : {}) }, null, 2));
  process.exit(1);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function parseLangs(raw: string | undefined): string[] {
  if (!raw) throw new UsageError("--langs is required, e.g. --langs uk,pl,cs");
  const langs = [...new Set(raw.split(",").map((l) => l.trim().toLowerCase()).filter(Boolean))];
  const bad = langs.filter((l) => !/^[a-z]{2,3}(-[a-z]+)*$/.test(l));
  if (bad.length) throw new UsageError(`Not Wikipedia language codes: ${bad.join(", ")}. Use codes like en, uk, pl, zh-yue.`);
  return langs;
}

function parseRange(opts: { months?: string; from?: string; to?: string }): { from: string; to: string } {
  if (opts.from || opts.to) {
    if (!opts.from || !opts.to) throw new UsageError("Pass both --from and --to (YYYY-MM), or use --months.");
    if (opts.from < EARLIEST_MONTH) throw new UsageError(`Pageview data starts at ${EARLIEST_MONTH}.`);
    if (opts.from > opts.to) throw new UsageError("--from must not be after --to.");
    return { from: opts.from, to: opts.to };
  }
  const months = Number(opts.months ?? 24);
  if (!Number.isInteger(months) || months < 1) throw new UsageError("--months must be a positive integer.");
  return lastCompleteMonths(months);
}

const sum = (points: Point[]) => points.reduce((acc, p) => acc + (p.views ?? 0), 0);

async function cmdResolve(positionals: string[], values: Record<string, string | undefined>): Promise<void> {
  const langs = parseLangs(values.langs);
  if (values.qid) {
    print({ status: "ok", topic: await resolveQid(values.qid, langs, values["search-lang"] ?? "en") });
    return;
  }
  const query = positionals.join(" ").trim();
  if (!query) throw new UsageError("Give a topic (resolve \"astronomy\" ...) or --qid.");
  print(await resolveTopic(query, langs, values["search-lang"] ?? "en"));
}

async function cmdFetch(values: Record<string, string | undefined>): Promise<void> {
  if (!values.qid) throw new UsageError("--qid is required. Run resolve first to get it.");
  const langs = parseLangs(values.langs);
  const { from, to } = parseRange(values);
  const granularity = (values.granularity ?? "monthly") as Granularity;
  if (granularity !== "monthly" && granularity !== "daily") throw new UsageError("--granularity must be monthly or daily.");

  const topic = await resolveQid(values.qid, langs);
  const present = langs.filter((l) => topic.articles[l]);

  const series = await Promise.all(
    present.map(async (lang) => {
      const article = topic.articles[lang]!;
      const [articlePoints, projectPoints] = await Promise.all([
        articleViews(lang, article.title, from, to, granularity),
        projectViews(lang, from, to, granularity),
      ]);
      return [lang, { ...article, article: articlePoints, project: projectPoints }] as const;
    }),
  );

  const dataset = {
    schema: "wiki-interest/dataset@1",
    topic: { qid: topic.qid, label: topic.label, description: topic.description },
    range: { from, to, granularity },
    fetchedAt: new Date().toISOString(),
    source: "Wikimedia Pageviews API (agent=user, all-access). Views of the exact article title; redirects are not included.",
    missingLangs: topic.missingLangs,
    langs: Object.fromEntries(series),
  };

  const outDir = path.resolve(values["out-dir"] ?? "wiki-interest-output", "data");
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${topic.qid}_${present.join("-") || "none"}_${from}_${to}_${granularity}.json`);
  await writeFile(file, JSON.stringify(dataset, null, 2));

  // Keep stdout small: the agent needs the shape of the data, not every point.
  print({
    status: present.length ? "ok" : "no_articles",
    dataset: file,
    topic: dataset.topic,
    range: dataset.range,
    missingLangs: topic.missingLangs,
    langs: Object.fromEntries(
      series.map(([lang, s]) => [
        lang,
        {
          title: s.title,
          totalViews: sum(s.article),
          periodsWithoutData: s.article.filter((p) => p.views === null).length,
          first: s.article[0],
          last: s.article.at(-1),
          languageEditionTotalViews: sum(s.project),
        },
      ]),
    ),
  });
}

interface Dataset {
  schema: string;
  topic: { qid: string; label: string; description: string };
  range: { from: string; to: string; granularity: string };
  missingLangs: string[];
  langs: Record<string, LangInput & { title: string }>;
}

async function cmdAnalyze(values: Record<string, string | undefined>): Promise<void> {
  if (!values.dataset) throw new UsageError("--dataset is required: the path printed by fetch.");
  let dataset: Dataset;
  try {
    dataset = JSON.parse(await readFile(values.dataset, "utf8")) as Dataset;
  } catch {
    throw new UsageError(`Cannot read dataset ${values.dataset}. Use the exact "dataset" path printed by fetch.`);
  }
  if (dataset.schema !== "wiki-interest/dataset@1") throw new UsageError("Not a wiki-interest dataset file.");

  const langs: Record<string, LangAnalysis & { title: string }> = {};
  for (const [lang, data] of Object.entries(dataset.langs)) {
    langs[lang] = { title: data.title, ...analyzeLang(data) };
  }
  const analysis = {
    schema: "wiki-interest/analysis@1",
    dataset: path.resolve(values.dataset),
    topic: dataset.topic,
    range: dataset.range,
    missingLangs: dataset.missingLangs,
    langs,
    comparison: compareLangs(langs),
    rules: RULES,
  };
  const file = values.dataset.replace(/\.json$/, "") + ".analysis.json";
  await writeFile(file, JSON.stringify(analysis, null, 2));
  const { rules: _rules, ...compact } = analysis;
  print({ analysis: path.resolve(file), ...compact });
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      langs: { type: "string" },
      qid: { type: "string" },
      "search-lang": { type: "string" },
      months: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      granularity: { type: "string" },
      "out-dir": { type: "string" },
      dataset: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  const opts = values as Record<string, string | undefined>;

  if (!command || command === "help" || values.help) {
    console.log(USAGE);
    return;
  }
  switch (command) {
    case "resolve":
      return cmdResolve(rest, opts);
    case "fetch":
      return cmdFetch(opts);
    case "analyze":
      return cmdAnalyze(opts);
    default:
      throw new UsageError(`Unknown command "${command}".`);
  }
}

main().catch(fail);
