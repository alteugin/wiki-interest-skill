import { cached, DAY } from "./cache.ts";
import { getJson } from "./http.ts";

const API = "https://www.wikidata.org/w/api.php";

export interface Article {
  title: string;
  url: string;
}

export interface Candidate {
  qid: string;
  label: string;
  description: string;
  /** Number of Wikipedia language editions with an article: a rough notability signal. */
  wikipediaCount: number;
  /** Articles for the requested languages only. */
  articles: Record<string, Article>;
  missingLangs: string[];
}

export type ResolveResult =
  | { status: "ok"; topic: Candidate; alternatives: Candidate[] }
  | { status: "ambiguous"; candidates: Candidate[]; hint: string }
  | { status: "not_found"; hint: string };

interface RawEntity {
  id: string;
  missing?: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  sitelinks?: Record<string, { title: string }>;
}

// Language editions whose Wikidata site id breaks the "<lang>wiki" pattern.
const NON_WIKIPEDIA_SITES = new Set([
  "commonswiki", "specieswiki", "metawiki", "wikidatawiki", "mediawikiwiki",
  "sourceswiki", "incubatorwiki", "wikimaniawiki", "outreachwiki",
]);

// Pages that exist in Wikidata but are never a "topic": navigation and meta pages.
const META_DESCRIPTION = /^Wikimedia (disambiguation|category|template|project|module|help)/i;

/** Wikidata site id for a Wikipedia language code: "zh-yue" -> "zh_yuewiki". */
export function siteId(lang: string): string {
  return `${lang.replace(/-/g, "_")}wiki`;
}

export function articleUrl(lang: string, title: string): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

async function wbApi<T>(params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ format: "json", ...params });
  const url = `${API}?${qs.toString()}`;
  // Wikidata changes slowly relative to our questions; a week is plenty fresh.
  const data = await cached(url, 7 * DAY, () => getJson<T>(url));
  if (data === null) throw new Error(`Wikidata returned nothing for ${url}`);
  return data;
}

async function getEntities(qids: string[], langs: string[], uiLang: string): Promise<RawEntity[]> {
  if (qids.length === 0) return [];
  const data = await wbApi<{ entities: Record<string, RawEntity> }>({
    action: "wbgetentities",
    ids: qids.join("|"),
    props: "labels|descriptions|sitelinks",
    languages: [...new Set(["en", uiLang, ...langs])].join("|"),
  });
  // Keep the caller's order (search relevance).
  return qids.map((id) => data.entities[id]).filter((e): e is RawEntity => !!e && e.missing === undefined);
}

function toCandidate(e: RawEntity, langs: string[], uiLang: string): Candidate {
  const sitelinks = e.sitelinks ?? {};
  const articles: Record<string, Article> = {};
  const missingLangs: string[] = [];
  for (const lang of langs) {
    const link = sitelinks[siteId(lang)];
    if (link) articles[lang] = { title: link.title, url: articleUrl(lang, link.title) };
    else missingLangs.push(lang);
  }
  const wikipediaCount = Object.keys(sitelinks).filter(
    (s) => s.endsWith("wiki") && !NON_WIKIPEDIA_SITES.has(s),
  ).length;
  const pick = (m?: Record<string, { value: string }>) => m?.[uiLang]?.value ?? m?.en?.value ?? "";
  return {
    qid: e.id,
    label: pick(e.labels),
    description: pick(e.descriptions),
    wikipediaCount,
    articles,
    missingLangs,
  };
}

function isMetaPage(e: RawEntity): boolean {
  return META_DESCRIPTION.test(e.descriptions?.en?.value ?? "");
}

/** Look up a known QID directly (skips search and ambiguity checks). */
export async function resolveQid(qid: string, langs: string[], uiLang = "en"): Promise<Candidate> {
  const [entity] = await getEntities([qid], langs, uiLang);
  if (!entity) throw new Error(`Wikidata item ${qid} not found`);
  return toCandidate(entity, langs, uiLang);
}

/**
 * Free-text topic -> Wikidata item -> the article title in every requested language.
 * Titles differ per language ("Astronomy", "Астрономія", "Astronomie"), so the
 * language-independent QID is what ties them together.
 */
export async function resolveTopic(
  query: string,
  langs: string[],
  searchLang = "en",
): Promise<ResolveResult> {
  const search = await wbApi<{ search: { id: string }[] }>({
    action: "wbsearchentities",
    search: query,
    language: searchLang,
    uselang: searchLang,
    type: "item",
    limit: "8",
  });
  const ids = search.search.map((s) => s.id);
  const entities = (await getEntities(ids, langs, searchLang)).filter((e) => !isMetaPage(e));
  const candidates = entities
    .map((e) => toCandidate(e, langs, searchLang))
    .filter((c) => c.wikipediaCount > 0);

  if (candidates.length === 0) {
    return {
      status: "not_found",
      hint: `No Wikipedia-backed Wikidata item matches "${query}" in language "${searchLang}". Try an English term, a synonym, or --search-lang matching the query's language.`,
    };
  }

  // The most widely covered item is usually the general concept; a runner-up
  // with comparable coverage means the query genuinely has several meanings.
  const ranked = [...candidates].sort((a, b) => b.wikipediaCount - a.wikipediaCount);
  const [top, second] = ranked as [Candidate, Candidate | undefined];
  const ambiguous = second !== undefined && second.wikipediaCount >= top.wikipediaCount * 0.5;

  if (ambiguous) {
    return {
      status: "ambiguous",
      candidates: ranked.slice(0, 5),
      hint: "Several items fit this query. Pick the one matching the user's intent (ask if unclear) and rerun with --qid.",
    };
  }
  return { status: "ok", topic: top, alternatives: ranked.slice(1, 4) };
}
