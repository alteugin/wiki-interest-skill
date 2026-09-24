import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LangAnalysis } from "../scripts/analyze.ts";
import { checkSummary, MAX_SUMMARY_CHARS } from "../scripts/verify.ts";

const RANGE = { from: "2024-09", to: "2026-08" };

function lang(overrides: Partial<LangAnalysis>): LangAnalysis {
  return {
    direction: "declining",
    confidence: "high",
    verdict: "",
    method: "year_over_year",
    recentPeriod: { from: "2025-09", to: "2026-08" },
    priorPeriod: { from: "2024-09", to: "2025-08" },
    recentViews: 6708,
    priorViews: 16614,
    change: -0.596,
    shareChange: -0.464,
    avgMonthlyViews: 559,
    viewsPerMillion: 9.9,
    medianMonthlyChange: -0.618,
    consistency: "11/12",
    yearly: null,
    multiYearChange: null,
    spikes: [{ period: "2024-09", views: 4687, timesMedian: 7.7 }],
    caveats: [],
    ...overrides,
  };
}

const LANGS = {
  uk: lang({}),
  pl: lang({ change: -0.161, shareChange: -0.08, avgMonthlyViews: 1431, viewsPerMillion: 7.6, recentViews: 17175 }),
};

describe("checkSummary", () => {
  it("accepts numbers taken from the analysis, rounded", () => {
    const r = checkSummary(
      "Interest fell 60% in Ukrainian (share -46%), in 11 of 12 months; Polish fell 16%. " +
        "Ukrainian averages ~560 views a month, 6.7k in the last year, 1.3x Polish per-million interest.",
      LANGS,
      RANGE,
    );
    assert.deepEqual(r.unsupported, []);
    assert.equal(r.ok, true);
  });

  it("rejects invented percentages and counts", () => {
    const r = checkSummary("Interest fell 45% and reached 25,000 readers.", LANGS, RANGE);
    assert.equal(r.ok, false);
    assert.deepEqual(r.unsupported, ["45%", "25,000"]);
  });

  it("rejects invented ratios", () => {
    const r = checkSummary("Ukrainian readers are 5x more interested.", LANGS, RANGE);
    assert.deepEqual(r.unsupported, ["5x"]);
  });

  it("requires at least one percentage or ratio", () => {
    const r = checkSummary("Interest is falling everywhere.", LANGS, RANGE);
    assert.equal(r.ok, false);
    assert.ok(r.problems[0]!.includes("at least one"));
  });

  it("allows years in range and small counts", () => {
    const r = checkSummary("Between 2024 and 2026, across 2 languages and 24 months, interest fell 60%.", LANGS, RANGE);
    assert.equal(r.ok, true);
  });

  it("rejects years outside the analyzed range", () => {
    const r = checkSummary("Interest has fallen since 2019.", LANGS, RANGE);
    assert.deepEqual(r.unsupported, ["2019"]);
  });

  it("rejects summaries too long for one page", () => {
    const r = checkSummary("Interest fell. ".repeat(60), LANGS, RANGE);
    assert.equal(r.ok, false);
    assert.ok(r.problems[0]!.includes(String(MAX_SUMMARY_CHARS)));
  });
});
