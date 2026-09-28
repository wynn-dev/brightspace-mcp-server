/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { D2LApiClient } from "../api/index.js";
import type { AppConfig } from "../types/index.js";
import { sanitizeError, errorResponse } from "./tool-helpers.js";
import { resolveCourse } from "./course-helpers.js";
import { log } from "../utils/logger.js";
import { withReadStatus } from "../utils/read-status.js";

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
export type RegisterTool = ((
  server: McpServer,
  apiClient: D2LApiClient,
  config: AppConfig
) => void) & { toolName: string };

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
const COURSE_NAME = z.string().trim().min(1).max(200)
  .describe("Course name or code (e.g. 'Reasoning' or 'CSE11A') as an alternative to courseId.");

/**
 * Tools with a courseId also accept `course` (name or code). The published
 * schema makes both optional; after resolving the name, arguments are parsed
 * with the tool's own schema, so its required fields and refinements still apply.
 */
function withCourseName(schema: z.ZodObject): z.ZodObject {
  const courseId = schema.shape.courseId as z.ZodType | undefined;
  if (!courseId) return schema;
  const augmented = z.object({ ...schema.shape, courseId: courseId.optional(), course: COURSE_NAME.optional() });
  // Keep strict schemas strict, so unknown arguments are still rejected rather than stripped.
  const catchall = schema._zod.def.catchall;
  return catchall ? augmented.catchall(catchall) : augmented;
}

export function defineTool<S extends z.ZodObject>(
  def: ToolDefinition<S>,
  body: ToolBody<S>
): RegisterTool {
  const { name, title, description, schema, annotations = { readOnlyHint: true } } = def;
  const inputSchema = withCourseName(schema);
  const courseRequired = inputSchema !== schema && !(schema.shape.courseId as z.ZodType).isOptional();

  return Object.assign((server: McpServer, apiClient: D2LApiClient, config: AppConfig) => {
    const ctx: ToolContext = { apiClient, config };

    const handler = async (rawArgs: unknown): Promise<CallToolResult> => withReadStatus(async () => {
      try {
        log("DEBUG", `${name} tool called`, { args: rawArgs });
        let input = rawArgs;
        if (inputSchema !== schema && rawArgs && typeof rawArgs === "object") {
          const { course, ...rest } = rawArgs as Record<string, unknown>;
          input = rest;
          if (typeof course === "string" && rest.courseId === undefined) {
            const resolved = await resolveCourse(apiClient, config, course);
            if ("error" in resolved) return errorResponse(resolved.error);
            input = { ...rest, courseId: resolved.courseId };
          }
          if (courseRequired && (input as Record<string, unknown>).courseId === undefined)
            return errorResponse("Provide courseId or course (a course name or code).");
        }
        const args = schema.parse(input);
        return await body(args, ctx);
      } catch (error) {
        return sanitizeError(error);
      }
    });

    // ToolCallback<S> is a conditional type over the schema that TypeScript
    // cannot resolve while S is still generic; the cast is safe because the
    // handler accepts anything and returns a CallToolResult.
    server.registerTool(
      name,
      { title, description, inputSchema: inputSchema as S, annotations },
      handler as unknown as ToolCallback<S>
    );
  }, { toolName: name });
}
