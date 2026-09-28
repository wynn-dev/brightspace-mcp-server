/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { TokenManager } from "./token-manager.js";
import type { AuthRunner } from "./auth-runner.js";
import type { LoginAttempt } from "./login-breaker.js";
import type { LoginFailureKind } from "./login-failure.js";

export type AuthState = "valid" | "expired" | "failing";

export interface AuthStatus {
  /** failing: logins are paused, or the last one failed and there is no usable token. */
  state: AuthState;
  expiresAt: number | null;
  lastLogin: LoginAttempt | null;
  /** Automatic logins are paused (circuit breaker open). */
  paused: boolean;
  /** When automatic logins resume; null if not paused or paused until credentials change. */
  retryAt: number | null;
}

export async function readAuthStatus(
  tokenManager: Pick<TokenManager, "getToken">,
  authRunner: Pick<AuthRunner, "status">
): Promise<AuthStatus> {
  const [token, breaker] = await Promise.all([tokenManager.getToken(), authRunner.status()]);
  const lastLogin = breaker.lastAttempt;
  const state: AuthState =
    breaker.open || (!token && lastLogin && !lastLogin.ok) ? "failing" : token ? "valid" : "expired";
  return {
    state,
    expiresAt: token?.expiresAt ?? null,
    lastLogin,
    paused: breaker.open,
    retryAt: breaker.open ? breaker.retryAt : null,
  };
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

/**
 * Status safe for the unauthenticated /healthz endpoint: timestamps and the
 * failure kind only — no messages, usernames or token data.
 */
export function publicAuthStatus(status: AuthStatus, now = Date.now()) {
  const { lastLogin } = status;
  return {
    state: status.state,
    expiresInMinutes: status.expiresAt === null ? null : Math.round((status.expiresAt - now) / 60000),
    lastLogin: lastLogin && { at: iso(lastLogin.at), ok: lastLogin.ok, kind: lastLogin.kind ?? null },
    retriesPaused: status.paused,
    nextRetryAt: iso(status.retryAt),
  };
}

const FAILURE_TEXT: Record<LoginFailureKind, string> = {
  credentials: "username or password rejected",
  interaction: "the login needs MFA or other manual interaction",
  timeout: "the login timed out",
  sso_changed: "the SSO login page looked different than expected (it may have changed)",
  other: "an unexpected error occurred",
};

function nextRetryText(status: AuthStatus, now: number): string {
  if (!status.paused) return "The next request will try to log in again.";
  const minutes = Math.max(1, Math.ceil(((status.retryAt ?? now) - now) / 60000));
  return `Automatic retries paused for ~${minutes} min (until ${iso(status.retryAt)}).`;
}

/**
 * Explain why Brightspace is unavailable and what happens next, e.g.
 * "Brightspace login failed: username or password rejected. Update
 * credentials on the server (pnpm run setup) — automatic retries paused."
 */
export function authFailureMessage(status: AuthStatus, now = Date.now()): string {
  const last = status.lastLogin;
  if (!last || last.ok) {
    return "Brightspace session expired and automatic re-login did not produce a token. " +
      "Run `pnpm run auth` on the server running this MCP server, then try again.";
  }
  const kind = last.kind ?? "other";
  const detail = kind === "other" || kind === "sso_changed" ? (last.message ? ` (${last.message})` : "") : "";
  const head = `Brightspace login failed: ${FAILURE_TEXT[kind]}${detail}.`;
  if (kind === "credentials") {
    return `${head} Update credentials on the server (pnpm run setup) — automatic retries paused.`;
  }
  const manual = kind === "interaction"
    ? " Run `pnpm run auth` on the server to log in by hand."
    : " Or run `pnpm run auth` on the server.";
  return `${head} ${nextRetryText(status, now)}${manual}`;
}

/** describeAuthFailure hook for D2LApiClient. */
export async function describeAuthFailure(
  tokenManager: Pick<TokenManager, "getToken">,
  authRunner: Pick<AuthRunner, "status">
): Promise<string> {
  return authFailureMessage(await readAuthStatus(tokenManager, authRunner));
}
