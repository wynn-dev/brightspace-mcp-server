import { defineTool } from "./define-tool.js";
import { BriefingSchema } from "./workflow-schemas.js";
import { workOverview } from "../services/work.js";
import { readList, mapLimit, id, str, num, richText, type Row } from "../services/data.js";
import { fetchEnrolledCourses } from "./course-helpers.js";
import { toolResponse } from "./tool-helpers.js";

const SNIPPET_CHARS = 200;
const snippet = (text: string) => text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS).trimEnd()}…` : text;
const newest = (a: { date: string | null }, b: { date: string | null }) => String(b.date ?? "").localeCompare(String(a.date ?? ""));

/** First `limit` entries plus the total, so truncation is visible. */
function section<T>(items: T[], limit: number) {
  return { total: items.length, items: items.slice(0, limit) };
}

export const registerGetBriefing = defineTool({ name: "get_briefing", title: "Get Briefing",
  description: "One-call student briefing: work due in the next daysAhead days, overdue work, announcements and grades released since `since` (default 7 days ago), and unread discussion/feedback counts per course. Use this for 'what's up', 'catch me up', 'what do I need to do' or a daily/weekly summary; follow up with get_my_work, get_announcements or get_my_grades for details.",
  schema: BriefingSchema },
async ({ courseId, daysAhead, since: sinceArg, limit }, { apiClient, config }) => {
  const since = sinceArg ? new Date(sinceArg).toISOString() : new Date(Date.now() - 7 * 86400000).toISOString();
  const enrolled = await fetchEnrolledCourses(apiClient, config);
  const courses = courseId ? [enrolled.find(c => c.id === courseId) ?? { id: courseId, name: null }] : enrolled;
  const names = new Map(courses.map(c => [c.id, c.name]));
  const ids = courses.map(c => c.id);
  const recent = (date: string | null) => !!date && Date.parse(date) >= Date.parse(since);

  const [work, news, grades, counts] = await Promise.all([
    workOverview(apiClient, config, courses, { daysAhead, daysBehind: 14, includeCompleted: false, includeUndated: false }),
    mapLimit(ids, 6, courseId => readList(apiClient, apiClient.le(courseId, "/news/"), 1000).then(r => ({ courseId, ...r }))),
    mapLimit(ids, 6, courseId => readList(apiClient, apiClient.le(courseId, "/grades/values/myGradeValues/")).then(r => ({ courseId, ...r }))),
    ids.length ? readList(apiClient, apiClient.leGlobal(`/updates/myUpdates/?orgUnitIdsCSV=${ids.slice(0, 100).join(",")}&updateTypesCSV=1,3,6`)) : null,
  ]);

  const now = Date.now();
  const item = (w: Row) => ({ course: names.get(Number(w.courseId)) ?? w.courseName ?? null, courseId: w.courseId, type: w.type, name: w.name,
    dueDate: w.dueDay ?? w.dueDate, state: w.state, ...w.overdue === null && w.overdueAssumingCourseDefaults === true ? { assumedFromCourseDefaults: true } : {} });
  const isOverdue = (w: Row) => w.overdue === true || (w.overdue === null && w.overdueAssumingCourseDefaults === true);
  const dueSoon = work.items.filter(w => !isOverdue(w) && (str(w.dueDay) || (typeof w.dueDate === "string" && Date.parse(w.dueDate) >= now))).map(item);
  const overdue = work.items.filter(isOverdue).map(item).reverse();

  const announcements = news.flatMap(({ courseId, data }) => (data ?? [])
    .filter(n => n.IsPublished !== false && recent(str(n.LastModifiedDate) ?? str(n.CreatedDate)))
    .map(n => ({ course: names.get(courseId) ?? null, courseId, id: id(n.Id), title: str(n.Title),
      date: str(n.LastModifiedDate) ?? str(n.CreatedDate), ...n.IsPinned === true ? { pinned: true } : {}, snippet: snippet(richText(n.Body).trim()) })))
    .sort(newest);

  const released = grades.flatMap(({ courseId, data }) => (data ?? [])
    .filter(g => recent(str(g.ReleasedDate) ?? str(g.LastModified)))
    .map(g => ({ course: names.get(courseId) ?? null, courseId, name: str(g.GradeObjectName), grade: str(g.DisplayedGrade),
      points: num(g.PointsNumerator) !== null && num(g.PointsDenominator) !== null ? `${g.PointsNumerator}/${g.PointsDenominator}` : null,
      date: str(g.ReleasedDate) ?? str(g.LastModified) })))
    .sort(newest);

  // Counts of -1 mean "not requested" in Brightspace; only positive counts are reported.
  const count = (value: unknown) => Math.max(0, num(value) ?? 0);
  const activity = (counts?.data ?? []).map(c => ({ courseId: id(c.OrgUnitId), unreadDiscussions: count(c.UnreadDiscussions),
    unreadFeedback: count(c.UnreadAssignmentFeedback), unattemptedQuizzes: count(c.UnattemptedQuizzes) }))
    .filter(c => c.courseId !== null && (c.unreadDiscussions > 0 || c.unreadFeedback > 0 || c.unattemptedQuizzes > 0))
    .map(c => ({ course: names.get(c.courseId!) ?? null, ...c }));

  return toolResponse({ generatedAt: new Date(now).toISOString(), since, dueUntil: work.end,
    dueSoon: section(dueSoon, limit), overdue: section(overdue, limit), announcements: section(announcements, limit),
    grades: section(released, limit), activity,
    note: "Overdue covers the last 14 days. assumedFromCourseDefaults marks items overdue by course dates when personal extensions could not be verified. Sections show the first `limit` items; total is the full count." });
});
