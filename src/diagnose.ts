#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";
import { loadEnvFiles } from "./utils/env.js";
import { PKG_VERSION, toolNames } from "./server.js";

loadEnvFiles();
const client = new Client({ name: "brightspace-discovery-diagnostic", version: PKG_VERSION });
const http = process.argv[2] === "--http";
const endpoint = process.argv[3] ?? (process.env.MCP_ALLOWED_HOSTS?.split(",")[0]?.trim()
  ? `https://${process.env.MCP_ALLOWED_HOSTS.split(",")[0].trim()}/mcp`
  : `http://127.0.0.1:${process.env.MCP_HTTP_PORT || "8787"}/mcp`);
let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined;
try {
  if (process.argv[2] && !http) throw new Error("Usage: pnpm run diagnose [--http [https://your-host/mcp]]");
  if (http) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
      throw new Error("Use HTTPS for remote diagnostics.");
    transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: process.env.MCP_AUTH_TOKEN ? { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } : {} },
    });
  } else {
    transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("./index.js", import.meta.url))],
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), stderr: "ignore" });
  }
  await client.connect(transport);
  const expected = toolNames(!http), actual = (await client.listTools()).tools.map(t => t.name);
  const missing = expected.filter(name => !actual.includes(name));
  const versionMismatch = client.getServerVersion()?.version !== PKG_VERSION;
  console.log(JSON.stringify({ localVersion: PKG_VERSION, runningServer: client.getServerVersion(),
    expectedCount: expected.length, advertisedCount: actual.length, missing, versionMismatch, tools: actual,
    nextStep: missing.length || versionMismatch ? "Update/build and restart the server process, then refresh/reconnect the client."
      : "Server discovery is complete. If the client shows fewer tools, refresh its tool list or reconnect the MCP connection." }, null, 2));
  if (missing.length || versionMismatch) process.exitCode = 1;
} catch (error) {
  // Do not print server response bodies or request headers, which can contain secrets.
  console.error(error instanceof Error && /^(Usage:|Use HTTPS)/.test(error.message) ? error.message :
    "Discovery failed. Check the endpoint, MCP_AUTH_TOKEN, host allow-list and whether the server is running.");
  process.exitCode = 1;
} finally {
  if (transport instanceof StreamableHTTPClientTransport) await transport.terminateSession().catch(() => {});
  await client.close().catch(() => {});
}
