import * as vega from "vega";
import { compile, type TopLevelSpec } from "vega-lite";
import type { Point } from "./pageviews.ts";
import { toMonthly } from "./analyze.ts";

export interface ChartSeries {
  /** Legend label, e.g. "Ukrainian (uk)". */
  lang: string;
  article: Point[];
  project: Point[];
}

export interface ChartOptions {
  /** Shade this range (the "recent" year used by analyze). */
  highlight?: { from: string; to: string };
  width?: number;
  height?: number;
}

// Color-blind-safe (Okabe-Ito), in a fixed order so a language keeps its color across charts.
// Yellow goes last: it is the hardest to read on white.
const PALETTE = ["#0072B2", "#E69F00", "#009E73", "#CC79A7", "#000000", "#D55E00", "#56B4E9", "#F0E442"];

export const CHART_FONT = "DejaVu Sans";

/**
 * Monthly interest per language, normalized to views per million views of the
 * whole language edition, so small and large Wikipedias share one axis.
 */
export function chartSpec(series: ChartSeries[], opts: ChartOptions = {}): TopLevelSpec {
  const rows = series.flatMap(({ lang, article, project }) => {
    const totals = new Map(toMonthly(project).map((p) => [p.period, p.views]));
    return toMonthly(article).flatMap((p) => {
      const total = totals.get(p.period);
      if (p.views === null || !total) return [];
      return [{ month: `${p.period}-01`, lang, perMillion: (p.views / total) * 1e6 }];
    });
  });

  const langs = series.map((s) => s.lang);
  const layers: TopLevelSpec[] = [];
  if (opts.highlight) {
    layers.push({
      data: { values: [{ from: `${opts.highlight.from}-01`, to: `${opts.highlight.to}-28` }] },
      mark: { type: "rect", color: "#f1f1f1" },
      encoding: {
        x: { field: "from", type: "temporal" },
        x2: { field: "to" },
      },
    } as unknown as TopLevelSpec);
  }
  layers.push({
    data: { values: rows },
    mark: { type: "line", point: { size: 14 }, strokeWidth: 1.8 },
    encoding: {
      x: { field: "month", type: "temporal", title: null, axis: { format: "%b %y", labelAngle: 0, tickCount: 8 } },
      y: { field: "perMillion", type: "quantitative", title: "views per million edition views" },
      color: {
        field: "lang",
        type: "nominal",
        title: null,
        scale: { domain: langs, range: PALETTE.slice(0, langs.length) },
        // Wrap into rows so a long legend never widens (and shrinks) the chart.
        legend: { orient: "top", direction: "horizontal", columns: Math.min(langs.length, 4) },
      },
    },
  } as unknown as TopLevelSpec);

  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width: opts.width ?? 500,
    height: opts.height ?? 200,
    background: "white",
    config: {
      font: CHART_FONT,
      view: { stroke: null },
      axis: { labelFontSize: 8, titleFontSize: 8, titleFontWeight: "normal", gridColor: "#e6e6e6", domainColor: "#999" },
      legend: { labelFontSize: 9, symbolSize: 60 },
    },
    layer: layers,
  } as unknown as TopLevelSpec;
}

export async function renderSvg(spec: TopLevelSpec): Promise<string> {
  const view = new vega.View(vega.parse(compile(spec).spec), { renderer: "none" });
  return view.toSVG();
}
