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
import { chartSpec, renderSvg } from "./chart.ts";
import { langName, MAX_REPORT_LANGS, renderReport } from "./report.ts";
import { checkSummary } from "./verify.ts";
import { resolveQid, resolveTopic } from "./wikidata.ts";

const USAGE = `wiki-interest: Wikipedia pageview trends per topic and language.
All commands print JSON to stdout. Typical flow: run, then report.

  run <topic> --langs uk,pl,cs [--search-lang en] [--months 24 | --from YYYY-MM --to YYYY-MM]
  run --qid Q333 --langs uk,pl,cs
      resolve + fetch + analyze in one step. Stops with status "ambiguous" or
      "not_found" if the topic needs clarifying.

  report --analysis <path> --summary "<2-4 sentence answer>" [--question "<user question>"]
      One-page PDF + SVG chart. Every number in --summary must come from the
      analysis, otherwise the summary is rejected with the allowed values.

  Individual steps (for follow-ups or to take control):
  resolve <topic> --langs uk,pl,cs [--search-lang en] | resolve --qid Q333 --langs ...
      Topic -> Wikidata item (QID) -> article title in each language.
  fetch --qid Q333 --langs uk,pl,cs [--months 24 | --from --to] [--granularity monthly|daily]
      Human pageviews per article + whole-language baseline -> dataset file.
  analyze --dataset <path>
      Direction, year-over-year change, share change, confidence + caveats,
      spikes, cross-language comparison -> analysis file.

  Common: --out-dir <dir> (default ./wiki-interest-output)
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

interface FetchOptions {
  qid: string;
  langs: string[];
  from: string;
  to: string;
  granularity: Granularity;
  outDir: string;
}

function fetchOptions(values: Record<string, string | undefined>, qid: string | undefined): FetchOptions {
  if (!qid) throw new UsageError("--qid is required. Run resolve first to get it.");
  const langs = parseLangs(values.langs);
  const { from, to } = parseRange(values);
  const granularity = (values.granularity ?? "monthly") as Granularity;
  if (granularity !== "monthly" && granularity !== "daily") throw new UsageError("--granularity must be monthly or daily.");
  return { qid, langs, from, to, granularity, outDir: path.resolve(values["out-dir"] ?? "wiki-interest-output") };
}

async function fetchDataset(o: FetchOptions) {
  const topic = await resolveQid(o.qid, o.langs);
  const present = o.langs.filter((l) => topic.articles[l]);

  const series = await Promise.all(
    present.map(async (lang) => {
      const article = topic.articles[lang]!;
      const [articlePoints, projectPoints] = await Promise.all([
        articleViews(lang, article.title, o.from, o.to, o.granularity),
        projectViews(lang, o.from, o.to, o.granularity),
      ]);
      return [lang, { ...article, article: articlePoints, project: projectPoints }] as const;
    }),
  );

  const dataset: Dataset = {
    schema: "wiki-interest/dataset@1",
    topic: { qid: topic.qid, label: topic.label, description: topic.description },
    range: { from: o.from, to: o.to, granularity: o.granularity },
    fetchedAt: new Date().toISOString(),
    source: "Wikimedia Pageviews API (agent=user, all-access). Views of the exact article title; redirects are not included.",
    missingLangs: topic.missingLangs,
    langs: Object.fromEntries(series),
  };

  const dir = path.join(o.outDir, "data");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${topic.qid}_${present.join("-") || "none"}_${o.from}_${o.to}_${o.granularity}.json`);
  await writeFile(file, JSON.stringify(dataset, null, 2));

  // Keep stdout small: the agent needs the shape of the data, not every point.
  const summary = {
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
  };
  return { file, dataset, summary };
}

async function cmdFetch(values: Record<string, string | undefined>): Promise<void> {
  print((await fetchDataset(fetchOptions(values, values.qid))).summary);
}

interface Dataset {
  schema: string;
  topic: { qid: string; label: string; description: string };
  range: { from: string; to: string; granularity: string };
  fetchedAt: string;
  source: string;
  missingLangs: string[];
  langs: Record<string, LangInput & { title: string; url: string }>;
}

interface Analysis {
  schema: string;
  dataset: string;
  topic: Dataset["topic"];
  range: Dataset["range"];
  missingLangs: string[];
  langs: Record<string, LangAnalysis & { title: string }>;
  comparison: ReturnType<typeof compareLangs>;
  rules: typeof RULES;
}

async function readJson<T extends { schema: string }>(file: string, schema: string, what: string): Promise<T> {
  let data: T;
  try {
    data = JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    throw new UsageError(`Cannot read ${what} ${file}. Use the exact path printed by the previous command.`);
  }
  if (data.schema !== schema) throw new UsageError(`${file} is not a wiki-interest ${what} file.`);
  return data;
}

async function analyzeDataset(datasetFile: string, dataset: Dataset) {
  const langs: Analysis["langs"] = {};
  for (const [lang, data] of Object.entries(dataset.langs)) {
    langs[lang] = { title: data.title, ...analyzeLang(data) };
  }
  const analysis: Analysis = {
    schema: "wiki-interest/analysis@1",
    dataset: path.resolve(datasetFile),
    topic: dataset.topic,
    range: dataset.range,
    missingLangs: dataset.missingLangs,
    langs,
    comparison: compareLangs(langs),
    rules: RULES,
  };
  const file = path.resolve(datasetFile.replace(/\.json$/, "") + ".analysis.json");
  await writeFile(file, JSON.stringify(analysis, null, 2));
  const { rules: _rules, dataset: _dataset, ...compact } = analysis;
  return { file, analysis, compact };
}

async function cmdAnalyze(values: Record<string, string | undefined>): Promise<void> {
  if (!values.dataset) throw new UsageError("--dataset is required: the path printed by fetch.");
  const dataset = await readJson<Dataset>(values.dataset, "wiki-interest/dataset@1", "dataset");
  const { file, compact } = await analyzeDataset(values.dataset, dataset);
  print({ analysis: file, ...compact });
}

const REPORT_HINT =
  "Write a 2-4 sentence answer to the user's question using only numbers from this output, then run: " +
  'report --analysis <analysis path> --summary "<answer>" --question "<user question>"';

async function cmdRun(positionals: string[], values: Record<string, string | undefined>): Promise<void> {
  const langs = parseLangs(values.langs);
  let qid = values.qid;
  let alternatives: { qid: string; label: string; description: string }[] = [];
  if (!qid) {
    const query = positionals.join(" ").trim();
    if (!query) throw new UsageError('Give a topic (run "astronomy" ...) or --qid.');
    const resolved = await resolveTopic(query, langs, values["search-lang"] ?? "en");
    if (resolved.status !== "ok") {
      // Stop and let the agent (or the user) choose; never guess the meaning.
      print(resolved);
      return;
    }
    qid = resolved.topic.qid;
    alternatives = resolved.alternatives.map(({ qid, label, description }) => ({ qid, label, description }));
  }
  const fetched = await fetchDataset(fetchOptions(values, qid));
  if (fetched.summary.status !== "ok") {
    print({ ...fetched.summary, hint: "None of these languages has an article on this topic. Try a broader topic or other languages." });
    return;
  }
  const { file, compact } = await analyzeDataset(fetched.file, fetched.dataset);
  print({
    status: "ok",
    analysis: file,
    ...compact,
    ...(alternatives.length ? { otherMeanings: alternatives } : {}),
    next: REPORT_HINT,
  });
}

async function cmdReport(values: Record<string, string | undefined>): Promise<void> {
  if (!values.analysis) throw new UsageError("--analysis is required: the path printed by analyze or run.");
  if (!values.summary) throw new UsageError("--summary is required: your 2-4 sentence answer, citing numbers from the analysis.");
  const analysis = await readJson<Analysis>(values.analysis, "wiki-interest/analysis@1", "analysis");
  const langCount = Object.keys(analysis.langs).length;
  if (langCount === 0) throw new UsageError("The analysis has no languages with data; nothing to report.");
  if (langCount > MAX_REPORT_LANGS) {
    throw new UsageError(`A one-page report fits up to ${MAX_REPORT_LANGS} languages; this analysis has ${langCount}. Fetch fewer languages.`);
  }

  const check = checkSummary(values.summary, analysis.langs, analysis.range);
  if (!check.ok) {
    print({
      error: "Summary rejected: every number must come from the analysis.",
      problems: check.problems,
      unsupported: check.unsupported,
      allowed: check.allowed,
      hint: "Rewrite the summary using the allowed values (rounding is fine) or describe the trend without numbers, then rerun report.",
    });
    process.exit(1);
  }

  const dataset = await readJson<Dataset>(analysis.dataset, "wiki-interest/dataset@1", "dataset");
  const firstLang = Object.values(analysis.langs)[0]!;
  const chartSvg = await renderSvg(
    chartSpec(
      Object.entries(dataset.langs).map(([lang, d]) => ({ lang: `${langName(lang)} (${lang})`, article: d.article, project: d.project })),
      { highlight: firstLang.method === "year_over_year" ? firstLang.recentPeriod : undefined },
    ),
  );

  const outDir = path.resolve(values["out-dir"] ?? path.join(path.dirname(analysis.dataset), ".."), "reports");
  await mkdir(outDir, { recursive: true });
  const base = path.basename(analysis.dataset).replace(/\.json$/, "");
  const chartFile = path.join(outDir, `${base}.chart.svg`);
  const pdfFile = path.join(outDir, `${base}.pdf`);
  await writeFile(chartFile, chartSvg);
  await renderReport(
    {
      topic: analysis.topic,
      range: analysis.range,
      question: values.question,
      summary: values.summary.trim(),
      chartSvg,
      langs: analysis.langs,
      missingLangs: analysis.missingLangs,
      analysisFile: values.analysis,
    },
    pdfFile,
  );
  print({ status: "ok", pdf: pdfFile, chart: chartFile });
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
      analysis: { type: "string" },
      summary: { type: "string" },
      question: { type: "string" },
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
    case "run":
      return cmdRun(rest, opts);
    case "resolve":
      return cmdResolve(rest, opts);
    case "fetch":
      return cmdFetch(opts);
    case "analyze":
      return cmdAnalyze(opts);
    case "report":
      return cmdReport(opts);
    default:
      throw new UsageError(`Unknown command "${command}".`);
  }
}

main().catch(fail);
