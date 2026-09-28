import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, utimes, access } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { acquireLoginLock } from "../../src/auth/login-lock.js";

let dir: string;
const lockFile = () => join(dir, "login.lock");
const exists = (p: string) => access(p).then(() => true, () => false);

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "login-lock-")); });
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("acquireLoginLock", () => {
  it("is exclusive until released", async () => {
    const first = await acquireLoginLock(dir);
    expect(first).toMatchObject({ waited: false });
    expect(await acquireLoginLock(dir, { waitMs: 0 })).toBeNull();
    first!.release();
    expect(await exists(lockFile())).toBe(false);
    const second = await acquireLoginLock(dir);
    expect(second).not.toBeNull();
    second!.release();
  });

  it("waits for another holder and reports that it waited", async () => {
    const holder = await acquireLoginLock(dir);
    setTimeout(() => holder!.release(), 50);
    const waiter = await acquireLoginLock(dir, { waitMs: 5000, pollMs: 10 });
    expect(waiter).toMatchObject({ waited: true });
    waiter!.release();
  });

  it("takes over a lock left by a dead process on this host", async () => {
    await writeFile(lockFile(), JSON.stringify({ pid: 99_999_999, host: hostname(), at: Date.now() }));
    const lock = await acquireLoginLock(dir, { waitMs: 0 });
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it("keeps a live holder's lock but takes over one older than the stale timeout", async () => {
    await writeFile(lockFile(), JSON.stringify({ pid: process.pid, host: "other-host", at: Date.now() }));
    expect(await acquireLoginLock(dir, { waitMs: 0 })).toBeNull();
    await writeFile(lockFile(), JSON.stringify({ pid: process.pid, host: "other-host", at: Date.now() - 60_000 }));
    const lock = await acquireLoginLock(dir, { waitMs: 0, staleMs: 30_000 });
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it("treats an unreadable lock as stale only after a grace period", async () => {
    await writeFile(lockFile(), "");
    expect(await acquireLoginLock(dir, { waitMs: 0 })).toBeNull();
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile(), old, old);
    const lock = await acquireLoginLock(dir, { waitMs: 0 });
    expect(lock).not.toBeNull();
    lock!.release();
  });
});
