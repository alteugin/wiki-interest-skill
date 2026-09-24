import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeLang, classify, compareLangs, type LangAnalysis, toMonthly } from "../scripts/analyze.ts";
import { periodsBetween, type Point } from "../scripts/pageviews.ts";

// School-year shaped seasonality: high in autumn, low in summer.
const SEASON = [1.6, 1.2, 1.1, 1.0, 1.0, 1.0, 0.9, 0.9, 0.8, 0.6, 0.5, 0.6];

function series(values: (number | null)[], from = "2024-09"): Point[] {
  const months = periodsBetween(from, "2099-12", "monthly").slice(0, values.length);
  return values.map((views, i) => ({ period: months[i]!, views }));
}

/** Two seasonal years: `base` monthly level in year one, `base * growth` in year two. */
function twoYears(base: number, growth: number): number[] {
  return [...SEASON.map((s) => Math.round(base * s)), ...SEASON.map((s) => Math.round(base * growth * s))];
}

const flatProject = (n: number) => series(Array(n).fill(100_000_000));

describe("classify", () => {
  it("treats small moves as flat", () => {
    assert.equal(classify(0.05), "flat");
    assert.equal(classify(-0.09), "flat");
    assert.equal(classify(0.15), "growing");
    assert.equal(classify(-0.2), "declining");
    assert.equal(classify(null), "flat");
  });
});

describe("toMonthly", () => {
  it("sums daily points into months and keeps all-null months as null", () => {
    const daily: Point[] = [
      { period: "2025-01-01", views: 10 },
      { period: "2025-01-02", views: null },
      { period: "2025-01-03", views: 5 },
      { period: "2025-02-01", views: null },
    ];
    assert.deepEqual(toMonthly(daily), [
      { period: "2025-01", views: 15 },
      { period: "2025-02", views: null },
    ]);
  });
});

describe("analyzeLang", () => {
  it("reports steady, broad-based growth with high confidence", () => {
    const r = analyzeLang({ article: series(twoYears(2000, 1.3)), project: flatProject(24) });
    assert.equal(r.method, "year_over_year");
    assert.equal(r.direction, "growing");
    assert.equal(r.confidence, "high");
    assert.equal(r.consistency, "12/12");
    assert.ok(Math.abs(r.change! - 0.3) < 0.01);
    assert.deepEqual(r.caveats, []);
  });

  it("does not mistake seasonality for a trend", () => {
    const r = analyzeLang({ article: series(twoYears(2000, 1.0)), project: flatProject(24) });
    assert.equal(r.direction, "flat");
  });

  it("flags growth driven by a single spike", () => {
    const values = Array(24).fill(500);
    values[18] = 20_000; // one viral month in the recent year
    const r = analyzeLang({ article: series(values), project: flatProject(24) });
    assert.equal(r.direction, "growing");
    assert.notEqual(r.confidence, "high");
    assert.equal(r.medianMonthlyChange, 0);
    assert.equal(r.spikes.length, 1);
    assert.ok(r.caveats.some((c) => c.includes("unusual months")));
  });

  it("does not flag a disagreement when both measures sit near the flat threshold", () => {
    // Total -9% (flat) vs typical month -10.5% (declining): same story, no caveat.
    const values = [...Array(12).fill(1000), ...Array(12).fill(895)];
    values[23] = 1000;
    const r = analyzeLang({ article: series(values), project: flatProject(24) });
    assert.equal(r.direction, "flat");
    assert.ok(!r.caveats.some((c) => c.includes("unusual months")));
  });

  it("separates a topic decline from a whole-Wikipedia decline", () => {
    const article = series(twoYears(2000, 0.7));
    const project = series([...Array(12).fill(100_000_000), ...Array(12).fill(70_000_000)]);
    const r = analyzeLang({ article, project });
    assert.equal(r.direction, "declining");
    assert.equal(classify(r.shareChange), "flat");
    assert.ok(r.caveats.some((c) => c.includes("overall Wikipedia traffic")));
  });

  it("gives low confidence on low volume", () => {
    const r = analyzeLang({ article: series(twoYears(40, 1.5)), project: flatProject(24) });
    assert.equal(r.confidence, "low");
  });

  it("gives low confidence when the article is new", () => {
    const values = [...Array(6).fill(null), ...Array(6).fill(800), ...Array(12).fill(1500)];
    const r = analyzeLang({ article: series(values), project: flatProject(24) });
    assert.equal(r.confidence, "low");
  });

  it("falls back to halves with low confidence on short history", () => {
    const r = analyzeLang({ article: series([...Array(6).fill(1000), ...Array(6).fill(1500)]), project: flatProject(12) });
    assert.equal(r.method, "half_over_half");
    assert.equal(r.confidence, "low");
  });

  it("adds a per-year breakdown when 3+ years are requested", () => {
    const values = [...Array(12).fill(1000), ...Array(12).fill(1500), ...Array(12).fill(1200)];
    const r = analyzeLang({ article: series(values, "2023-09"), project: flatProject(36) });
    assert.deepEqual(r.yearly?.map((y) => y.views), [12_000, 18_000, 14_400]);
    assert.equal(r.yearly?.[0]?.from, "2023-09");
    assert.equal(r.multiYearChange, 0.2);
    // The headline change still compares the last two years.
    assert.equal(r.change, -0.2);
  });

  it("omits the per-year breakdown below 3 years", () => {
    const r = analyzeLang({ article: series(twoYears(2000, 1.3)), project: flatProject(24) });
    assert.equal(r.yearly, null);
    assert.equal(r.multiYearChange, null);
  });

  it("refuses to judge fewer than 6 months", () => {
    assert.throws(() => analyzeLang({ article: series([1, 2, 3]), project: flatProject(3) }), /at least 6 months/);
  });
});

describe("compareLangs", () => {
  it("ranks by growth and by size-normalized interest separately", () => {
    const mk = (change: number, viewsPerMillion: number) => ({ change, viewsPerMillion, confidence: "high" }) as LangAnalysis;
    const c = compareLangs({ pl: mk(0.1, 20), cs: mk(0.4, 5), uk: mk(-0.2, 12) });
    assert.deepEqual(c.byGrowth.map((x) => x.lang), ["cs", "pl", "uk"]);
    assert.deepEqual(c.byInterestLevel.map((x) => x.lang), ["pl", "uk", "cs"]);
  });
});
