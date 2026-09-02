/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { D2LApiClient } from "./client.js";
import { log } from "../utils/logger.js";

/** LP envelope (e.g. /enrollments/myenrollments/): next page via ?bookmark=. */
export interface LpPagedResult<T> {
  Items: T[];
  PagingInfo?: { HasMoreItems: boolean; Bookmark?: string | null };
}

/** LE ObjectListPage (classlist/paged, calendar myEvents, dropbox, quizzes): Next is a full URL. */
export interface ObjectListPage<T> {
  Objects: T[];
  Next?: string | null;
}

export interface PageOptions {
  ttl?: number;
  /** Hard stop on page count — every page costs one rate-limiter token. Default 20. */
  maxPages?: number;
  /** Stop fetching once at least this many items are collected (the caller trims). */
  maxItems?: number;
  /** Name used in log messages; defaults to the path. */
  label?: string;
}

const DEFAULT_MAX_PAGES = 20;

/** Only `get` is needed, which keeps test fakes tiny. */
type PagedClient = Pick<D2LApiClient, "get">;

/**
 * Append a bookmark to a path without touching its existing query string,
 * so page 1's path (and therefore its cache key) stays exactly as written.
 */
export function withBookmark(path: string, bookmark: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}bookmark=${encodeURIComponent(bookmark)}`;
}

/**
 * D2L's `Next` is an absolute URL on the LMS host, but D2LApiClient.get()
 * prepends baseUrl itself, so keep only pathname + search. This also means a
 * bad `Next` can never send our auth header to a foreign host.
 */
export function nextToPath(next: string): string {
  const url = new URL(next, "https://placeholder.invalid");
  return `${url.pathname}${url.search}`;
}

/** Several LE endpoints return either a plain array or an ObjectListPage. */
export function unwrapObjects<T>(raw: T[] | { Objects?: T[] } | null | undefined): T[] {
  if (Array.isArray(raw)) return raw;
  return raw?.Objects ?? [];
}

function warnCapped(maxPages: number, label: string): void {
  log("WARN", `Pagination: stopped after ${maxPages} pages for ${label}; results may be incomplete`);
}

/** Follow an LP bookmark chain and return every item. */
export async function getAllLpPages<T>(
  client: PagedClient,
  path: string,
  options: PageOptions = {}
): Promise<T[]> {
  const { ttl, maxPages = DEFAULT_MAX_PAGES, maxItems, label = path } = options;
  const items: T[] = [];
  let pagePath = path;

  for (let page = 1; ; page++) {
    const result = await client.get<LpPagedResult<T>>(pagePath, { ttl });
    items.push(...(result.Items ?? []));

    const bookmark = result.PagingInfo?.HasMoreItems ? result.PagingInfo.Bookmark : null;
    if (!bookmark) break;
    if (maxItems !== undefined && items.length >= maxItems) break;
    if (page >= maxPages) {
      warnCapped(maxPages, label);
      break;
    }
    pagePath = withBookmark(path, bookmark);
  }

  return items;
}

/** Follow an LE ObjectListPage `Next` chain (or accept a plain array) and return every item. */
export async function getAllObjectListPages<T>(
  client: PagedClient,
  path: string,
  options: PageOptions = {}
): Promise<T[]> {
  const { ttl, maxPages = DEFAULT_MAX_PAGES, maxItems, label = path } = options;
  const items: T[] = [];
  let pagePath = path;

  for (let page = 1; ; page++) {
    const result = await client.get<ObjectListPage<T> | T[]>(pagePath, { ttl });
    items.push(...unwrapObjects(result));

    const next = Array.isArray(result) ? null : result.Next ?? null;
    if (!next) break;
    if (maxItems !== undefined && items.length >= maxItems) break;
    if (page >= maxPages) {
      warnCapped(maxPages, label);
      break;
    }
    const nextPath = nextToPath(next);
    // Defensive: a server echoing the current page would loop until maxPages
    if (nextPath === pagePath) break;
    pagePath = nextPath;
  }

  return items;
}
