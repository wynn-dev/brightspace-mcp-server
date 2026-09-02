import { vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, type D2LApiClient } from "../../src/api/index.js";
import type { RegisterTool } from "../../src/tools/define-tool.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * Shared fixtures for tool tests. Not a test file (vitest only collects
 * tests/**\/*.test.ts).
 */

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: "https://brightspace.example.edu",
    sessionDir: "/tmp/does-not-matter",
    tokenTtl: 3600,
    headless: true,
    courseFilter: { activeOnly: true },
    ...overrides,
  } as AppConfig;
}

/** A route value is the canned response, or a function of the requested path (may throw). */
export type Route = unknown | ((path: string) => unknown);

/**
 * Fake D2LApiClient. `get()` records every path in `requested` and answers
 * with the matching route: a key the path ends with wins, otherwise the
 * longest key contained in the path. Unmatched paths reject with a 404
 * ApiError, like the real client would.
 */
export function fakeApiClient(
  routes: Record<string, Route> = {},
  options: { getRaw?: (path: string) => Promise<unknown> } = {}
) {
  const requested: string[] = [];

  const resolve = async (path: string): Promise<unknown> => {
    requested.push(path);
    const candidates = Object.keys(routes).filter((k) => path.includes(k));
    const key =
      candidates.find((k) => path.endsWith(k)) ??
      candidates.sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new ApiError(404, path, "no fake route");
    const value = routes[key];
    return typeof value === "function" ? (value as (p: string) => unknown)(path) : value;
  };

  return {
    requested,
    lp: (p: string) => `/d2l/api/lp/1.0${p}`,
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    leGlobal: (p: string) => `/d2l/api/le/1.0${p}`,
    get: vi.fn(resolve),
    getRaw: vi.fn(
      options.getRaw ??
        (async (path: string) => {
          throw new ApiError(404, path, "no fake raw route");
        })
    ),
  };
}

export type FakeApiClient = ReturnType<typeof fakeApiClient>;

/** Register a tool against a fake server and return a way to call its handler directly. */
export function captureTool(
  register: RegisterTool,
  apiClient: FakeApiClient,
  config: AppConfig = makeConfig()
) {
  let handler: ((args: unknown) => Promise<CallToolResult>) | undefined;
  const server = {
    registerTool: (
      _name: string,
      _meta: unknown,
      fn: (args: unknown) => Promise<CallToolResult>
    ) => {
      handler = fn;
    },
  };
  register(server as unknown as McpServer, apiClient as unknown as D2LApiClient, config);
  if (!handler) throw new Error("tool did not call server.registerTool");
  const call = handler;
  return { call: (args: unknown = {}) => call(args) };
}

export const text = (result: CallToolResult): string =>
  (result.content[0] as { text: string }).text;

export const parse = (result: CallToolResult) => JSON.parse(text(result));

/** A D2L myenrollments item. */
export function enrollment(
  id: number,
  name: string,
  overrides: { isActive?: boolean; role?: string } = {}
) {
  return {
    OrgUnit: { Id: id, Name: name, Code: `CODE-${id}` },
    Access: {
      ClasslistRoleName: overrides.role ?? "Regular Student",
      IsActive: overrides.isActive ?? true,
      LastAccessed: null,
    },
  };
}

export function enrollmentsPage<T>(items: T[], bookmark?: string) {
  return {
    Items: items,
    PagingInfo: { HasMoreItems: bookmark !== undefined, Bookmark: bookmark },
  };
}

export function objectPage<T>(objects: T[], next?: string) {
  return { Objects: objects, Next: next ?? null };
}

/** Minimal fetch Response stand-in for getRaw fakes. */
export function fakeResponse(body: Buffer | string, headers: Record<string, string> = {}, ok = true) {
  const buffer = typeof body === "string" ? Buffer.from(body) : body;
  return {
    ok,
    status: ok ? 200 : 500,
    headers: new Headers(headers),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}
