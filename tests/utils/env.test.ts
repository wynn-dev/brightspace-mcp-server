import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFiles } from "../../src/utils/env.js";

const KEYS = ["BSMCP_TEST_A", "BSMCP_TEST_B", "BSMCP_TEST_C"];

describe("loadEnvFiles", () => {
  const dirs: string[] = [];

  function makeRoot(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "bsmcp-env-"));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("loads .env.local over .env, and never overrides the real environment", () => {
    process.env.BSMCP_TEST_C = "from-shell";
    const root = makeRoot({
      ".env": "BSMCP_TEST_A=env\nBSMCP_TEST_B=env\nBSMCP_TEST_C=env\n",
      ".env.local": "BSMCP_TEST_B=local\nBSMCP_TEST_C=local\n",
    });

    expect(loadEnvFiles(root)).toEqual([".env.local", ".env"]);
    expect(process.env.BSMCP_TEST_A).toBe("env");
    expect(process.env.BSMCP_TEST_B).toBe("local");
    expect(process.env.BSMCP_TEST_C).toBe("from-shell");
  });

  it("is a no-op when neither file exists", () => {
    const root = makeRoot({});
    expect(loadEnvFiles(root)).toEqual([]);
    expect(process.env.BSMCP_TEST_A).toBeUndefined();
  });
});
