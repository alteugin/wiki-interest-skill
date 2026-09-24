import { cached, HOUR } from "./cache.ts";
import { getJson } from "./http.ts";

const API = "https://wikimedia.org/api/rest_v1/metrics/pageviews";

// Per-article data starts in July 2015 (older data uses a different methodology).
export const EARLIEST_MONTH = "2015-07";

export type Granularity = "monthly" | "daily";

export interface Point {
  /** "YYYY-MM" for monthly, "YYYY-MM-DD" for daily. */
  period: string;
  /** null = the API has no row for this period (article didn't exist or had ~0 views). */
  views: number | null;
}

interface RawResponse {
  items: { timestamp: string; views: number }[];
}

const pad = (n: number) => String(n).padStart(2, "0");

function parseMonth(month: string): { y: number; m: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`Expected YYYY-MM, got "${month}"`);
  return { y: Number(match[1]), m: Number(match[2]) };
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Every period between two months (inclusive) at the given granularity. */
export function periodsBetween(from: string, to: string, granularity: Granularity): string[] {
  const start = parseMonth(from);
  const end = parseMonth(to);
  const out: string[] = [];
  for (let y = start.y, m = start.m; y < end.y || (y === end.y && m <= end.m); m === 12 ? (y++, m = 1) : m++) {
    if (granularity === "monthly") out.push(`${y}-${pad(m)}`);
    else for (let d = 1; d <= lastDayOfMonth(y, m); d++) out.push(`${y}-${pad(m)}-${pad(d)}`);
  }
  return out;
}

/** The last N fully completed months, e.g. on 2026-09-24 with n=24 -> 2024-09..2026-08. */
export function lastCompleteMonths(n: number, now = new Date()): { from: string; to: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (n - 1), 1));
  const fmt = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  return { from: fmt(start), to: fmt(end) };
}

function rangeParams(from: string, to: string): { start: string; end: string; endDate: Date } {
  const s = parseMonth(from);
  const e = parseMonth(to);
  const lastDay = lastDayOfMonth(e.y, e.m);
  return {
    start: `${s.y}${pad(s.m)}0100`,
    end: `${e.y}${pad(e.m)}${pad(lastDay)}00`,
    endDate: new Date(Date.UTC(e.y, e.m - 1, lastDay)),
  };
}

function toPeriod(timestamp: string, granularity: Granularity): string {
  const y = timestamp.slice(0, 4), m = timestamp.slice(4, 6), d = timestamp.slice(6, 8);
  return granularity === "monthly" ? `${y}-${m}` : `${y}-${m}-${d}`;
}

async function fetchSeries(url: string, from: string, to: string, granularity: Granularity): Promise<Point[]> {
  const { endDate } = rangeParams(from, to);
  // Closed periods never change, so cache them forever; data is published with
  // a ~1 day lag, so anything touching the last few days gets a short TTL.
  const settled = Date.now() - endDate.getTime() > 3 * 24 * HOUR;
  const raw = await cached(url, settled ? null : 6 * HOUR, () => getJson<RawResponse>(url));

  const byPeriod = new Map<string, number>();
  for (const item of raw?.items ?? []) byPeriod.set(toPeriod(item.timestamp, granularity), item.views);
  return periodsBetween(from, to, granularity).map((period) => ({
    period,
    views: byPeriod.get(period) ?? null,
  }));
}

function project(lang: string): string {
  return `${lang}.wikipedia`;
}

/** Human (agent=user) views of one article; bots and automated crawlers excluded. */
export function articleViews(lang: string, title: string, from: string, to: string, granularity: Granularity): Promise<Point[]> {
  const { start, end } = rangeParams(from, to);
  const article = encodeURIComponent(title.replace(/ /g, "_"));
  const url = `${API}/per-article/${project(lang)}/all-access/user/${article}/${granularity}/${start}/${end}`;
  return fetchSeries(url, from, to, granularity);
}

/** Human views of the whole language edition: the baseline for normalizing article trends. */
export function projectViews(lang: string, from: string, to: string, granularity: Granularity): Promise<Point[]> {
  const { start, end } = rangeParams(from, to);
  const url = `${API}/aggregate/${project(lang)}/all-access/user/${granularity}/${start}/${end}`;
  return fetchSeries(url, from, to, granularity);
}
