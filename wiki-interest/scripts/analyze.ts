import type { Point } from "./pageviews.ts";

// Thresholds are deliberately simple so every verdict can be explained in one sentence.
export const RULES = {
  /** Year-over-year change below this magnitude counts as "flat". */
  flatBand: 0.1,
  /** Average monthly views under these make percentages noisy. */
  lowVolume: 100,
  mediumVolume: 300,
  /** Out of 12 same-month comparisons, how many must agree with the overall direction. */
  strongConsistency: 9,
  moderateConsistency: 7,
  /** Share of the recent year's views that sits in its top 2 months. */
  spikeConcentration: 0.4,
  /** A month above this multiple of the median is reported as a spike. */
  spikeMultiple: 3,
} as const;

export type Direction = "growing" | "flat" | "declining";
export type Confidence = "high" | "medium" | "low";

export interface LangInput {
  article: Point[];
  project: Point[];
}

export interface LangAnalysis {
  direction: Direction;
  confidence: Confidence;
  /** One-line, human-readable summary of the numbers below. */
  verdict: string;
  method: "year_over_year" | "half_over_half";
  recentPeriod: { from: string; to: string };
  priorPeriod: { from: string; to: string };
  recentViews: number;
  priorViews: number;
  /** Relative change in raw human views, e.g. 0.25 = +25%. */
  change: number | null;
  /** Relative change in the article's share of all views in that language edition. */
  shareChange: number | null;
  avgMonthlyViews: number;
  /** Article views per million views of the whole language edition (recent period). */
  viewsPerMillion: number;
  /** Median of the 12 same-month changes: robust to a single spike in either year. */
  medianMonthlyChange: number | null;
  /** Same-month comparisons that moved in the overall direction, e.g. "9/12". */
  consistency: string | null;
  /**
   * With 3+ years of data: views per full 12-month block, oldest first, so a
   * "last 3 years" question isn't answered with a 2-year comparison.
   */
  yearly: { from: string; to: string; views: number }[] | null;
  /** Change from the oldest to the newest 12-month block (only when yearly is set). */
  multiYearChange: number | null;
  spikes: { period: string; views: number; timesMedian: number }[];
  /** Why confidence is not "high", or other things the reader must know. */
  caveats: string[];
}

const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;
const sumViews = (points: Point[]) => points.reduce((acc, p) => acc + (p.views ?? 0), 0);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Collapse daily points into calendar months; monthly points pass through. */
export function toMonthly(points: Point[]): Point[] {
  if (points.every((p) => p.period.length === 7)) return points;
  const months = new Map<string, number | null>();
  for (const p of points) {
    const month = p.period.slice(0, 7);
    const prev = months.get(month);
    months.set(month, p.views === null ? (prev ?? null) : (prev ?? 0) + p.views);
  }
  return [...months].map(([period, views]) => ({ period, views }));
}

export function classify(change: number | null): Direction {
  if (change === null || Math.abs(change) < RULES.flatBand) return "flat";
  return change > 0 ? "growing" : "declining";
}

const pct = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`);

const DOWNGRADE: Record<Confidence, Confidence> = { high: "medium", medium: "low", low: "low" };

export function analyzeLang(input: LangInput): LangAnalysis {
  const article = toMonthly(input.article);
  const project = toMonthly(input.project);
  if (article.length < 6) {
    throw new Error("Need at least 6 months of data to judge a trend; widen the range.");
  }

  // With 2+ years we compare the last 12 months to the 12 before them, which
  // cancels seasonality (school year, holidays). Otherwise halves are the best we can do.
  const yoy = article.length >= 24;
  const window = yoy ? 12 : Math.floor(article.length / 2);
  const recent = article.slice(-window);
  const prior = article.slice(-2 * window, -window);
  const recentProject = project.slice(-window);
  const priorProject = project.slice(-2 * window, -window);

  const recentViews = sumViews(recent);
  const priorViews = sumViews(prior);
  const change = priorViews > 0 ? recentViews / priorViews - 1 : null;

  const recentShare = recentViews / Math.max(1, sumViews(recentProject));
  const priorShare = priorViews / Math.max(1, sumViews(priorProject));
  const shareChange = priorShare > 0 ? recentShare / priorShare - 1 : null;

  const direction = classify(change);
  const avgMonthlyViews = recentViews / window;
  const caveats: string[] = [];
  let confidence: Confidence = "high";
  const downgrade = (reason: string, toLow = false) => {
    confidence = toLow ? "low" : DOWNGRADE[confidence];
    caveats.push(reason);
  };

  if (!yoy) {
    downgrade(`Only ${article.length} months of data: compared halves, so seasonality is not controlled.`, true);
  }

  const priorGaps = prior.filter((p) => p.views === null).length;
  if (priorGaps >= 3) {
    downgrade(`${priorGaps} months without data in the earlier period (article likely new); change partly reflects the article appearing.`, true);
  }

  if (avgMonthlyViews < RULES.lowVolume) {
    downgrade(`Low volume (~${Math.round(avgMonthlyViews)} views/month): a few readers move the percentage.`, true);
  } else if (avgMonthlyViews < RULES.mediumVolume) {
    downgrade(`Modest volume (~${Math.round(avgMonthlyViews)} views/month).`);
  }

  // Same-month-last-year comparisons: is the change broad-based or a few months?
  let consistency: string | null = null;
  let medianMonthlyChange: number | null = null;
  if (yoy) {
    const ratios = recent.flatMap((p, i) => {
      const before = prior[i]?.views;
      return p.views !== null && before ? [p.views / before - 1] : [];
    });
    if (ratios.length >= 6) {
      medianMonthlyChange = median(ratios);
      // Both numbers sitting on either side of the flat band is not a real disagreement.
      const gap = Math.abs(medianMonthlyChange - (change ?? 0));
      if (classify(medianMonthlyChange) !== direction && gap > RULES.flatBand) {
        downgrade(`Typical month changed ${pct(medianMonthlyChange)} vs ${pct(change)} in total: a few unusual months drive the headline number.`);
      }
    }
  }
  if (yoy && direction !== "flat") {
    const agreeing = recent.filter((p, i) => {
      const before = prior[i]?.views;
      if (p.views === null || before === null || before === undefined) return false;
      return direction === "growing" ? p.views > before : p.views < before;
    }).length;
    consistency = `${agreeing}/12`;
    if (agreeing < RULES.moderateConsistency) {
      downgrade(`Only ${agreeing} of 12 months moved in the overall direction: the change is not broad-based.`, true);
    } else if (agreeing < RULES.strongConsistency) {
      downgrade(`${agreeing} of 12 months moved in the overall direction: mixed signal.`);
    }
  }

  const recentValues = recent.map((p) => p.views ?? 0);
  const top2 = [...recentValues].sort((a, b) => b - a).slice(0, 2).reduce((a, b) => a + b, 0);
  if (recentViews > 0 && top2 / recentViews > RULES.spikeConcentration) {
    downgrade(`${Math.round((top2 / recentViews) * 100)}% of recent views fall in just 2 months: likely event-driven spikes, not steady interest.`);
  }

  const med = median(article.map((p) => p.views ?? 0).filter((v) => v > 0));
  const spikes = article
    .filter((p) => med > 0 && (p.views ?? 0) >= RULES.spikeMultiple * med)
    .map((p) => ({ period: p.period, views: p.views ?? 0, timesMedian: round((p.views ?? 0) / med, 1) }));

  const shareDirection = classify(shareChange);
  if (direction !== "flat" && shareDirection !== direction) {
    downgrade(
      `Raw views are ${direction} (${pct(change)}) but the topic's share of all views in this language is ${shareDirection} (${pct(shareChange)}): much of the move reflects overall Wikipedia traffic, not this topic.`,
    );
  }

  let yearly: LangAnalysis["yearly"] = null;
  let multiYearChange: number | null = null;
  if (article.length >= 36) {
    yearly = [];
    for (let end = article.length; end - 12 >= 0; end -= 12) {
      const block = article.slice(end - 12, end);
      yearly.unshift({ from: block[0]!.period, to: block.at(-1)!.period, views: sumViews(block) });
    }
    const first = yearly[0]!.views;
    multiYearChange = first > 0 ? round(yearly.at(-1)!.views / first - 1) : null;
  }

  const range = (pts: Point[]) => ({ from: pts[0]?.period ?? "", to: pts.at(-1)?.period ?? "" });
  return {
    direction,
    confidence,
    verdict: `${direction} (${pct(change)} ${yoy ? "year over year" : "vs previous period"}; share of language edition ${pct(shareChange)}), ${confidence} confidence`,
    method: yoy ? "year_over_year" : "half_over_half",
    recentPeriod: range(recent),
    priorPeriod: range(prior),
    recentViews,
    priorViews,
    change: change === null ? null : round(change),
    shareChange: shareChange === null ? null : round(shareChange),
    avgMonthlyViews: Math.round(avgMonthlyViews),
    viewsPerMillion: round(recentShare * 1e6, 1),
    medianMonthlyChange: medianMonthlyChange === null ? null : round(medianMonthlyChange),
    consistency,
    yearly,
    multiYearChange,
    spikes,
    caveats,
  };
}

export interface Comparison {
  /** Languages ordered by relative change (fastest growing first). */
  byGrowth: { lang: string; change: number | null; confidence: Confidence }[];
  /** Languages ordered by size-normalized interest (views per million edition views). */
  byInterestLevel: { lang: string; viewsPerMillion: number }[];
  notes: string[];
}

export function compareLangs(results: Record<string, LangAnalysis>): Comparison {
  const entries = Object.entries(results);
  const notes: string[] = [];
  if (entries.length > 1) {
    notes.push("Compare languages by viewsPerMillion and change, not raw views: language editions differ in size by orders of magnitude.");
  }
  if (entries.some(([, r]) => r.confidence === "low")) {
    notes.push("Some languages have low confidence; don't rank them on growth alone.");
  }
  return {
    byGrowth: entries
      .map(([lang, r]) => ({ lang, change: r.change, confidence: r.confidence }))
      .sort((a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity)),
    byInterestLevel: entries
      .map(([lang, r]) => ({ lang, viewsPerMillion: r.viewsPerMillion }))
      .sort((a, b) => b.viewsPerMillion - a.viewsPerMillion),
    notes,
  };
}
