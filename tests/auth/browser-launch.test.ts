import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { BrowserAuth } from "../../src/auth/browser-auth.js";
import { makeConfig } from "../tools/helpers.js";

vi.mock("playwright", () => ({ chromium: { launchPersistentContext: vi.fn() } }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe.skipIf(process.platform !== "linux")("automatic login on Linux", () => {
  it.each([
    ["credentials without a display", true, undefined, undefined, true],
    ["credentials with X11", true, ":1", undefined, false],
    ["credentials with Wayland", true, undefined, "wayland-0", false],
    ["manual login", false, ":1", undefined, false],
  ] as const)("launches correctly for %s", async (_name, credentials, display, wayland, expectedHeadless) => {
    vi.stubEnv("DISPLAY", display); vi.stubEnv("WAYLAND_DISPLAY", wayland);
    const dir = await mkdtemp(join(tmpdir(), "brightspace-launch-"));
    const launch = vi.mocked(chromium.launchPersistentContext).mockRejectedValue(new Error("Test stopped before browser launch"));
    try {
      const config = makeConfig({ sessionDir: dir, headless: false,
        username: credentials ? "synthetic" : undefined, password: credentials ? "synthetic" : undefined });
      await expect(new BrowserAuth(config).authenticate()).rejects.toThrow("Authentication failed");
      expect(launch).toHaveBeenLastCalledWith(join(dir, "browser-data"), expect.objectContaining({ headless: expectedHeadless }));
      expect(config.headless).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
