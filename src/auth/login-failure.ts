/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { BrowserAuthError } from "../utils/errors.js";

/**
 * Why a login attempt failed, as recorded in the login circuit breaker.
 * Only "credentials" is special: it pauses automatic logins until the stored
 * credentials change. Every other kind backs off exponentially.
 */
export type LoginFailureKind = "credentials" | "interaction" | "timeout" | "sso_changed" | "other";

export const LOGIN_FAILURE_KINDS: readonly LoginFailureKind[] = [
  "credentials", "interaction", "timeout", "sso_changed", "other",
];

/** A login failure whose cause is known precisely (thrown by SSO flows and BrowserAuth). */
export class LoginFailedError extends BrowserAuthError {
  constructor(message: string, step: string, readonly kind: LoginFailureKind, cause?: Error) {
    super(message, step, cause);
    this.name = "LoginFailedError";
  }
}

/** BrowserAuthError steps that identify the failure without a structured kind. */
const STEP_KINDS: Record<string, LoginFailureKind> = {
  manual_login: "interaction",
  mfa_approval: "interaction",
  token_interception: "timeout",
};

const MAX_MESSAGE_LENGTH = 200;

/** Strip the internal error-code prefixes so the message reads as a sentence. */
function cleanMessage(message: string): string {
  const text = message
    .replace(/\[PBMCP-\d+\]\s*/g, "")
    .replace(/Browser auth failed at step "[^"]*":\s*/g, "")
    .trim();
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;
}

/**
 * Classify an error thrown by BrowserAuth.authenticate(), walking the cause
 * chain because BrowserAuth wraps most failures in a generic outer error.
 */
export function classifyLoginError(error: unknown): { kind: LoginFailureKind; message: string } {
  const outer = error instanceof Error ? error.message : String(error);
  for (let e: unknown = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    if (e instanceof LoginFailedError) return { kind: e.kind, message: cleanMessage(e.message) };
    const stepKind = e instanceof BrowserAuthError ? STEP_KINDS[e.step] : undefined;
    if (stepKind) return { kind: stepKind, message: cleanMessage(e.message) };
    if (e.name === "TimeoutError" || /timed? ?out/i.test(e.message)) {
      return { kind: "timeout", message: cleanMessage(e.message) };
    }
  }
  return { kind: "other", message: cleanMessage(outer) };
}
