import { describe, it, expect, vi, afterEach } from "vitest";
import { registerGetBriefing } from "../../src/tools/get-briefing.js";
import { captureTool, fakeApiClient, parse, enrollment, enrollmentsPage } from "./helpers.js";

afterEach(() => { vi.useRealTimers(); });

describe("get_briefing", () => {
  it("summarizes due, overdue, new announcements, released grades and unread activity in one call", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    const api = fakeApiClient({
      "/enrollments/myenrollments/": enrollmentsPage([enrollment(5, "Matrix methods")]),
      "/users/whoami": { Identifier: "42" }, "/quizzes/": [], "/mysubmissions/": [],
      "/dropbox/folders/": [], "/myEvents/": [],
      "/content/myItems/": { Objects: [
        { OrgUnitId: "5", ItemId: 1, ItemName: "Read chapter", CompletionType: 2, DueDate: "2026-09-17T00:00:00Z" },
        { OrgUnitId: "5", ItemId: 2, ItemName: "Late lab", CompletionType: 2, DueDate: "2026-09-10T00:00:00Z" },
        { OrgUnitId: "5", ItemId: 3, ItemName: "Done", CompletionType: 2, DateCompleted: "2026-09-14T00:00:00Z", DueDate: "2026-09-16T00:00:00Z" },
      ], Next: null },
      "/5/news/": [
        { Id: 7, Title: "Room change", Body: { Text: "x".repeat(300) }, IsPublished: true, CreatedDate: "2026-09-14T00:00:00Z", IsPinned: true },
        { Id: 8, Title: "Old news", Body: { Text: "old" }, IsPublished: true, CreatedDate: "2026-08-01T00:00:00Z" },
        { Id: 9, Title: "Draft", Body: { Text: "draft" }, IsPublished: false, CreatedDate: "2026-09-14T00:00:00Z" },
      ],
      "/5/grades/values/myGradeValues/": [
        { GradeObjectName: "Quiz 1", DisplayedGrade: "8 / 10", PointsNumerator: 8, PointsDenominator: 10, ReleasedDate: "2026-09-13T00:00:00Z" },
        { GradeObjectName: "Old quiz", DisplayedGrade: "5 / 10", LastModified: "2026-08-01T00:00:00Z" },
      ],
      "/updates/myUpdates/": { Objects: [{ OrgUnitId: "5", UnreadDiscussions: 3, UnreadAssignmentFeedback: -1, UnattemptedQuizzes: 0 }], Next: null },
    });
    const r = parse(await captureTool(registerGetBriefing, api).call({}));
    expect(r.dueSoon).toEqual({ total: 1, items: [expect.objectContaining({ course: "Matrix methods", name: "Read chapter", state: "incomplete" })] });
    expect(r.overdue.items.map((i: any) => i.name)).toEqual(["Late lab"]);
    expect(r.announcements.items).toEqual([expect.objectContaining({ id: 7, title: "Room change", pinned: true })]);
    expect(r.announcements.items[0].snippet).toHaveLength(201);
    expect(r.grades.items).toEqual([expect.objectContaining({ name: "Quiz 1", grade: "8 / 10", points: "8/10" })]);
    expect(r.activity).toEqual([{ course: "Matrix methods", courseId: 5, unreadDiscussions: 3, unreadFeedback: 0, unattemptedQuizzes: 0 }]);
    // The window is read in one server-filtered scheduled-content request.
    expect(api.requested.filter(p => p.includes("/content/myItems/"))).toHaveLength(1);
  });

  it("limits sections while reporting totals", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    const news = Array.from({ length: 4 }, (_, i) => ({ Id: i + 1, Title: `News ${i}`, Body: { Text: "" }, CreatedDate: `2026-09-1${i}T00:00:00Z` }));
    const api = fakeApiClient({ "/enrollments/myenrollments/": enrollmentsPage([enrollment(5, "Matrix methods")]), "/5/news/": news,
      "/dropbox/folders/": [], "/quizzes/": [], "/content/myItems/": { Objects: [], Next: null }, "/myEvents/": [], "/myGradeValues/": [],
      "/updates/myUpdates/": { Objects: [], Next: null } });
    const r = parse(await captureTool(registerGetBriefing, api).call({ limit: 2, since: "2026-09-09T00:00:00Z" }));
    expect(r.announcements.total).toBe(4);
    expect(r.announcements.items.map((a: any) => a.title)).toEqual(["News 3", "News 2"]);
  });
});
