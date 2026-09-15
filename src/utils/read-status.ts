import { AsyncLocalStorage } from "node:async_hooks";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError } from "../api/errors.js";

export type ReadState = "available" | "forbidden" | "not_found" | "error";
export interface SourceRead {
  source: string;
  status: ReadState;
  fetchedAt: string | null;
  cached: boolean;
}
interface Trace { startedAt: string; sources: Map<string, SourceRead>; limits: Set<string>; requests: number }
const storage = new AsyncLocalStorage<Trace>();

export function errorState(error: unknown): ReadState {
  return error instanceof ApiError ? error.status === 403 ? "forbidden" : error.status === 404 ? "not_found" : "error" : "error";
}

export function recordRead(source: string, status: ReadState, fetchedAt: string | null = null, cached = false, onlyIfMissing = false): void {
  const trace = storage.getStore();
  if (!trace || (onlyIfMissing && trace.sources.has(source))) return;
  trace.sources.set(source, { source, status, fetchedAt, cached });
}

/** Bound aggregate fan-out, including sources that do not paginate. */
export function countRead(): void {
  const trace = storage.getStore();
  if (trace && ++trace.requests > 200) {
    trace.limits.add("Request budget exhausted at 200 reads; narrow the course or source filters");
    throw new Error("Read request budget exhausted");
  }
}
export function hasReadLimits(): boolean { return (storage.getStore()?.limits.size ?? 0) > 0; }

export function recordLimit(message: string): void { storage.getStore()?.limits.add(message); }

/** Failed reads carry an explicit status, never an empty success. */
export async function readSource<T>(source: string, fn: () => Promise<T>): Promise<{ status: ReadState; data: T | null }> {
  try {
    const data = await fn();
    recordRead(source, "available", new Date().toISOString(), false, true);
    return { status: "available", data };
  } catch (error) {
    const status = errorState(error);
    recordRead(source, status);
    return { status, data: null };
  }
}

/** Keep the established first content block; metadata is also readable by text-only clients. */
export async function withReadStatus(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  const trace: Trace = { startedAt: new Date().toISOString(), sources: new Map(), limits: new Set(), requests: 0 };
  return storage.run(trace, async () => {
    const result = await fn();
    const sources = [...trace.sources.values()];
    const readStatus = {
      requestedAt: trace.startedAt,
      completedAt: new Date().toISOString(),
      partial: result.isError === true || sources.some((s) => s.status !== "available") || trace.limits.size > 0,
      sources,
      limits: [...trace.limits],
    };
    return {
      ...result,
      structuredContent: { ...result.structuredContent, readStatus },
      content: [...result.content, { type: "text", text: JSON.stringify({ readStatus }) }],
    };
  });
}
