import { defineTool } from "./define-tool.js";
import { WorkSchema } from "./workflow-schemas.js";
import { fetchCourseAssignments } from "../services/assignments.js";
import { fetchCalendar } from "../services/calendar.js";
import { readList, id, str, num, page, type Row } from "../services/data.js";
import { fetchEnrolledCourses } from "./course-helpers.js";
import { recordLimit } from "../utils/read-status.js";
import { toolResponse } from "./tool-helpers.js";
export const registerGetMyWork = defineTool({ name: "get_my_work", title: "Get My Work",
  description: "Build a bounded work overview from assignments, quizzes, scheduled content and calendar deadlines, including overdue and undated work. Completion, unavailable data and exemptions remain explicit; calendar reminders are separate. Use for weekly briefings.", schema: WorkSchema },
async ({ courseId, daysAhead, daysBehind, includeCompleted, includeUndated, offset, limit }, { apiClient, config }) => {
  const courses = courseId ? [{ id: courseId, name: null }] : await fetchEnrolledCourses(apiClient, config);
  const now = Date.now(), start = new Date(now - daysBehind * 86400000).toISOString(), end = new Date(now + daysAhead * 86400000).toISOString();
  const work: Row[] = [], sources = [];
  for (const course of courses) {
    const [assignments, content] = await Promise.all([
      fetchCourseAssignments(apiClient, course.id, { limit: 100 }), readList(apiClient, apiClient.le(course.id, "/content/myItems/")),
    ]);
    if (assignments.nextOffset !== null) recordLimit(`Work overview: first 100 assignments/quizzes for course ${course.id}; use get_assignments pagination`);
    sources.push({ courseId: course.id, ...assignments.sources, scheduledContent: content.status });
    for (const a of assignments.assignments) work.push({ type: a.type, id: a.id, name: a.name, state: a.state,
      dueDate: a.dueDate, startDate: a.startDate, endDate: a.endDate, datesScope: "course_defaults; individual special access is not verified",
      courseId: course.id, courseName: course.name,
      source: "assignments", sourceUrl: `${config.baseUrl.replace(/\/$/, "")}/d2l/home/${course.id}` });
    for (const c of content.data ?? []) work.push({ type: "content", id: id(c.ItemId), name: str(c.ItemName), courseId: course.id,
      courseName: course.name, datesScope: "personal_scheduled_content", source: "scheduled_content", sourceUrl: str(c.ItemUrl), itemType: c.ItemType ?? null,
      activityType: c.ActivityType ?? null, dueDate: str(c.DueDate), startDate: str(c.StartDate), endDate: str(c.EndDate),
      isExempt: typeof c.IsExempt === "boolean" ? c.IsExempt : null, completionType: num(c.CompletionType),
      state: c.IsExempt === true ? "exempt" : c.DateCompleted ? "completed" : [1, 2].includes(num(c.CompletionType) ?? -1) ? "incomplete" : "unknown" });
  }
  const calendar = await fetchCalendar(apiClient, courses.map(c => c.id), start, end, "UTC", false);
  // Cross-source identities are not reliably comparable: preserve them instead of silently merging distinct tasks.
  for (const event of calendar.events.filter(e => e.kind === "due_date")) work.push({ type: "calendar_deadline", id: event.id,
    courseId: event.courseId, name: event.title, dueDate: event.startDate, dueDay: event.startDay, datesScope: "calendar", endDate: null, state: "unknown", source: "calendar", sourceUrl: event.sourceUrl });
  const selected = work.filter(w => {
    if (!includeCompleted && ["completed", "submitted", "attempt_completed", "exempt"].includes(String(w.state))) return false;
    // All-day calendar deadlines were already restricted by the API window.
    if (str(w.dueDay)) return true;
    const due = str(w.dueDate);
    return due ? Date.parse(due) >= Date.parse(start) && Date.parse(due) <= Date.parse(end) : includeUndated;
  }).map((w): Row => ({ ...w, overdue: typeof w.dueDate === "string" ? Date.parse(w.dueDate) < now : null,
    closed: typeof w.endDate === "string" ? Date.parse(w.endDate) < now : null }))
    .sort((a, b) => String(a.dueDate ?? "9999").localeCompare(String(b.dueDate ?? "9999")));
  const calendarContext = calendar.events.filter(e => e.kind !== "due_date");
  if (calendarContext.length > limit) recordLimit("Calendar context limited; use get_calendar for continuation");
  return toolResponse({ start, end, sources, calendarStatus: calendar.status,
    note: "Sources may refer to the same activity. Submitted assignments and completed quiz attempts may still allow further submissions. Unknown completion does not mean unfinished.",
    calendarContext: calendarContext.slice(0, limit), calendarContextHasMore: calendarContext.length > limit, ...page(selected, offset, limit) });
});
