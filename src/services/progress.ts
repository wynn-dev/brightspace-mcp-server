import type { D2LApiClient } from "../api/index.js";
import { readSource, type ReadState } from "../utils/read-status.js";
import { readList, num, id, type Row } from "./data.js";

/** Brightspace's own required-topic completion count for the calling user. */
export interface ContentProgress { completed: number; required: number }

/** Aggregation levels of /content/completions/mycount/ (CONTENTCOMPLETIONLEVEL_T). */
const LEVEL = { course: 1, rootModule: 2 } as const;

const count = (v: unknown): number | null => { const n = num(v); return n !== null && Number.isInteger(n) && n >= 0 ? n : null; };

function toProgress(row: Row): ContentProgress {
  const completed = count(row.CompletedItems), required = count(row.RequiredItems);
  if (completed === null || required === null) throw new Error("Invalid ContentAggregateCompletion counts");
  return { completed, required };
}

/**
 * Completed vs required topic counts, aggregated per course or per top-level module.
 * Failures carry an explicit status (403/404/malformed) and null data, never zero counts.
 */
async function readCounts<T>(api: D2LApiClient, courseId: number, level: number, map: (rows: Row[]) => T):
  Promise<{ status: ReadState; data: T | null }> {
  const path = api.le(courseId, `/content/completions/mycount/?level=${level}`);
  const list = await readList(api, path);
  if (list.status !== "available") return { status: list.status, data: null };
  // A validation failure overrides the recorded "available" read with "error".
  return readSource(path, async () => {
    if (!list.complete) throw new Error("Incomplete completion counts");
    return map(list.data ?? []);
  });
}

/** Course-level progress: exactly one aggregate row is expected. */
export function courseProgress(api: D2LApiClient, courseId: number) {
  return readCounts(api, courseId, LEVEL.course, rows => {
    if (rows.length !== 1) throw new Error("Expected one course-level completion row");
    return toProgress(rows[0]);
  });
}

/** Progress per top-level module, keyed by module ID. */
export function moduleProgress(api: D2LApiClient, courseId: number) {
  return readCounts(api, courseId, LEVEL.rootModule, rows => {
    const byModule = new Map<number, ContentProgress>();
    for (const row of rows) {
      const moduleId = id(row.ObjectId);
      if (!moduleId || byModule.has(moduleId)) throw new Error("Invalid or duplicate module completion row");
      byModule.set(moduleId, toProgress(row));
    }
    return byModule;
  });
}
