import type { D2LApiClient } from "../api/index.js";
import type { AppConfig } from "../types/index.js";
import { fetchCourseAssignments } from "./assignments.js";
import { fetchCalendar } from "./calendar.js";
import { readList, id, str, num, type Row } from "./data.js";
import { recordLimit } from "../utils/read-status.js";

export interface WorkOptions {
  daysAhead: number;
  daysBehind: number;
  includeCompleted: boolean;
  includeUndated: boolean;
}

const DONE = ["completed", "submitted", "attempt_completed", "exempt"];

/**
 * Scheduled content in the window: one server-filtered request per 100
 * courses. The cross-course route lists undated items slightly differently
 * from the per-course route (verified live), so undated reads stay per course.
 */
async function scheduledContent(api: D2LApiClient, courseIds: number[], start: string, end: string, includeUndated: boolean) {
  const paths = includeUndated
    ? courseIds.map(id => api.le(id, "/content/myItems/"))
    : Array.from({ length: Math.ceil(courseIds.length / 100) }, (_, i) =>
      api.leGlobal(`/content/myItems/?orgUnitIdsCSV=${courseIds.slice(i * 100, i * 100 + 100).join(",")}&startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}`));
  const results = await Promise.all(paths.map(path => readList(api, path, 2000)));
  const items = results.flatMap((result, i) => (result.data ?? []).map(item =>
    includeUndated && item.OrgUnitId === undefined ? { ...item, OrgUnitId: courseIds[i] } : item));
  return { status: results.find(r => r.status !== "available")?.status ?? "available", items };
}

/**
 * Assignments, quizzes, scheduled content and calendar deadlines for the
 * window, with completion, overdue and date-verification flags. Shared by
 * get_my_work and get_briefing; callers page or summarize the items.
 */
export async function workOverview(api: D2LApiClient, config: AppConfig, courses: Array<{ id: number; name: string | null }>, options: WorkOptions) {
  const { daysAhead, daysBehind, includeCompleted, includeUndated } = options;
  const now = Date.now(), start = new Date(now - daysBehind * 86400000).toISOString(), end = new Date(now + daysAhead * 86400000).toISOString();
  // Submission state only matters for work the date filter below can select.
  const inWindow = (due: string | null) => due ? Date.parse(due) >= Date.parse(start) && Date.parse(due) <= Date.parse(end) : includeUndated;
  const ids = courses.map(c => c.id), names = new Map(courses.map(c => [c.id, c.name]));
  const [perCourse, content, calendar] = await Promise.all([
    Promise.all(courses.map(course => fetchCourseAssignments(api, course.id, { limit: 100, submissionsFor: dates => inWindow(dates.dueDate) }))),
    scheduledContent(api, ids, start, end, includeUndated),
    fetchCalendar(api, ids, start, end, "UTC", false),
  ]);
  const work: Row[] = [], sources = [];
  for (const [i, course] of courses.entries()) {
    const assignments = perCourse[i];
    if (assignments.nextOffset !== null) recordLimit(`Work overview: first 100 assignments/quizzes for course ${course.id}; use get_assignments pagination`);
    sources.push({ courseId: course.id, ...assignments.sources, scheduledContent: content.status });
    for (const a of assignments.assignments) work.push({ type: a.type, id: a.id, name: a.name, state: a.state,
      dueDate: a.dueDate, startDate: a.startDate, endDate: a.endDate,
      datesSource: a.datesSource, personalDatesVerified: a.personalDatesVerified,
      ...a.personalDatesVerified ? { courseDefaultDates: a.courseDefaultDates } : {}, defaultDueDate: a.courseDefaultDates.dueDate,
      courseId: course.id, courseName: course.name,
      source: "assignments", sourceUrl: `${config.baseUrl.replace(/\/$/, "")}/d2l/home/${course.id}` });
  }
  for (const c of content.items) {
    // The cross-course response names each item's course; a single-course request may omit it.
    const courseId = id(c.OrgUnitId) ?? (ids.length === 1 ? ids[0] : null);
    if (courseId === null || !names.has(courseId)) continue;
    work.push({ type: "content", id: id(c.ItemId), name: str(c.ItemName), courseId,
      courseName: names.get(courseId) ?? null, source: "scheduled_content", sourceUrl: str(c.ItemUrl), itemType: c.ItemType ?? null,
      activityType: c.ActivityType ?? null, dueDate: str(c.DueDate), startDate: str(c.StartDate), endDate: str(c.EndDate),
      isExempt: typeof c.IsExempt === "boolean" ? c.IsExempt : null, completionType: num(c.CompletionType),
      state: c.IsExempt === true ? "exempt" : c.DateCompleted ? "completed" : [1, 2].includes(num(c.CompletionType) ?? -1) ? "incomplete" : "unknown" });
  }
  // Cross-source identities are not reliably comparable: preserve them instead of silently merging distinct tasks.
  for (const event of calendar.events.filter(e => e.kind === "due_date")) work.push({ type: "calendar_deadline", id: event.id,
    courseId: event.courseId, name: event.title, dueDate: event.startDate, dueDay: event.startDay, endDate: null, state: "unknown", source: "calendar", sourceUrl: event.sourceUrl });
  let unverifiedDatesOutsideWindow = 0, undatedExcluded = 0;
  const items = work.filter(w => {
    if (!includeCompleted && DONE.includes(String(w.state))) return false;
    // All-day calendar deadlines were already restricted by the API window.
    if (str(w.dueDay)) return true;
    const withinWindow = inWindow(str(w.dueDate));
    if (!withinWindow && !str(w.dueDate)) undatedExcluded++;
    if (!withinWindow && w.source === "assignments" && !w.personalDatesVerified && w.datesSource !== "active_attempt") unverifiedDatesOutsideWindow++;
    return withinWindow;
  }).map(({ defaultDueDate, ...w }): Row => ({ ...w,
    overdue: w.source === "assignments" && !w.personalDatesVerified && w.datesSource !== "active_attempt" ? null : typeof w.dueDate === "string" ? Date.parse(w.dueDate) < now : null,
    closed: w.source === "assignments" && !w.personalDatesVerified ? null : typeof w.endDate === "string" ? Date.parse(w.endDate) < now : null,
    overdueAssumingCourseDefaults: w.source === "assignments" && !w.personalDatesVerified && typeof defaultDueDate === "string" ? Date.parse(defaultDueDate) < now : null }))
    .sort((a, b) => String(a.dueDate ?? "9999").localeCompare(String(b.dueDate ?? "9999")));
  if (unverifiedDatesOutsideWindow) recordLimit("Work excluded by unverified course-default dates may have personal extensions; inspect get_assignments without a date window");
  return { start, end, sources, unverifiedDatesOutsideWindow, undatedExcluded, calendarStatus: calendar.status,
    calendarContext: calendar.events.filter(e => e.kind !== "due_date"), items };
}
