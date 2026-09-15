import { describe, it, expect, vi, afterEach } from "vitest";
import { registerGetMyWork } from "../../src/tools/get-my-work.js";
import { registerGetCalendar } from "../../src/tools/get-calendar.js";
import { registerGetChecklists } from "../../src/tools/get-checklists.js";
import { registerGetMyGroups } from "../../src/tools/get-my-groups.js";
import { registerGetCourseUpdates } from "../../src/tools/get-course-updates.js";
import { registerSearchCourse } from "../../src/tools/search-course.js";
import { registerGetDiscussions } from "../../src/tools/get-discussions.js";
import { registerGetMyCourses } from "../../src/tools/get-my-courses.js";
import { ApiError } from "../../src/api/index.js";
import { captureTool, fakeApiClient, parse, objectPage, enrollment, enrollmentsPage } from "./helpers.js";
const fail = () => { throw new ApiError(403, "/x", "secret error"); };
afterEach(() => vi.useRealTimers());
describe("calendar and work overview", () => {
  const event = { CalendarEventId: "1", OrgUnitId: 5, Title: "Deadline", EventType: 6,
    StartDateTime: "2026-09-16T09:00:00Z", EndDateTime: "2026-09-16T09:00:00Z", LocationName: "Room 2", AssociatedEntity: { Link: "/activity" } };
  it("expands occurrences, classifies availability and preserves exclusive all-day end dates", async () => {
    const api = fakeApiClient({ "/myEventsWithOccurrences/": objectPage([{ EventDataInfo: { ...event, EventType: 2 }, Occurrences: [
      { RecurrenceId: "r1", StartDateTime: "2026-09-17T09:00:00Z", EndDateTime: "2026-09-17T10:00:00Z", IsAllDayEvent: false },
      { RecurrenceId: "r2", IsAllDayEvent: true, StartDay: "2026-09-18", EndDay: "2026-09-19" },
    ] }]) });
    const r = parse(await captureTool(registerGetCalendar, api).call({ courseId: 5, start: "2026-09-01T00:00:00Z", end: "2026-09-30T00:00:00Z", timeZone: "Europe/Berlin" }));
    expect(r.recurrenceExpanded).toBe(true); expect(r.items).toHaveLength(2);
    expect(r.items.find((e: any) => e.recurrenceId === "r1")).toMatchObject({ kind: "availability_start", localStart: "17/09/2026, 11:00", location: "Room 2" });
    expect(r.items.find((e: any) => e.recurrenceId === "r2")).toMatchObject({ endDayExclusive: "2026-09-19", startDate: null, localStart: null });
  });
  it("rejects invalid date windows and zones before any read", async () => {
    const api = fakeApiClient(), call = captureTool(registerGetCalendar, api).call;
    expect((await call({ start: "2026-09-01T00:00:00Z", end: "2026-08-01T00:00:00Z" })).isError).toBe(true);
    expect((await call({ start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z", timeZone: "Made/Up" })).isError).toBe(true);
    expect(api.requested).toEqual([]);
  });
  it("falls back on an unavailable recurrence route with explicit partial metadata", async () => {
    const api = fakeApiClient({ "/myEvents/": [event] });
    const r = await captureTool(registerGetCalendar, api).call({ courseId: 5, start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" });
    expect(parse(r).recurrenceExpanded).toBe(false); expect(r.structuredContent?.readStatus).toMatchObject({ partial: true });
  });
  it("separates closed, overdue, complete, exempt, unknown and reminder states", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    const api = fakeApiClient({ "/dropbox/folders/": [{ Id: 1, Name: "Report", SubmissionType: 0, DueDate: "2026-09-14T00:00:00Z", Availability: { EndDate: "2026-09-20T00:00:00Z" } }],
      "/mysubmissions/": fail, "/quizzes/": [], "/content/myItems/": [
        { ItemId: 2, ItemName: "Done", CompletionType: 2, DateCompleted: "2026-09-14T00:00:00Z" },
        { ItemId: 3, ItemName: "Exempt", IsExempt: true }, { ItemId: 4, ItemName: "Unknown", CompletionType: 3 },
      ], "/myEvents/": [event, { ...event, CalendarEventId: "2", EventType: 1, Title: "Reminder" }] });
    const r = parse(await captureTool(registerGetMyWork, api).call({ courseId: 5 }));
    expect(r.items.map((x: any) => x.name)).toEqual(["Report", "Deadline", "Unknown"]);
    expect(r.items[0]).toMatchObject({ overdue: true, closed: false, state: "unknown" });
    expect(r.calendarContext.map((x: any) => x.title)).toEqual(["Reminder"]);
  });
});
describe("groups, checklists and updates", () => {
  it("only returns own groups and links group assignments by category", async () => {
    const api = fakeApiClient({ "/users/whoami": { Identifier: "42" }, "/5/groupcategories/": [{ GroupCategoryId: 2, Name: "Projects" }],
      "/groupcategories/2/groups/": [{ GroupId: 3, Name: "Our team", Enrollments: [42, 43] }, { GroupId: 4, Name: "Other team", Enrollments: [44] }],
      "/sections/mysections/": [], "/dropbox/folders/": [{ Id: 1, DropboxType: 1, GroupTypeId: 2, Name: "Report" }] });
    const r = parse(await captureTool(registerGetMyGroups, api).call({ courseId: 5 }));
    expect(r.items).toHaveLength(1); expect(r.items[0]).toMatchObject({ id: 3, memberCount: 2, assignments: [{ id: 1, name: "Report" }] });
    expect(JSON.stringify(r)).not.toContain("Other team");
  });
  it("does not inspect memberships without verified user identity", async () => {
    const api = fakeApiClient({ "/users/whoami": fail, "/groupcategories/": [{ GroupCategoryId: 2 }], "/sections/mysections/": [], "/dropbox/folders/": [] });
    const r = parse(await captureTool(registerGetMyGroups, api).call({ courseId: 5 }));
    expect(r.sources.identity).toBe("forbidden"); expect(api.requested.some(p => p.includes("/groups/"))).toBe(false);
  });
  it("reads paged checklist items while leaving personal completion unknown", async () => {
    const api = fakeApiClient({ "/checklists/": objectPage([{ Id: 2, Name: "Lab prep" }]), "/checklists/2/categories/": objectPage([{ CategoryId: 3, Name: "Prep" }]),
      "/checklists/2/items/": objectPage([{ ChecklistItemId: 4, CategoryId: 3, Name: "Read", SortOrder: 1 }], "/checklist-next"),
      "/checklist-next": objectPage([{ ChecklistItemId: 5, CategoryId: 3, Name: "Try", SortOrder: 2, DueDate: "2026-09-18T00:00:00Z" }]) });
    const r = parse(await captureTool(registerGetChecklists, api).call({ courseId: 5 }));
    expect(r.items[0].items).toHaveLength(2); expect(r.items[0].items.every((i: any) => i.isCompleted === null)).toBe(true);
  });
  it("includes edited older pinned news and both feed metadata envelopes, excluding other courses", async () => {
    const api = fakeApiClient({ "/updates/myUpdates/": [{ OrgUnitId: 5, UnreadDiscussionPosts: -1 }], "/feed/": [
      { Type: "News", Metadata: { OrgUnitId: 5, Date: "2026-09-14T00:00:00Z" }, Resource: { Id: 1 } },
      { Type: "News", MessageMetaData: { ApiViewUrl: "https://brightspace.example.edu/d2l/api/le/1.97/5/news/2" }, Resource: { Id: 2 } },
      { Type: "News", Metadata: { OrgUnitId: 9 }, Resource: { Title: "other" } },
    ], "/5/news/": [{ Id: 1, Title: "Edited", CreatedDate: "2026-08-01T00:00:00Z", LastModifiedDate: "2026-09-14T00:00:00Z", IsPinned: true }] });
    const r = parse(await captureTool(registerGetCourseUpdates, api).call({ courseId: 5, since: "2026-09-13T00:00:00Z", until: "2026-09-15T00:00:00Z" }));
    expect(r.items).toHaveLength(3); expect(r.items.find((i: any) => i.source === "news").isPinned).toBe(true);
    expect(r.counts[0].UnreadDiscussionPosts).toBe(-1); expect(JSON.stringify(r.items)).not.toContain("other");
  });
});
describe("search, discovery and discussions", () => {
  it("searches across source bodies and nested content and reports unavailable coverage", async () => {
    const api = fakeApiClient({ "/5/news/": [{ Id: 1, Title: "News", Body: { Html: "<p>Read MATRIX notes</p>" } }],
      "/dropbox/folders/": fail, "/content/toc": { Modules: [{ ModuleId: 2, Title: "Week", Modules: [{ ModuleId: 3, Title: "Matrix", Topics: [{ TopicId: 4, Title: "Matrix slides" }] }] }] } });
    const r = await captureTool(registerSearchCourse, api).call({ courseId: 5, query: "matrix", sources: ["announcements", "assignments", "content"], limit: 2 });
    expect(parse(r).matchedCount).toBe(3); expect(parse(r).nextOffset).toBe(2); expect(parse(r).documentBodiesSearched).toBe(false);
    expect(r.structuredContent?.readStatus).toMatchObject({ partial: true });
    expect(api.getRaw).not.toHaveBeenCalled();
  });
  it("continues filtered discussion pages even if the first page has no matching posts", async () => {
    const api = fakeApiClient({ "/topics/10": { TopicId: 10 }, "/users/whoami": { Identifier: "42" }, "/topics/10/posts/": [
      { PostId: 1, ThreadId: 5, PostingUserId: 99, IsRead: false }, { PostId: 2, ThreadId: 5, PostingUserId: 42, IsRead: true },
    ] });
    const r = parse(await captureTool(registerGetDiscussions, api).call({ courseId: 5, forumId: 1, topicId: 10, threadId: 5, pageSize: 2, unreadOnly: true, ownOnly: true }));
    expect(r.posts).toEqual([]); expect(r.nextPage).toBe(2);
    expect(api.requested.some(p => p.includes("threadId=5"))).toBe(true);
    expect(api.requested.every(p => !p.includes("readstatus"))).toBe(true);
  });
  it("discovers courses by code and semester without equating active with current", async () => {
    const api = fakeApiClient({ "/myenrollments/": enrollmentsPage([enrollment(5, "Math"), enrollment(6, "Old Math")]),
      "/courses/5": { Semester: { Name: "Autumn", Code: "2026" }, StartDate: "2026-09-01T00:00:00Z", EndDate: "2027-01-31T00:00:00Z" },
      "/courses/6": { Semester: { Name: "Spring", Code: "2026" }, StartDate: "2026-02-01T00:00:00Z", EndDate: "2026-06-30T00:00:00Z" } });
    const r = parse(await captureTool(registerGetMyCourses, api).call({ semester: "autumn", onDate: "2026-09-15" }));
    expect(r.map((c: any) => c.id)).toEqual([5]);
    const code = parse(await captureTool(registerGetMyCourses, api).call({ query: "code-6" })); expect(code[0].id).toBe(6);
  });
});
