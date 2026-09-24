import { createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as fontkit from "fontkit";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import type { LangAnalysis } from "./analyze.ts";
import { CHART_FONT } from "./chart.ts";

const require = createRequire(import.meta.url);
const FONT_DIR = path.join(path.dirname(require.resolve("dejavu-fonts-ttf/package.json")), "ttf");
// DejaVu covers Latin, Cyrillic, Greek and more; the PDF standard fonts cover Latin only.
const FONTS = {
  regular: path.join(FONT_DIR, "DejaVuSans.ttf"),
  bold: path.join(FONT_DIR, "DejaVuSans-Bold.ttf"),
  oblique: path.join(FONT_DIR, "DejaVuSans-Oblique.ttf"),
};

// Bundling CJK/Arabic-complete fonts would add tens of MB; instead, detect text
// the font can't draw and say so rather than printing empty boxes.
const regularFace = fontkit.openSync(FONTS.regular) as fontkit.Font;
function drawable(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0x20 && !regularFace.hasGlyphForCodePoint(cp)) return false;
  }
  return true;
}
const safe = (text: string, fallback: string) => (drawable(text) ? text : fallback);

export const MAX_REPORT_LANGS = 8;
const MAX_CAVEAT_LINES = 9;

export interface ReportInput {
  topic: { qid: string; label: string; description: string };
  range: { from: string; to: string };
  question?: string;
  summary: string;
  chartSvg: string;
  langs: Record<string, LangAnalysis & { title: string }>;
  missingLangs: string[];
  analysisFile: string;
}

const PAGE = { width: 595.28, height: 841.89, margin: 40 };
const INK = "#1a1a1a";
const MUTED = "#666666";
const RULE = "#dddddd";

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
export function langName(code: string): string {
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
}

const pct = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}%`);
const num = (x: number) => x.toLocaleString("en-US");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function renderReport(input: ReportInput, outFile: string): Promise<void> {
  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE.margin,
    info: { Title: `Wikipedia interest: ${input.topic.label}`, Creator: "wiki-interest skill" },
  });
  doc.registerFont("regular", FONTS.regular);
  doc.registerFont("bold", FONTS.bold);
  doc.registerFont("oblique", FONTS.oblique);

  const done = new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(outFile);
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.pipe(stream);
  });

  const left = PAGE.margin;
  const width = PAGE.width - 2 * PAGE.margin;
  const langCodes = Object.keys(input.langs);

  // Header
  doc.font("bold").fontSize(17).fillColor(INK).text(`Wikipedia interest: ${cap(input.topic.label)}`, left, PAGE.margin, { width });
  doc.moveDown(0.2);
  doc.font("regular").fontSize(8.5).fillColor(MUTED).text(
    `${langCodes.map((l) => `${langName(l)} (${l})`).join(" · ")}   |   ${input.range.from} to ${input.range.to}   |   ` +
      `Wikidata ${input.topic.qid}: ${input.topic.description}`,
    { width },
  );
  if (input.question) {
    doc.moveDown(0.5);
    doc.font("oblique").fontSize(9).fillColor(INK).text(`Question: ${safe(input.question, "(not shown: script not supported by the report font)")}`, { width });
  }

  // Answer box: the agent's summary (numbers already checked against the analysis)
  doc.moveDown(0.7);
  const boxTop = doc.y;
  const pad = 9;
  if (!drawable(input.summary)) {
    throw new Error("The summary contains characters the report font cannot draw. Write the summary in English.");
  }
  doc.font("regular").fontSize(10.5);
  const textHeight = doc.heightOfString(input.summary, { width: width - 2 * pad, lineGap: 2 });
  doc.rect(left, boxTop, width, textHeight + 2 * pad + 12).fill("#f3f6fa");
  doc.rect(left, boxTop, 3, textHeight + 2 * pad + 12).fill("#0072B2");
  doc.font("bold").fontSize(7.5).fillColor("#0072B2").text("ANSWER", left + pad, boxTop + pad - 2);
  doc.font("regular").fontSize(10.5).fillColor(INK).text(input.summary, left + pad, boxTop + pad + 10, { width: width - 2 * pad, lineGap: 2 });
  doc.y = boxTop + textHeight + 2 * pad + 12;

  // Chart
  doc.moveDown(0.9);
  doc.font("bold").fontSize(10).fillColor(INK).text("Monthly interest, normalized by the size of each language edition", left);
  doc.font("regular").fontSize(7.5).fillColor(MUTED).text("Shaded: the most recent 12 months, compared with the 12 before them.", left);
  const chartTop = doc.y + 4;
  const chartHeight = 250;
  SVGtoPDF(doc, input.chartSvg, left, chartTop, {
    width,
    height: chartHeight,
    preserveAspectRatio: "xMinYMin meet",
    fontCallback: (family: string, bold: boolean) =>
      family.includes(CHART_FONT) || family.includes("sans") ? (bold ? "bold" : "regular") : "regular",
  });
  doc.y = chartTop + chartHeight + 6;

  // Table
  const cols = [
    { title: "Language / article", width: 150, align: "left" as const },
    { title: "Views/month", width: 58, align: "right" as const },
    { title: "Per million", width: 52, align: "right" as const },
    { title: "Change YoY", width: 55, align: "right" as const },
    { title: "Share change", width: 58, align: "right" as const },
    { title: "Direction", width: 70, align: "left" as const },
    { title: "Confidence", width: width - 443, align: "left" as const },
  ];
  const row = (cells: string[], font: string, color: string, size: number) => {
    const y = doc.y;
    let x = left;
    let height = 0;
    cells.forEach((cell, i) => {
      const col = cols[i]!;
      doc.font(font).fontSize(size).fillColor(color);
      const opts = { width: col.width - 6, align: col.align };
      doc.text(cell, x + (col.align === "right" ? 0 : 3), y, opts);
      height = Math.max(height, doc.heightOfString(cell, opts));
      x += col.width;
    });
    doc.y = y + height + 4;
    doc.moveTo(left, doc.y - 2).lineTo(left + width, doc.y - 2).lineWidth(0.5).strokeColor(RULE).stroke();
  };
  doc.moveDown(0.3);
  row(cols.map((c) => c.title), "bold", MUTED, 7.5);
  for (const [code, r] of Object.entries(input.langs)) {
    row(
      [
        `${langName(code)}: ${safe(r.title, "(title in a script this font can't show)")}`,
        num(r.avgMonthlyViews),
        String(r.viewsPerMillion),
        pct(r.change),
        pct(r.shareChange),
        cap(r.direction),
        cap(r.confidence),
      ],
      "regular",
      INK,
      8.5,
    );
  }
  if (input.missingLangs.length) {
    doc.font("oblique").fontSize(8).fillColor(MUTED).text(
      `No article on this topic in: ${input.missingLangs.map((l) => `${langName(l)} (${l})`).join(", ")}. Low coverage there, which is itself a signal.`,
      left,
      doc.y + 2,
      { width },
    );
  }

  // Caveats, capped so the page never overflows
  const caveats = Object.entries(input.langs).flatMap(([code, r]) => r.caveats.map((c) => `${langName(code)}: ${c}`));
  if (caveats.length) {
    doc.moveDown(0.8);
    doc.font("bold").fontSize(9).fillColor(INK).text("Why confidence is not higher", left);
    doc.font("regular").fontSize(7.8).fillColor(INK);
    const shown = caveats.slice(0, MAX_CAVEAT_LINES);
    for (const c of shown) doc.text(`•  ${c}`, left, doc.y + 1.5, { width });
    if (caveats.length > shown.length) {
      doc.fillColor(MUTED).text(`…and ${caveats.length - shown.length} more in ${path.basename(input.analysisFile)}`, left, doc.y + 1.5, { width });
    }
  }

  // Footer: method and source, pinned to the bottom of the page
  const footer =
    "Method: human pageviews (bots excluded) of the article linked to the same Wikidata item in each language. " +
    "Change = last 12 months vs the 12 before (cancels seasonality). Share change = the same, as a share of all views in that " +
    "language edition (removes Wikipedia-wide traffic shifts). Per million = article views per million edition views. " +
    "Limits: pageviews reflect curiosity, not willingness to pay; one article stands in for a topic; a language is not a country. " +
    "Source: Wikimedia Pageviews API, Wikidata.";
  doc.font("regular").fontSize(6.8);
  const footerHeight = doc.heightOfString(footer, { width });
  const footerTop = PAGE.height - PAGE.margin - footerHeight;
  if (doc.y > footerTop - 6) {
    throw new Error("Report content does not fit one page; shorten the summary or question.");
  }
  doc.moveTo(left, footerTop - 5).lineTo(left + width, footerTop - 5).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.fillColor(MUTED).text(footer, left, footerTop, { width, lineBreak: true });

  doc.end();
  return done;
}
