/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import * as fs from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isErrnoException } from "../utils/errors.js";
import { log } from "../utils/logger.js";

const LOCK_FILE = "login.lock";

/** A lock older than this is abandoned even if its owner can't be checked (other host). */
const DEFAULT_STALE_MS = 10 * 60 * 1000;
/** Grace period for a lock file whose owner hasn't finished writing it yet. */
const UNREADABLE_GRACE_MS = 5000;

export interface LoginLock {
  /** True if another process held the lock first; its login may have produced a token. */
  waited: boolean;
  release(): void;
}

interface LockOptions {
  /** How long to wait for another process's login. 0 = don't wait. */
  waitMs?: number;
  staleMs?: number;
  pollMs?: number;
}

interface LockOwner {
  pid: number;
  host: string;
  at: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error, "EPERM");
  }
}

async function readOwner(lockPath: string): Promise<{ raw: string; owner: LockOwner | null; mtimeMs: number } | null> {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(lockPath, "utf-8"), fs.stat(lockPath)]);
    let owner: LockOwner | null = null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.pid === "number" && typeof parsed?.at === "number") owner = parsed;
    } catch {
      // Being written, or garbage
    }
    return { raw, owner, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function isStale(lock: { owner: LockOwner | null; mtimeMs: number }, staleMs: number): boolean {
  const now = Date.now();
  if (!lock.owner) return now - lock.mtimeMs > UNREADABLE_GRACE_MS;
  if (now - lock.owner.at > staleMs) return true;
  return lock.owner.host === os.hostname() && !processAlive(lock.owner.pid);
}

/**
 * Exclusive cross-process lock around a browser login, so two server
 * processes sharing a session dir never drive Chromium on the same profile
 * (or submit credentials twice). Locks left by dead processes, or older than
 * staleMs, are taken over. Resolves null if the lock stayed busy for waitMs.
 * The lock is also released if the process exits without calling release().
 */
export async function acquireLoginLock(sessionDir: string, options: LockOptions = {}): Promise<LoginLock | null> {
  const { waitMs = 0, staleMs = DEFAULT_STALE_MS, pollMs = 1000 } = options;
  const lockPath = path.join(sessionDir, LOCK_FILE);
  const deadline = Date.now() + waitMs;
  let waited = false;
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });

  for (;;) {
    const content = JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() } satisfies LockOwner);
    try {
      await fs.writeFile(lockPath, content, { flag: "wx", mode: 0o600 });
      const release = () => {
        process.off("exit", release);
        try {
          if (readFileSync(lockPath, "utf-8") === content) unlinkSync(lockPath);
        } catch {
          // Already gone
        }
      };
      process.on("exit", release);
      return { waited, release };
    } catch (error) {
      if (!isErrnoException(error, "EEXIST")) throw error;
    }

    const current = await readOwner(lockPath);
    if (current && isStale(current, staleMs)) {
      // Only remove the exact lock we judged stale, not a fresh one that replaced it.
      const again = await readOwner(lockPath);
      if (again?.raw === current.raw) {
        log("WARN", `Removing stale login lock${current.owner ? ` held by pid ${current.owner.pid}` : ""}`);
        await fs.rm(lockPath, { force: true });
      }
      continue;
    }
    if (!current) continue; // Released between our attempts
    if (Date.now() >= deadline) return null;
    if (!waited) log("INFO", "Another process is logging in to Brightspace — waiting for it");
    waited = true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
