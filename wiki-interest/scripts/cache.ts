import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Lives inside the skill directory so repeated and follow-up questions
// (same topic, different languages or ranges) don't refetch anything.
const CACHE_DIR = path.join(import.meta.dirname, "..", ".cache", "http");

interface Entry<T> {
  storedAt: number;
  /** null = never expires (e.g. pageviews for fully closed past periods). */
  ttlMs: number | null;
  value: T;
}

function fileFor(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return path.join(CACHE_DIR, `${hash}.json`);
}

export async function cached<T>(
  key: string,
  ttlMs: number | null,
  load: () => Promise<T>,
): Promise<T> {
  const file = fileFor(key);
  try {
    const entry = JSON.parse(await readFile(file, "utf8")) as Entry<T>;
    if (entry.ttlMs === null || Date.now() - entry.storedAt < entry.ttlMs) {
      return entry.value;
    }
  } catch {
    // Missing or corrupt entry: fall through and reload.
  }
  const value = await load();
  await mkdir(CACHE_DIR, { recursive: true });
  const entry: Entry<T> = { storedAt: Date.now(), ttlMs, value };
  await writeFile(file, JSON.stringify(entry));
  return value;
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
