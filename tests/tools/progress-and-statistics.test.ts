import { describe, it, expect } from "vitest";
import { registerGetCourseContent } from "../../src/tools/get-course-content.js";
import { registerGetMyCourses } from "../../src/tools/get-my-courses.js";
import { registerGetMyGrades } from "../../src/tools/get-my-grades.js";
import { registerGetGradeSummary } from "../../src/tools/get-grade-summary.js";
import { ApiError } from "../../src/api/index.js";
import { captureTool, fakeApiClient, parse, enrollment, enrollmentsPage, objectPage } from "./helpers.js";

const forbidden = () => { throw new ApiError(403, "/x", "forbidden"); };
// Shapes follow the live ContentAggregateCompletion ObjectListPage.
const aggregate = (ObjectId: number, CompletedItems: unknown, RequiredItems: unknown) =>
  ({ OrgUnitId: "3", UserId: "42", ObjectId, Title: "t", CompletedItems, RequiredItems });
const toc = { Modules: [
  { ModuleId: 1, Title: "Week 1", SortOrder: 1, Modules: [{ ModuleId: 5, Title: "Nested", SortOrder: 1, Modules: [], Topics: [] }], Topics: [] },
  { ModuleId: 2, Title: "Week 2", SortOrder: 2, Modules: [], Topics: [] },
] };
const LEVEL1 = "/3/content/completions/mycount/?level=1", LEVEL2 = "/3/content/completions/mycount/?level=2";

describe("content progress in get_course_content", () => {
  it("adds course and top-level module counts", async () => {
    const api = fakeApiClient({ "/3/content/toc": toc, "/3/content/myItems/": [],
      [LEVEL1]: objectPage([aggregate(0, 3, 10)]),
      // Nested modules are never attached, even if a count were returned for them.
      [LEVEL2]: objectPage([aggregate(1, 3, 4), aggregate(5, 1, 1)]) });
    const response = await captureTool(registerGetCourseContent, api).call({ courseId: 3 });
    const result = parse(response);
    expect(result.progress).toEqual({ completed: 3, required: 10 });
    expect(result.contentTree[0]).toMatchObject({ moduleId: 1, progress: { completed: 3, required: 4 } });
    expect(result.contentTree[0].children[0].progress).toBeUndefined();
    // A top-level module without a count gets no progress rather than zero.
    expect(result.contentTree[1].progress).toBeUndefined();
    expect(response.structuredContent?.readStatus).toMatchObject({ partial: false });
  });

  it.each([
    ["forbidden", forbidden],
    ["not_found", () => { throw new ApiError(404, "/x", "missing"); }],
  ])("reports %s counts as unavailable, never zero", async (status, route) => {
    const api = fakeApiClient({ "/3/content/toc": toc, "/3/content/myItems/": [], [LEVEL1]: route, [LEVEL2]: route });
    const response = await captureTool(registerGetCourseContent, api).call({ courseId: 3 });
    const result = parse(response);
    expect(result.progress).toBeNull();
    expect(result.contentTree.every((m: { progress?: unknown }) => m.progress === undefined)).toBe(true);
    expect(response.structuredContent?.readStatus).toMatchObject({ partial: true,
      failed: [{ source: expect.stringContaining("level=1"), status }, { source: expect.stringContaining("level=2"), status }] });
  });

  it.each([
    ["negative or fractional counts", objectPage([aggregate(0, -1, 4)]), objectPage([aggregate(1, 1.5, 4)])],
    ["non-numeric counts", objectPage([aggregate(0, "3", 4)]), objectPage([aggregate(1, 1, null)])],
    ["no course row", objectPage([]), objectPage([aggregate(0, 1, 4)])],
    ["a non-list body", { Count: 3 }, objectPage([aggregate(1, 1, 1), aggregate(1, 1, 1)])],
  ])("treats %s as an error", async (_name, level1, level2) => {
    const api = fakeApiClient({ "/3/content/toc": toc, "/3/content/myItems/": [], [LEVEL1]: level1, [LEVEL2]: level2 });
    const response = await captureTool(registerGetCourseContent, api).call({ courseId: 3 });
    const result = parse(response);
    expect(result.progress).toBeNull();
    expect(result.contentTree.every((m: { progress?: unknown }) => m.progress === undefined)).toBe(true);
    expect(response.structuredContent?.readStatus).toMatchObject({ partial: true,
      failed: [{ source: expect.stringContaining("level=1"), status: "error" }, { source: expect.stringContaining("level=2"), status: "error" }] });
  });

  it("skips the progress reads when includeProgress is false", async () => {
    const api = fakeApiClient({ "/3/content/toc": toc, "/3/content/myItems/": [] });
    const result = parse(await captureTool(registerGetCourseContent, api).call({ courseId: 3, includeProgress: false }));
    expect(result).not.toHaveProperty("progress");
    expect(api.requested.some(p => p.includes("completions"))).toBe(false);
  });
});

describe("content progress in get_my_courses", () => {
  it("adds course-level counts per course and keeps unavailable ones null", async () => {
    const api = fakeApiClient({
      "/enrollments/myenrollments/": enrollmentsPage([enrollment(1, "Alpha"), enrollment(2, "Beta")]),
      "/1/content/completions/mycount/?level=1": objectPage([aggregate(0, 2, 5)]),
      "/2/content/completions/mycount/?level=1": forbidden,
    });
    const response = await captureTool(registerGetMyCourses, api).call({ includeProgress: true });
    expect(parse(response)).toMatchObject([{ id: 1, progress: { completed: 2, required: 5 } }, { id: 2, progress: null }]);
    expect(response.structuredContent?.readStatus).toMatchObject({ partial: true, failed: [{ status: "forbidden" }] });
  });

  it("does not read progress by default", async () => {
    const api = fakeApiClient({ "/enrollments/myenrollments/": enrollmentsPage([enrollment(1, "Alpha")]) });
    const result = parse(await captureTool(registerGetMyCourses, api).call({}));
    expect(result[0]).not.toHaveProperty("progress");
    expect(api.requested.some(p => p.includes("completions"))).toBe(false);
  });
});

// Shapes follow the documented GradeStatisticsInfo block.
const stats = (GradeObjectId: number, extra: Record<string, unknown> = {}) => ({ OrgUnitId: 3, GradeObjectId,
  Minimum: 2, Maximum: 10, Average: 7.123456, Mode: [8], Median: 7.5, StandardDeviation: 1.98765, ...extra });
const gradeItem = (Id: number, GradeType = "Numeric") => ({ Id, Name: `Item ${Id}`, MaxPoints: 10, Weight: 0, CategoryId: 0, GradeType,
  IsBonus: false, IsHidden: false, CanExceedMaxPoints: false, ExcludeFromFinalGradeCalculation: false });
const summaryRoutes = (items: unknown[]) => ({ "/3/grades/": items, "/grades/categories/": [], "/grades/values/myGradeValues/": [],
  "/grades/setup/": { GradingSystem: "Points", IsNullGradeZero: false }, "/users/whoami": { Identifier: "42" },
  "/grades/exemptions/42": { Items: [] }, "/grades/final/values/myGradeValue": { DisplayedGrade: "B" } });
const statsRequests = (api: { requested: string[] }) => api.requested.filter(p => p.endsWith("/statistics"));

describe("class grade statistics", () => {
  it("returns shared statistics per item in get_grade_summary, skipping text items", async () => {
    const api = fakeApiClient({ ...summaryRoutes([gradeItem(1), gradeItem(2), gradeItem(3, "Text")]),
      "/grades/1/statistics": stats(1), "/grades/2/statistics": stats(2, { Mode: [], Median: null }) });
    const response = await captureTool(registerGetGradeSummary, api).call({ courseId: 3, includeStatistics: true });
    const { statistics } = parse(response);
    expect(statistics).toEqual({ status: "available", unavailable: [], notChecked: [], items: [
      { gradeItemId: 1, minimum: 2, maximum: 10, average: 7.12, median: 7.5, mode: [8], standardDeviation: 1.99 },
      { gradeItemId: 2, minimum: 2, maximum: 10, average: 7.12, median: null, mode: [], standardDeviation: 1.99 },
    ] });
    expect(statsRequests(api)).toHaveLength(2);
    expect(response.structuredContent?.readStatus).toMatchObject({ partial: false });
  });

  it("stops probing a course after the first 403 and labels it not shared", async () => {
    const items = Array.from({ length: 12 }, (_, i) => gradeItem(i + 1));
    const api = fakeApiClient({ ...summaryRoutes(items), "/statistics": forbidden });
    const response = await captureTool(registerGetGradeSummary, api).call({ courseId: 3, includeStatistics: true });
    const { statistics, calculation } = parse(response);
    expect(statsRequests(api)).toHaveLength(1);
    expect(statistics).toMatchObject({ status: "not_shared", items: [], unavailable: [{ gradeItemId: 1, status: "forbidden" }],
      notChecked: items.slice(1).map(i => i.Id), note: expect.stringMatching(/not shared/) });
    // Unshared statistics are reported, but never block the grade explanation.
    expect(calculation.reasons ?? []).not.toContain("Required grade sources are unavailable or truncated.");
    expect(response.structuredContent?.readStatus.failed).toEqual([{ source: expect.stringContaining("/grades/1/statistics"), status: "forbidden" }]);
  });

  it("keeps earlier results and stops after a later 403 with bounded concurrency", async () => {
    const items = Array.from({ length: 20 }, (_, i) => gradeItem(i + 1));
    let inFlight = 0, peak = 0;
    const api = fakeApiClient({ ...summaryRoutes(items), "/statistics": async (path: string) => {
      const itemId = Number(path.match(/grades\/(\d+)\/statistics/)![1]);
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      if (itemId === 3) forbidden();
      return stats(itemId);
    } });
    const { statistics } = parse(await captureTool(registerGetGradeSummary, api).call({ courseId: 3, includeStatistics: true }));
    expect(peak).toBeLessThanOrEqual(4);
    expect(statistics.status).toBe("partial");
    expect(statistics.items.map((s: { gradeItemId: number }) => s.gradeItemId)).toEqual(expect.arrayContaining([1, 2]));
    expect(statistics.unavailable).toEqual([{ gradeItemId: 3, status: "forbidden" }]);
    // Only reads already in flight when the 403 arrived finish; the rest are not requested.
    expect(statsRequests(api).length).toBeLessThanOrEqual(6);
    expect(statistics.notChecked.length).toBe(20 - statsRequests(api).length);
  });

  it.each([
    ["not_found", () => { throw new ApiError(404, "/x", "missing"); }, "not_found"],
    ["a non-numeric value", stats(1, { Average: "7" }), "error"],
    ["a non-array mode", stats(1, { Mode: 8 }), "error"],
    ["another item's statistics", stats(9), "error"],
    ["a list body", [stats(1)], "error"],
  ])("reports %s as unavailable without fabricating values and keeps probing", async (_name, route, status) => {
    const api = fakeApiClient({ ...summaryRoutes([gradeItem(1), gradeItem(2)]), "/grades/1/statistics": route, "/grades/2/statistics": stats(2) });
    const response = await captureTool(registerGetGradeSummary, api).call({ courseId: 3, includeStatistics: true });
    const { statistics } = parse(response);
    expect(statistics).toMatchObject({ status: "partial", unavailable: [{ gradeItemId: 1, status }], notChecked: [], items: [{ gradeItemId: 2 }] });
    expect(statistics).not.toHaveProperty("note");
    expect(response.structuredContent?.readStatus.failed).toEqual([{ source: expect.stringContaining("/grades/1/statistics"), status }]);
  });

  it("does not read statistics unless requested", async () => {
    const api = fakeApiClient(summaryRoutes([gradeItem(1)]));
    expect(parse(await captureTool(registerGetGradeSummary, api).call({ courseId: 3 }))).not.toHaveProperty("statistics");
    expect(statsRequests(api)).toHaveLength(0);
  });

  it("adds statistics to get_my_grades for one course and requires a courseId", async () => {
    const value = (id: string, GradeObjectType: number) => ({ GradeObjectIdentifier: id, GradeObjectName: `Item ${id}`, GradeObjectType,
      DisplayedGrade: "8 / 10", PointsNumerator: 8, PointsDenominator: 10, Comments: null, PrivateComments: null, LastModified: "2026-09-01T00:00:00Z" });
    const api = fakeApiClient({ "/3/grades/values/myGradeValues/": [value("1", 1), value("2", 4)], "/grades/1/statistics": stats(1) });
    const { call } = captureTool(registerGetMyGrades, api);
    const result = parse(await call({ courseId: 3, includeStatistics: true }));
    expect(result.grades).toHaveLength(2);
    expect(result.statistics).toMatchObject({ status: "available", items: [{ gradeItemId: 1, average: 7.12 }] });
    expect(statsRequests(api)).toEqual(["/d2l/api/le/1.0/3/grades/1/statistics"]);
    const error = await call({ includeStatistics: true });
    expect(error.isError).toBe(true);
    expect(parse(await call({ courseId: 3 }))).not.toHaveProperty("statistics");
  });
});
