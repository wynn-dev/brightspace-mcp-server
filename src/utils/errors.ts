/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(`[PBMCP-1001] ${message}`);
    this.name = "AuthError";
  }
}

export class BrowserAuthError extends AuthError {
  constructor(
    message: string,
    public readonly step: string,
    cause?: Error,
  ) {
    super(`[PBMCP-1003] Browser auth failed at step "${step}": ${message}`, cause);
    this.name = "BrowserAuthError";
  }
}

/** True if `error` is a Node system error, optionally with the given code (e.g. "ENOENT"). */
export function isErrnoException(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    (code === undefined || (error as NodeJS.ErrnoException).code === code)
  );
}

export class SessionStoreError extends AuthError {
  constructor(message: string, cause?: Error) {
    super(`[PBMCP-1004] Session store error: ${message}`, cause);
    this.name = "SessionStoreError";
  }
}
