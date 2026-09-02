import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer, type RunningHttpServer } from "../../src/http/server.js";
import { createMcpServer } from "../../src/server.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * End-to-end tests for the Streamable HTTP transport, driven by the SDK's
 * own HTTP client so the wire format is the real thing. Brightspace itself
 * is stubbed at the API-client boundary.
 */

const TOKEN = "test-secret-token";

const config = {
  baseUrl: "https://brightspace.example.edu",
  sessionDir: "/tmp/nope",
  tokenTtl: 3600,
  headless: true,
  courseFilter: { activeOnly: true },
} as AppConfig;

const apiClient = {
  lp: (p: string) => `/d2l/api/lp/1.0${p}`,
  le: (p: string) => `/d2l/api/le/1.0${p}`,
  get: vi.fn(async () => ({
    Items: [
      {
        OrgUnit: { Id: 43105, Name: "Bachelor Computer Science", Code: "B+TI" },
        Access: { ClasslistRoleName: "Regular Student", IsActive: true, LastAccessed: null },
      },
    ],
  })),
};

const tokenManager = {
  getToken: vi.fn(async () => ({
    accessToken: "token",
    capturedAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    source: "browser" as const,
  })),
};

const authRunner = { run: vi.fn(async () => true) };

const makeServer = () =>
  createMcpServer({
    apiClient: apiClient as any,
    tokenManager,
    authRunner,
    config,
    version: "0.0.0-test",
    includeDownloadFile: false,
  });

/** Raw HTTP helper (node:http, so we can set forbidden headers like Host). */
function raw(
  running: RunningHttpServer,
  init: { method: string; path?: string; headers?: Record<string, string>; body?: unknown }
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: running.port,
        method: init.method,
        path: init.path ?? "/mcp",
        headers: {
          Accept: "application/json, text/event-stream",
          ...(payload ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          })
        );
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "raw", version: "0" },
  },
};

async function connect(running: RunningHttpServer, token: string | undefined = TOKEN) {
  const transport = new StreamableHTTPClientTransport(new URL(running.url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("Streamable HTTP MCP server", () => {
  let running: RunningHttpServer;

  beforeAll(async () => {
    running = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      authToken: TOKEN,
      createServer: makeServer,
    });
  });

  afterAll(async () => {
    await running.close();
  });

  describe("authentication", () => {
    it("rejects requests without a bearer token", async () => {
      const res = await raw(running, { method: "POST", body: INITIALIZE });
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toMatch(/^Bearer/);
      expect(running.sessionCount()).toBe(0);
    });

    it("rejects a wrong bearer token", async () => {
      const res = await raw(running, {
        method: "POST",
        headers: { Authorization: "Bearer nope" },
        body: INITIALIZE,
      });
      expect(res.status).toBe(401);
    });

    it("serves the health check without auth", async () => {
      const res = await raw(running, { method: "GET", path: "/healthz" });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).status).toBe("ok");
    });

    it("refuses to start on a non-loopback address without a token", async () => {
      await expect(
        startHttpServer({ host: "0.0.0.0", port: 0, createServer: makeServer })
      ).rejects.toThrow(/MCP_AUTH_TOKEN/);
    });
  });

  describe("MCP over HTTP", () => {
    it("initializes a session and exposes only read-only tools (no download_file)", async () => {
      const { client, transport } = await connect(running);
      try {
        expect(transport.sessionId).toBeTruthy();
        expect(running.sessionCount()).toBe(1);

        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        expect(names).toHaveLength(11);
        expect(names).toContain("get_my_courses");
        expect(names).toContain("check_auth");
        expect(names).not.toContain("download_file");
        for (const tool of tools) {
          expect(tool.annotations?.readOnlyHint, `${tool.name} should be readOnlyHint`).toBe(true);
        }
      } finally {
        await transport.terminateSession();
        await client.close();
      }
    });

    it("calls tools end-to-end through the transport", async () => {
      const { client, transport } = await connect(running);
      try {
        const courses = await client.callTool({ name: "get_my_courses", arguments: {} });
        const text = (courses.content as Array<{ type: string; text: string }>)[0].text;
        expect(JSON.parse(text)).toEqual([
          expect.objectContaining({ id: 43105, code: "B+TI", role: "Regular Student" }),
        ]);

        const auth = await client.callTool({ name: "check_auth", arguments: {} });
        const authText = (auth.content as Array<{ type: string; text: string }>)[0].text;
        expect(authText).toMatch(/^Authenticated with Brightspace/);
      } finally {
        await transport.terminateSession();
        await client.close();
      }
    });

    it("ends the session on DELETE so its id stops resolving", async () => {
      const { client, transport } = await connect(running);
      const id = transport.sessionId!;
      expect(running.sessionCount()).toBe(1);

      await transport.terminateSession();
      await client.close();
      expect(running.sessionCount()).toBe(0);

      const res = await raw(running, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Mcp-Session-Id": id },
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for an unknown session id", async () => {
      const res = await raw(running, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Mcp-Session-Id": "does-not-exist" },
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for a non-initialize request without a session", async () => {
      const res = await raw(running, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      });
      expect(res.status).toBe(400);
      expect(running.sessionCount()).toBe(0);
    });

    it("returns 400 on malformed JSON", async () => {
      const res = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: running.port,
            method: "POST",
            path: "/mcp",
            headers: {
              Authorization: `Bearer ${TOKEN}`,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (r) => {
            r.resume();
            r.on("end", () => resolve(r.statusCode ?? 0));
          }
        );
        req.on("error", reject);
        req.end("{not json");
      });
      expect(res).toBe(400);
    });

    it("blocks DNS-rebinding style requests with a foreign Host header", async () => {
      const res = await raw(running, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, Host: "evil.example:80" },
        body: INITIALIZE,
      });
      expect(res.status).toBe(403);
      expect(running.sessionCount()).toBe(0);
    });
  });

  describe("shutdown", () => {
    it("closes live sessions when the server closes", async () => {
      const server = await startHttpServer({
        host: "127.0.0.1",
        port: 0,
        authToken: TOKEN,
        createServer: makeServer,
      });
      const { client } = await connect(server);
      expect(server.sessionCount()).toBe(1);

      await server.close();
      expect(server.sessionCount()).toBe(0);
      await client.close().catch(() => {});
    });
  });
});
