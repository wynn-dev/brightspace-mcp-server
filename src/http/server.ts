/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../utils/logger.js";

export const MCP_PATH = "/mcp";
const HEALTH_PATH = "/healthz";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60_000;

export interface HttpServerOptions {
  host: string;
  /** 0 picks an ephemeral port (tests). */
  port: number;
  /**
   * Static bearer token every /mcp request must carry. Optional only when
   * binding to a loopback address; mandatory everywhere else because the
   * server exposes one person's full Brightspace session.
   */
  authToken?: string;
  /**
   * Host header allow-list for DNS-rebinding protection (values are
   * "host:port" as browsers send them). Defaults to the loopback names when
   * bound to loopback; empty (protection off) otherwise.
   */
  allowedHosts?: string[];
  allowedOrigins?: string[];
  /** Sessions with no traffic for this long are closed. Default 30 minutes. */
  sessionIdleTimeoutMs?: number;
  /** Builds the McpServer backing one session. */
  createServer: () => McpServer;
}

export interface RunningHttpServer {
  host: string;
  port: number;
  url: string;
  sessionCount(): number;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "::1" || bare.startsWith("127.");
}

function loopbackHosts(port: number): string[] {
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text.length === 0 ? undefined : JSON.parse(text);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Serve MCP over Streamable HTTP (single /mcp endpoint; POST for messages,
 * GET for the server→client stream, DELETE to end a session). Each session
 * gets its own McpServer + transport; the caller shares heavy dependencies
 * (API client, token store) through createServer.
 */
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const loopback = isLoopbackHost(options.host);
  if (!options.authToken && !loopback) {
    throw new Error(
      `Refusing to bind ${options.host} without MCP_AUTH_TOKEN — the server exposes your Brightspace session. ` +
        "Set MCP_AUTH_TOKEN, or bind to 127.0.0.1."
    );
  }

  const sessions = new Map<string, Session>();
  const idleTimeoutMs = options.sessionIdleTimeoutMs ?? 30 * 60_000;
  let allowedHosts: string[] = options.allowedHosts ?? [];
  const allowedOrigins = options.allowedOrigins ?? [];

  const authorize = (req: IncomingMessage): boolean => {
    if (!options.authToken) return true;
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (!match) return false;
    const provided = Buffer.from(match[1]);
    const expected = Buffer.from(options.authToken);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };

  const createSession = async (): Promise<Session> => {
    const server = options.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: allowedHosts.length > 0 || allowedOrigins.length > 0,
      allowedHosts,
      allowedOrigins,
      onsessioninitialized: (id) => {
        sessions.set(id, session);
        log("INFO", `MCP session started (${sessions.size} active)`);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        log("INFO", `MCP session ended (${sessions.size} active)`);
      },
    });
    const session: Session = { transport, server, lastActivity: Date.now() };
    await server.connect(transport);
    return session;
  };

  const closeSession = async (id: string, reason: string): Promise<void> => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    log("INFO", `Closing MCP session (${reason}, ${sessions.size} active)`);
    try {
      await session.transport.close();
    } catch (error) {
      log("DEBUG", "Session transport close failed", error);
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === HEALTH_PATH && req.method === "GET") {
      sendJson(res, 200, { status: "ok", sessions: sessions.size });
      return;
    }
    if (url.pathname !== MCP_PATH) {
      sendJson(res, 404, jsonRpcError(-32000, "Not found"));
      return;
    }
    if (!authorize(req)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="brightspace-mcp"');
      sendJson(res, 401, jsonRpcError(-32001, "Unauthorized"));
      return;
    }

    const sessionId = headerValue(req, "mcp-session-id");
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) existing.lastActivity = Date.now();

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, jsonRpcError(-32700, `Parse error: ${(error as Error).message}`));
        return;
      }

      if (sessionId) {
        if (!existing) {
          sendJson(res, 404, jsonRpcError(-32001, "Session not found"));
          return;
        }
        await existing.transport.handleRequest(req, res, body);
        return;
      }

      if (!isInitializeRequest(body)) {
        sendJson(
          res,
          400,
          jsonRpcError(-32000, "Bad Request: no valid session ID; send an initialize request first")
        );
        return;
      }

      const session = await createSession();
      await session.transport.handleRequest(req, res, body);
      return;
    }

    // GET opens the server→client event stream; DELETE ends the session.
    if (!existing) {
      sendJson(res, 404, jsonRpcError(-32001, "Session not found"));
      return;
    }
    await existing.transport.handleRequest(req, res);
  };

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((error) => {
      log("ERROR", "Unhandled error while serving MCP request", error);
      if (!res.headersSent) {
        sendJson(res, 500, jsonRpcError(-32603, "Internal server error"));
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  if (!options.allowedHosts && loopback) allowedHosts = loopbackHosts(port);

  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const [id, session] of sessions) {
      if (session.lastActivity < cutoff) void closeSession(id, "idle timeout");
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  const urlHost = options.host.includes(":") ? `[${options.host}]` : options.host;

  return {
    host: options.host,
    port,
    url: `http://${urlHost}:${port}${MCP_PATH}`,
    sessionCount: () => sessions.size,
    close: async () => {
      clearInterval(sweep);
      await Promise.allSettled([...sessions.keys()].map((id) => closeSession(id, "server shutdown")));
      const closed = new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve()))
      );
      httpServer.closeAllConnections();
      await closed;
    },
  };
}
