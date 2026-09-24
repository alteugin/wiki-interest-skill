import type { LangAnalysis } from "./analyze.ts";

export const MAX_SUMMARY_CHARS = 700;

export interface SummaryCheck {
  ok: boolean;
  /** Numbers in the summary that no analysis value supports. */
  unsupported: string[];
  /** What the agent may cite, for the error message. */
  allowed: string[];
  problems: string[];
}

interface Allowed {
  percents: number[];
  counts: number[];
  ratios: number[];
  years: number[];
}

// "+25%", "−60 %", "6,708", "1.4k", "7.7x", "12/12"
const NUMBER = /([-+−–]?)(\d[\d,]*(?:\.\d+)?)\s*(%|pp|k\b|K\b|M\b|×|x\b)?/g;

function collect(langs: Record<string, LangAnalysis>, range: { from: string; to: string }): Allowed {
  const percents: number[] = [];
  const counts: number[] = [];
  const ratios: number[] = [];
  const rs = Object.values(langs);
  for (const r of rs) {
    for (const v of [r.change, r.shareChange, r.medianMonthlyChange]) if (v !== null) percents.push(v * 100);
    counts.push(r.avgMonthlyViews, r.recentViews, r.priorViews, r.viewsPerMillion);
    for (const s of r.spikes) {
      counts.push(s.views);
      ratios.push(s.timesMedian);
    }
    if (r.consistency) counts.push(Number(r.consistency.split("/")[0]));
  }
  // "Polish readers are 2x as interested as Czech ones" is fine if the data says so.
  for (const a of rs) for (const b of rs) {
    if (a !== b && b.viewsPerMillion > 0) ratios.push(a.viewsPerMillion / b.viewsPerMillion);
    if (a !== b && b.avgMonthlyViews > 0) ratios.push(a.avgMonthlyViews / b.avgMonthlyViews);
  }
  const years: number[] = [];
  for (let y = Number(range.from.slice(0, 4)); y <= Number(range.to.slice(0, 4)); y++) years.push(y);
  return { percents, counts, ratios, years };
}

const near = (value: number, candidates: number[], tolerance: (c: number) => number) =>
  candidates.some((c) => Math.abs(value - c) <= tolerance(c));

/**
 * The agent writes the headline in its own words, but it may only use numbers
 * that the analysis actually produced (allowing for rounding).
 */
export function checkSummary(
  summary: string,
  langs: Record<string, LangAnalysis>,
  range: { from: string; to: string },
): SummaryCheck {
  const problems: string[] = [];
  if (summary.trim().length === 0) problems.push("Summary is empty.");
  if (summary.length > MAX_SUMMARY_CHARS) {
    problems.push(`Summary is ${summary.length} characters; keep it under ${MAX_SUMMARY_CHARS} so the report fits one page.`);
  }

  const allowed = collect(langs, range);
  const unsupported: string[] = [];
  for (const m of summary.matchAll(NUMBER)) {
    const [raw, , digits, unit] = m;
    let value = Number(digits!.replace(/,/g, ""));
    if (unit === "k" || unit === "K") value *= 1_000;
    if (unit === "M") value *= 1_000_000;

    let supported: boolean;
    if (unit === "%" || unit === "pp") {
      // Sign is carried by words ("fell 60%"), so compare magnitudes; ±1 point for rounding.
      supported = near(value, allowed.percents.map(Math.abs), () => 1);
    } else if (unit === "x" || unit === "×") {
      supported = near(value, allowed.ratios, (c) => Math.max(0.15, c * 0.1));
    } else if (allowed.years.includes(value) || (Number.isInteger(value) && value <= 24)) {
      // Years in range, and small counts like "12 months", "3 languages", "9/12".
      supported = true;
    } else {
      supported = near(value, allowed.counts, (c) => Math.max(1, c * 0.05));
    }
    if (!supported) unsupported.push(raw.trim());
  }

  if (problems.length === 0 && ![...summary.matchAll(NUMBER)].some((m) => m[3] === "%" || m[3] === "x" || m[3] === "×")) {
    problems.push("Cite at least one percentage or ratio from the analysis so the answer is grounded in data.");
  }

  const fmt = (x: number) => String(Math.round(x * 10) / 10);
  return {
    ok: problems.length === 0 && unsupported.length === 0,
    unsupported,
    problems,
    allowed: [
      `percents: ${[...new Set(allowed.percents.map((p) => `${fmt(p)}%`))].join(", ")}`,
      `counts: ${[...new Set(allowed.counts.map(fmt))].join(", ")}`,
      `ratios: ${[...new Set(allowed.ratios.map((r) => `${fmt(r)}x`))].join(", ")}`,
    ],
  };
}
