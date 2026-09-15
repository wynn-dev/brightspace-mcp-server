import { beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TokenManager } from "../../src/auth/token-manager.js";
import { studentCourseFixture } from "../fixtures/student-course.js";

const root = resolve(import.meta.dirname, "../..");
beforeAll(async () => {
  // Test the current source even when build/ is absent or stale.
  await promisify(execFile)("pnpm", ["run", "build"], { cwd: root });
}, 60_000);

describe.each(["stdio", "http"] as const)("production %s entrypoint", mode => {
  it("runs every tool with nonempty data, real document parsing and GET-only LMS requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brightspace-e2e-"));
    const downloads = join(dir, "downloads"); await mkdir(downloads);
    const sessionDir = join(dir, "session");
    await new TokenManager(sessionDir).setToken({ accessToken: "synthetic-e2e-token", capturedAt: Date.now(), expiresAt: Date.now() + 3600_000, source: "browser" });
    const fixturePath = join(dir, "fixture.json"), requestsPath = join(dir, "requests.jsonl");
    await writeFile(fixturePath, JSON.stringify(studentCourseFixture()));
    const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
      D2L_BASE_URL: "https://brightspace-fixture.invalid", D2L_SESSION_DIR: sessionDir, D2L_INCLUDE_COURSES: "5", D2L_EXCLUDE_COURSES: "0",
      D2L_LOG_LEVEL: "INFO", MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: "0", MCP_AUTH_TOKEN: "e2e-http-token",
      MCP_ALLOWED_HOSTS: "", MCP_ALLOWED_ORIGINS: "", BRIGHTSPACE_E2E_FIXTURE: fixturePath, BRIGHTSPACE_E2E_REQUESTS: requestsPath };
    const args = ["--import", join(root, "tests/fixtures/brightspace-fetch.mjs"), join(root, mode === "stdio" ? "build/index.js" : "build/http-server.js")];
    const client = new Client({ name: "entrypoint-e2e", version: "1" });
    let child: ReturnType<typeof spawn> | undefined;
    let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined;
    let logs = "", httpUrl = "";
    try {
      if (mode === "stdio") {
        transport = new StdioClientTransport({ command: process.execPath, args, cwd: dir, env, stderr: "pipe" });
        transport.stderr?.on("data", c => { logs += c.toString(); });
      } else {
        child = spawn(process.execPath, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
        const url = await new Promise<string>((resolveUrl, reject) => {
          const timer = setTimeout(() => reject(new Error(`HTTP startup timed out: ${logs}`)), 15_000);
          child!.once("error", e => { clearTimeout(timer); reject(e); });
          child!.once("exit", code => { clearTimeout(timer); reject(new Error(`HTTP exited ${code}: ${logs}`)); });
          child!.stderr!.on("data", c => {
            logs += c.toString();
            const found = logs.match(/listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/);
            if (found) { clearTimeout(timer); resolveUrl(found[1]); }
          });
        });
        httpUrl = url;
        expect((await fetch(new URL("/healthz", url))).status).toBe(200);
        expect((await fetch(url, { method: "POST" })).status).toBe(401);
        transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: "Bearer e2e-http-token" } } });
      }
      await client.connect(transport);
      const listed = (await client.listTools()).tools;
      expect(listed).toHaveLength(mode === "http" ? 20 : 21);
      const called = new Set<string>();
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        called.add(name);
        const response = await client.callTool({ name, arguments: args });
        expect(response.isError, `${name}: ${JSON.stringify(response.content)}`).not.toBe(true);
        const text = (response.content as Array<{ text: string }>)[0].text;
        expect(text, name).not.toMatch(/PRIVATE_SECRET|UNRELEASED_SECRET|999/);
        if (name === "check_auth") {
          expect(text).toMatch(/^Authenticated/);
          expect(response.structuredContent?.tools).toEqual(expect.arrayContaining(listed.map(t => t.name)));
          expect(response.structuredContent?.transport).toBe(mode);
          return null;
        }
        expect(response.structuredContent?.readStatus, name).toMatchObject({ partial: false });
        return JSON.parse(text);
      };
      await call("check_auth");
      expect(await call("get_my_courses", { includeDetails: true })).toMatchObject([{ id: 5, name: "Matrix methods" }]);
      expect(JSON.stringify(await call("get_my_grades", { courseId: 5 }))).toContain("80%");
      expect(JSON.stringify(await call("get_announcements", { courseId: 5 }))).toContain("Matrix news");
      expect((await call("get_assignments", { courseId: 5 })).assignments).toMatchObject([
        { id: 1, state: "submitted", personalDatesVerified: true }, { id: 2, state: "in_progress", attemptsUsed: 2, bestScore: 8, personalDatesVerified: true },
      ]);
      const history = await call("get_submission_history", { courseId: 5, folderId: 1 });
      expect(history.items).toHaveLength(2); expect(history.latestSubmission.id).toBe(11);
      expect(history.feedback[0]).toMatchObject({ score: 8, rubricAssessments: [{ RubricId: 4 }] });
      const work = await call("get_my_work", { courseId: 5 });
      expect(work.items).toContainEqual(expect.objectContaining({ type: "quiz", state: "in_progress" }));
      expect(work.items.some((i: any) => i.type === "assignment")).toBe(false);
      expect((await call("get_grade_summary", { courseId: 5, scenarios: [{ gradeItemId: 1, points: 9 }] })).calculation).toMatchObject({ status: "calculated", percentage: 90 });
      const start = new Date(Date.now() - 7 * 86400000).toISOString(), end = new Date(Date.now() + 7 * 86400000).toISOString();
      const calendar = await call("get_calendar", { courseId: 5, start, end, timeZone: "Europe/Berlin" });
      expect(calendar.recurrenceExpanded).toBe(true); expect(calendar.items).toHaveLength(2);
      expect(calendar.items[1]).toMatchObject({ recurrenceId: "r2", startDate: null });
      expect(JSON.stringify(await call("get_upcoming_due_dates", { courseId: 5 }))).toContain("Matrix deadline");
      expect((await call("get_course_updates", { courseId: 5, since: start })).items).toHaveLength(2);
      expect((await call("get_my_groups", { courseId: 5 })).items).toMatchObject([{ id: 3, memberCount: 2 }]);
      expect((await call("get_checklists", { courseId: 5 })).items[0].items).toMatchObject([{ id: 4, isCompleted: null }, { id: 5, isCompleted: null }]);
      expect((await call("get_roster", { courseId: 5 })).items).toMatchObject([{ name: "Instructor" }]);
      expect(await call("get_classlist_emails", { courseId: 5 })).toMatchObject([{ email: "instructor@example.invalid" }]);
      expect((await call("get_discussions", { courseId: 5, forumId: 1, topicId: 10, ownOnly: true, unreadOnly: true, maxPagesToScan: 3 })).posts).toHaveLength(1);
      expect((await call("search_course", { courseId: 5, query: "matrix" })).matchedCount).toBeGreaterThan(5);
      expect((await call("search_course", { courseId: 5, query: "page two", sources: ["documents"], documentTopicIds: [101] })).items)
        .toMatchObject([{ source: "document", topicId: 101, page: 2 }]);
      expect((await call("search_course", { courseId: 5, query: "lesson", sources: ["documents"], documentTopicIds: [102] })).items)
        .toMatchObject([{ source: "document", topicId: 102, page: null }]);
      expect((await call("search_course", { courseId: 5, query: "plain text", sources: ["documents"], documentTopicIds: [103] })).items)
        .toMatchObject([{ source: "document", topicId: 103, page: null }]);
      expect((await call("get_course_content", { courseId: 5 })).topicCount).toBe(3);
      const first = await call("read_course_content", { courseId: 5, topicId: 101, maxChars: 21 });
      expect(first.pages).toMatchObject([{ page: 1, text: "Matrix lecture page o" }]);
      expect(first.nextCursor).toBeTruthy();
      const rest = await call("read_course_content", { courseId: 5, topicId: 101, cursor: first.nextCursor });
      expect(rest.pages.at(-1)).toMatchObject({ page: 2, text: "Matrix lecture page two" });
      expect(rest.nextCursor).toBeNull();
      expect((await call("read_course_content", { courseId: 5, topicId: 102 })).text).toContain("# Matrix HTML");
      expect((await call("read_course_content", { courseId: 5, topicId: 103 })).text).toBe("Matrix plain text");
      expect((await call("get_syllabus", { courseId: 5 })).syllabusText).toContain("Matrix lecture page two");
      expect(await readdir(downloads)).toEqual([]);
      if (mode === "http") {
        expect(listed.every(t => t.annotations?.readOnlyHint === true)).toBe(true);
        const beforeDiagnostic = await readFile(requestsPath, "utf8");
        const diagnostic = await promisify(execFile)(process.execPath, [join(root, "build/diagnose.js"), "--http", httpUrl], { cwd: dir, env });
        expect(JSON.parse(diagnostic.stdout)).toMatchObject({ expectedCount: 20, advertisedCount: 20, missing: [], versionMismatch: false });
        expect(await readFile(requestsPath, "utf8")).toBe(beforeDiagnostic);
        const before = await readFile(requestsPath, "utf8");
        expect((await client.callTool({ name: "get_syllabus", arguments: { courseId: 5, downloadPath: downloads } })).isError).toBe(true);
        expect((await client.callTool({ name: "download_file", arguments: { courseId: 5, topicId: 101, downloadPath: downloads } })).isError).toBe(true);
        expect(await readFile(requestsPath, "utf8")).toBe(before);
        expect(await readdir(downloads)).toEqual([]);
      } else {
        const saved = await call("download_file", { courseId: 5, topicId: 101, downloadPath: downloads });
        expect((await readFile(saved.filePath)).subarray(0, 5).toString()).toBe("%PDF-");
        const older = await call("download_file", { courseId: 5, folderId: 1, fileId: 20, downloadPath: downloads });
        expect(older.originalFilename).toBe("report.pdf");
        expect((await call("get_syllabus", { courseId: 5, downloadPath: downloads })).download.success).toBe(true);
      }
      expect([...called].sort()).toEqual(listed.map(t => t.name).sort());
      const requests = (await readFile(requestsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(requests.every(r => r.method === "GET")).toBe(true);
      expect(requests.some(r => r.path.includes("readstatus"))).toBe(false);
      expect(logs).not.toMatch(/console.log intercepted|PRIVATE_SECRET|UNRELEASED_SECRET/);
    } finally {
      if (transport instanceof StreamableHTTPClientTransport) await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
      if (child && child.exitCode === null) {
        const exited = new Promise<void>(resolveExit => child!.once("exit", () => resolveExit()));
        child.kill("SIGTERM"); await exited;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
