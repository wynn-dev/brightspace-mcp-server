/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { ApiError, RateLimitError, NetworkError } from "../api/index.js";
import { ContentReadError } from "../utils/content-reader.js";
import { log } from "../utils/logger.js";

/**
 * Structured form of a tool payload. Clients that support structuredContent
 * (e.g. claude.ai) show it instead of the text blocks, so it must carry the
 * full payload. It has to be a JSON object, so arrays are wrapped as items.
 */
export function structuredPayload(data: unknown): Record<string, unknown> {
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : { items: data };
}

/**
 * Wrap data as MCP-compatible tool result
 */
export function toolResponse(data: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        // Compact JSON: indentation costs clients 20-30% more tokens.
        text: JSON.stringify(data),
      },
    ],
    structuredContent: structuredPayload(data),
  };
}

/**
 * Wrap error message as MCP-compatible tool result
 */
export function errorResponse(message: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    structuredContent: { error: message },
    isError: true,
  };
}

/**
 * Sanitize errors for user-friendly messages
 *
 * SECURITY: Never include stack traces, raw API responses, or token values
 */
export function sanitizeError(error: unknown): CallToolResult {
  // Log full error to stderr for debugging (token redaction handled by logger)
  log("ERROR", "Tool error", error);

  if (error instanceof ContentReadError) return errorResponse(error.message);

  // Map to user-friendly messages
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return errorResponse(
        "Resource not found. The course or item may not exist, or you may not have access."
      );
    }
    if (error.status === 401) {
      return errorResponse(
        "Authentication expired. Auto-reauthentication was attempted but failed. " +
        "Please run `pnpm run auth` in the project directory, then try again."
      );
    }
    if (error.status === 403) {
      return errorResponse(
        "Access denied. You may not have permission to access this resource."
      );
    }
  }

  if (error instanceof RateLimitError) {
    return errorResponse(
      "Rate limited by Brightspace. Please wait a moment and try again."
    );
  }

  if (error instanceof NetworkError) {
    return errorResponse(
      "Could not connect to Brightspace. Check your internet connection."
    );
  }

  if (error instanceof ZodError) {
    const issues = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return errorResponse(`Invalid input: ${issues.join(", ")}`);
  }

  // Default fallback
  return errorResponse("An unexpected error occurred. Please try again.");
}
