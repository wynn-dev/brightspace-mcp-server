import type { D2LApiClient } from "../api/index.js";
import { getAllObjectListPages } from "../api/index.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { readSource, recordLimit } from "../utils/read-status.js";

/** API boundary helpers. Only explicitly selected fields leave the service layer. */
export type Row = Record<string, unknown>;
export const object = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
export const rows = (v: unknown): Row[] => Array.isArray(v) ? v.map(object) : [];
export const str = (v: unknown): string | null => typeof v === "string" ? v : null;
export const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
export function id(v: unknown): number | null {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}
export function richText(v: unknown): string {
  if (typeof v === "string") return v;
  const r = object(v);
  if (r.IsDisplayed === false) return "";
  return typeof r.Html === "string" && r.Html ? convertHtmlToMarkdown(r.Html).markdown :
    r.Text !== undefined ? richText(r.Text) : "";
}
export async function readList(api: D2LApiClient, path: string, maxItems = 500) {
  let complete = true;
  const source = await readSource(path, async () => {
    const result = await getAllObjectListPages<Row>(api, path, { ttl: 60_000, maxItems, maxPages: 10, onIncomplete: () => { complete = false; } });
    if (result.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("Invalid list entry");
    if (result.length > maxItems) { complete = false; recordLimit(`Source capped at ${maxItems} items: ${path}`); }
    return result.slice(0, maxItems);
  });
  return { ...source, complete: complete && source.status === "available" };
}
export function readObject(api: D2LApiClient, path: string) {
  return readSource(path, async () => {
    const value = await api.get<unknown>(path, { ttl: 60_000 });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object response");
    return object(value);
  });
}
export function page<T>(items: T[], offset: number, limit: number) {
  return { items: items.slice(offset, offset + limit), offset,
    nextOffset: offset + limit < items.length ? offset + limit : null, matchedCount: items.length };
}
