/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { D2LApiClient } from "../api/index.js";
import type { AppConfig } from "../types/index.js";
import { sanitizeError } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

export interface ToolContext {
  apiClient: D2LApiClient;
  config: AppConfig;
}

export interface ToolDefinition<S extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  schema: S;
  /** Defaults to { readOnlyHint: true }. */
  annotations?: ToolAnnotations;
}

export type ToolBody<S extends z.ZodObject> = (
  args: z.output<S>,
  ctx: ToolContext
) => Promise<CallToolResult>;

/** Every tool registers through the same positional signature. */
export type RegisterTool = (
  server: McpServer,
  apiClient: D2LApiClient,
  config: AppConfig
) => void;

/**
 * Build a tool's register function from its metadata and a typed body.
 *
 * The wrapper owns the scaffold every tool used to repeat: the DEBUG log,
 * input parsing, and routing thrown errors through sanitizeError. Bodies
 * receive parsed args and just return a CallToolResult (returning
 * errorResponse for input problems is fine — only throws are intercepted).
 *
 * The SDK already validates inputSchema before invoking the handler, but the
 * body still gets `schema.parse(rawArgs)` so tests that call the captured
 * handler directly with raw objects see zod defaults and coercion applied.
 */
export function defineTool<S extends z.ZodObject>(
  def: ToolDefinition<S>,
  body: ToolBody<S>
): RegisterTool {
  const { name, title, description, schema, annotations = { readOnlyHint: true } } = def;

  return (server, apiClient, config) => {
    const ctx: ToolContext = { apiClient, config };

    const handler = async (rawArgs: unknown): Promise<CallToolResult> => {
      try {
        log("DEBUG", `${name} tool called`, { args: rawArgs });
        const args = schema.parse(rawArgs);
        return await body(args, ctx);
      } catch (error) {
        return sanitizeError(error);
      }
    };

    // ToolCallback<S> is a conditional type over the schema that TypeScript
    // cannot resolve while S is still generic; the cast is safe because the
    // handler accepts anything and returns a CallToolResult.
    server.registerTool(
      name,
      { title, description, inputSchema: schema, annotations },
      handler as unknown as ToolCallback<S>
    );
  };
}
