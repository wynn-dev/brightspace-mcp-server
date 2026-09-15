import { describe, expect, it } from "vitest";
import { captureTool, fakeApiClient, parse, fakeResponse, enrollment, enrollmentsPage } from "./helpers.js";
import { registerGetChecklists } from "../../src/tools/get-checklists.js";
import { fetchCourseAssignments } from "../../src/services/assignments.js";
import { registerGetMyWork } from "../../src/tools/get-my-work.js";
import { registerGetAssignments } from "../../src/tools/get-assignments.js";
import { registerGetDiscussions } from "../../src/tools/get-discussions.js";
import { registerGetSyllabus } from "../../src/tools/get-syllabus.js";
import { registerGetRoster } from "../../src/tools/get-roster.js";
import { registerGetMyCourses } from "../../src/tools/get-my-courses.js";
import { registerGetUpcomingDueDates } from "../../src/tools/get-upcoming-due-dates.js";
import { registerSearchCourse } from "../../src/tools/search-course.js";
import { ApiError } from "../../src/api/index.js";
import { makePdf } from "../fixtures/pdf.js";

const forbidden = () => { throw new ApiError(403, "/fixture", "Forbidden"); };
describe("checklist response variants", () => {
  it.each(["Id", "ChecklistId"])("reads nonempty checklists using %s", async key => {
    const api = fakeApiClient({ "/checklists/": { Objects: [{ [key]: 2, Name: "Preparation" }], Next: null },
      "/checklists/2/categories/": [{ CategoryId: 3, Name: "Reading" }],
      "/checklists/2/items/": [{ ChecklistItemId: 4, ChecklistId: 2, CategoryId: 3, Name: "Read" }] });
    const result = parse(await captureTool(registerGetChecklists, api).call({ courseId: 5 }));
    expect(result.items).toMatchObject([{ id: 2, items: [{ id: 4, isCompleted: null }] }]);
  });
  it("keeps an entry whose missing identifier prevents detail loading", async () => {
    const api = fakeApiClient({ "/checklists/": [{ Name: "Preparation" }] });
    const result = await captureTool(registerGetChecklists, api).call({ courseId: 5 });
    expect(parse(result).items).toMatchObject([{ id: null, name: "Preparation" }]);
    expect(result.structuredContent?.readStatus).toMatchObject({ partial: true });
  });
});

describe("personal deadlines", () => {
  const folders = [{ Id: 1, Name: "Report", DueDate: "2026-09-10T00:00:00Z", Availability: { EndDate: "2026-09-11T00:00:00Z" }, SubmissionType: 0 }];
  const routes = { "/users/whoami": { Identifier: "42" }, "/dropbox/folders/": folders, "/quizzes/": [], "/mysubmissions/": [] };
  it("uses verified extensions and preserves an explicitly removed end date", async () => {
    const api = fakeApiClient({ ...routes, "/specialaccess/42": { StartDate: null, EndDate: null, DueDate: "2026-09-20T00:00:00Z" } });
    const result = parse(await captureTool(registerGetAssignments, api).call({ courseId: 5 })).assignments[0];
    expect(result).toMatchObject({ dueDate: "2026-09-20T00:00:00Z", endDate: null, personalDatesVerified: true,
      courseDefaultDates: { dueDate: "2026-09-10T00:00:00Z" } });
    expect(api.requested.filter(p => p.includes("specialaccess"))).toEqual(["/d2l/api/le/1.0/5/dropbox/folders/1/specialaccess/42"]);
  });
  it.each([null, { StartDate: null, EndDate: null }, { StartDate: null, EndDate: null, DueDate: "invalid" }])("does not verify incomplete special access: %j", async special => {
    const api = fakeApiClient({ ...routes, "/specialaccess/42": special });
    const result = parse(await captureTool(registerGetAssignments, api).call({ courseId: 5 })).assignments[0];
    expect(result.personalDatesVerified).toBe(false); expect(result.dueDate).toBe(folders[0].DueDate);
  });
  it("does not probe special access when details were not requested", async () => {
    const api = fakeApiClient(routes);
    const result = await fetchCourseAssignments(api, 5, { includeDetails: false });
    expect(result.assignments[0]).toMatchObject({ personalDatesVerified: false, specialAccessStatus: "not_requested" });
    expect(api.requested.some(p => p.includes("specialaccess"))).toBe(false);
  });
  it("stops redundant permission probes after denial while leaving later dates unverified", async () => {
    const api = fakeApiClient({ ...routes, "/dropbox/folders/": [...folders, { ...folders[0], Id: 2 }], "/specialaccess/42": forbidden });
    const result = parse(await captureTool(registerGetAssignments, api).call({ courseId: 5 }));
    expect(result.assignments.every((a: any) => !a.personalDatesVerified)).toBe(true);
    expect(api.requested.filter(p => p.includes("specialaccess"))).toHaveLength(1);
  });
  it("uses the current user's ongoing attempt deadline without asserting future-attempt settings", async () => {
    const api = fakeApiClient({ "/users/whoami": { Identifier: "42" }, "/dropbox/folders/": [], "/quizzes/": [{ QuizId: 2, DueDate: "2026-09-10T00:00:00Z" }],
      "/attempts/": [{ UserId: 42, AttemptId: 1, AttemptNumber: 1, Started: "2026-09-11T00:00:00Z", Completed: null, AttemptDueDate: "2026-09-20T00:00:00Z" }], "/specialaccess/42": forbidden });
    expect(parse(await captureTool(registerGetAssignments, api).call({ courseId: 5 })).assignments[0]).toMatchObject({
      state: "in_progress", datesSource: "active_attempt", dueDate: "2026-09-20T00:00:00Z", personalDatesVerified: false });
  });
});

describe("filtered discussion scans", () => {
  it("continues past an empty filtered page to later matches", async () => {
    const api = fakeApiClient({ "/users/whoami": { Identifier: "42" }, "/topics/10": { TopicId: 10 }, "/topics/10/posts/": (path: string) =>
      new URL(path, "https://example.invalid").searchParams.get("pageNumber") === "1"
        ? [{ PostId: 1, PostingUserId: 99 }, { PostId: 2, PostingUserId: 99 }]
        : [{ PostId: 3, PostingUserId: 42, Message: { Text: "Match" } }] });
    const response = await captureTool(registerGetDiscussions, api).call({ courseId: 5, forumId: 1, topicId: 10, ownOnly: true, pageSize: 2, maxPagesToScan: 3 });
    expect(response.structuredContent?.readStatus).toMatchObject({ partial: false });
    const r = parse(response);
    expect(r).toMatchObject({ posts: [{ postId: 3 }], pagesScanned: 2, nextPage: null, exhausted: true });
  });
  it("retains matches when a later page fails and points continuation to that failed page", async () => {
    const api = fakeApiClient({ "/topics/10": { TopicId: 10 }, "/topics/10/posts/": (path: string) =>
      new URL(path, "https://example.invalid").searchParams.get("pageNumber") === "1"
        ? [{ PostId: 1, IsRead: false }, { PostId: 2, IsRead: true }] : forbidden() });
    const r = await captureTool(registerGetDiscussions, api).call({ courseId: 5, forumId: 1, topicId: 10, unreadOnly: true, pageSize: 2, maxPagesToScan: 3 });
    expect(parse(r)).toMatchObject({ posts: [{ postId: 1 }], nextPage: 2, exhausted: false, status: "forbidden" });
    expect(r.structuredContent?.readStatus).toMatchObject({ partial: true });
  });
  it("does not claim exhaustion for an incomplete wrapped post response", async () => {
    const api = fakeApiClient({ "/topics/10": { TopicId: 10 }, "/topics/10/posts/": { Objects: [{ PostId: 1 }], Next: "/failed-page" }, "/failed-page": forbidden });
    const result = await captureTool(registerGetDiscussions, api).call({ courseId: 5, forumId: 1, topicId: 10, pageSize: 2, maxPagesToScan: 3 });
    expect(parse(result)).toMatchObject({ posts: [{ postId: 1 }], exhausted: false, nextPage: 1, pagesScanned: 1 });
    expect(result.structuredContent?.readStatus).toMatchObject({ partial: true });
  });
  it("does not claim exhaustion when identity is unavailable", async () => {
    const api = fakeApiClient({ "/users/whoami": forbidden, "/topics/10": { TopicId: 10 }, "/topics/10/posts/": [] });
    expect(parse(await captureTool(registerGetDiscussions, api).call({ courseId: 5, forumId: 1, topicId: 10, ownOnly: true, maxPagesToScan: 3 })))
      .toMatchObject({ posts: [], nextPage: 1, exhausted: false, pagesScanned: 1 });
  });
});

describe("document search and content fallbacks", () => {
  const toc = { Modules: [{ ModuleId: 10, Title: "Course information", Topics: [
    { TopicId: 11, Title: "Course manual" }, { TopicId: 12, Title: "Staff contacts" }, { TopicId: 13, Title: "Hidden", IsHidden: true }, { TopicId: 14, Title: "External", TopicType: 2 },
  ] }] };
  const routes = { "/content/toc": toc, "/content/topics/": { TopicType: 1, Title: "Material" } };
  it("finds body-only PDF matches with physical page references and file continuation", async () => {
    const api = fakeApiClient(routes, { getRaw: async () => fakeResponse(makePdf(["Introduction", "Eigenvalue details"]), { "Content-Type": "application/pdf" }) });
    const result = parse(await captureTool(registerSearchCourse, api).call({ courseId: 5, query: "eigenvalue", sources: ["documents"], maxDocuments: 1 }));
    expect(result).toMatchObject({ documentBodiesSearched: true, documentsScanned: 1, nextDocumentOffset: 1,
      items: [{ source: "document", topicId: 11, page: 2 }] });
    expect(result.items[0].sourceUrl).toContain("/viewContent/11/View");
    const next = parse(await captureTool(registerSearchCourse, api).call({ courseId: 5, query: "eigenvalue", sources: ["documents"], maxDocuments: 1, documentOffset: result.nextDocumentOffset }));
    expect(next).toMatchObject({ documentsScanned: 1, nextDocumentOffset: null, items: [{ topicId: 12, page: 2 }] });
  });
  it("does not fetch files in the default search", async () => {
    const api = fakeApiClient(routes);
    await captureTool(registerSearchCourse, api).call({ courseId: 5, query: "manual", sources: ["content"] });
    expect(api.getRaw).not.toHaveBeenCalled();
  });
  it("provides syllabus and staff source excerpts without inventing official records", async () => {
    const api = fakeApiClient({ ...routes, "/overview": forbidden, "/classlist/paged/": forbidden }, {
      getRaw: async () => fakeResponse("<h1>Course information</h1><p>Office hours on Monday.</p>", { "Content-Type": "text/html" }),
    });
    const syllabus = parse(await captureTool(registerGetSyllabus, api).call({ courseId: 5 }));
    expect(syllabus.contentFallback.materials[0].excerpt.text).toContain("Office hours");
    const staff = parse(await captureTool(registerGetRoster, api).call({ courseId: 5 }));
    expect(staff.status).toBe("forbidden"); expect(staff.items).toEqual([]);
    expect(staff.contentFallback.materials[0]).toMatchObject({ topicId: 12, status: "available" });
  });
  it("does not equate a truncated excerpt with a full-document search", async () => {
    const api = fakeApiClient(routes, { getRaw: async () => fakeResponse("a".repeat(200) + "target", { "Content-Type": "text/plain" }) });
    const r = await captureTool(registerSearchCourse, api).call({ courseId: 5, query: "target", sources: ["documents"], maxDocumentChars: 100, documentTopicIds: [11] });
    expect(parse(r).items).toEqual([]); expect(parse(r).coverage.at(-1).truncated).toBe(true);
    expect(r.structuredContent?.readStatus).toMatchObject({ partial: true });
  });
});

it("uses permitted enrollment dates and explicit semester ancestors when course details are forbidden", async () => {
  const entry = enrollment(5, "Math");
  const api = fakeApiClient({ "/myenrollments/": enrollmentsPage([{ ...entry, Access: { ...entry.Access, StartDate: "2026-09-01T00:00:00Z", EndDate: "2027-01-01T00:00:00Z" } }]),
    "/courses/5": forbidden, "/orgstructure/5/ancestors/": [{ Name: "Autumn", Code: "2026", Type: { Code: "Semester" } }] });
  expect(parse(await captureTool(registerGetMyCourses, api).call({ semester: "autumn", onDate: "2026-09-15" }))).toMatchObject([
    { id: 5, detailStatus: "forbidden", semesterMatch: true, dateMatch: true, semesterSource: "orgunit_ancestor", dateSources: { start: "enrollment" } },
  ]);
});

it("includes requested reminders without labelling them as deadlines", async () => {
  const api = fakeApiClient({ "/myEvents/": [{ CalendarEventId: "1", EventType: 1, Title: "Reminder" }, { CalendarEventId: "2", EventType: 2, Title: "Opens" }, { CalendarEventId: "3", EventType: 6, Title: "Due" }] });
  const r = await captureTool(registerGetUpcomingDueDates, api).call({ courseId: 5, includeReminders: true });
  expect(parse(r).map((e: any) => e.kind)).toEqual(["reminder", "due_date"]);
  expect(r.structuredContent?.nextTools).toEqual(["get_my_work", "get_calendar"]);
});


it("distinguishes active-attempt overdue status from the course-default assumption", async () => {
  const past = new Date(Date.now() - 86400000).toISOString(), future = new Date(Date.now() + 86400000).toISOString();
  const api = fakeApiClient({ "/users/whoami": { Identifier: "42" }, "/dropbox/folders/": [], "/quizzes/": [{ QuizId: 2, DueDate: past }],
    "/attempts/": [{ UserId: 42, AttemptId: 1, AttemptNumber: 1, Started: past, Completed: null, AttemptDueDate: future }],
    "/specialaccess/42": forbidden, "/content/myItems/": [], "/myEvents/": [] });
  const result = parse(await captureTool(registerGetMyWork, api).call({ courseId: 5 }));
  expect(result.items[0]).toMatchObject({ datesSource: "active_attempt", overdue: false, overdueAssumingCourseDefaults: true, closed: null });
});

it("warns when unverified default dates exclude potentially extended work from the window", async () => {
  const api = fakeApiClient({ "/users/whoami": { Identifier: "42" }, "/dropbox/folders/": [{ Id: 1, DueDate: "2000-01-01T00:00:00Z", SubmissionType: 0 }],
    "/quizzes/": [], "/mysubmissions/": [], "/specialaccess/42": forbidden, "/content/myItems/": [], "/myEvents/": [] });
  const r = await captureTool(registerGetMyWork, api).call({ courseId: 5 });
  expect(parse(r)).toMatchObject({ items: [], unverifiedDatesOutsideWindow: 1 });
  expect(r.structuredContent?.readStatus).toMatchObject({ partial: true, limits: expect.arrayContaining([expect.stringContaining("unverified course-default dates")]) });
});
