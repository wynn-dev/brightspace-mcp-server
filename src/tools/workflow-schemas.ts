import { z } from "zod";
export const courseId = z.coerce.number().int().positive();
export const paging = { offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(25) };
export const instant = z.iso.datetime({ offset: true });
export const zone = z.string().max(100).default("UTC").refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }, "Invalid IANA time zone");
/** Calendar window defaults: from now, for 14 days. */
export function calendarWindow(start?: string, end?: string) {
  const from = start ?? new Date().toISOString();
  return { start: from, end: end ?? new Date(Date.parse(from) + 14 * 86400000).toISOString() };
}
export const CalendarSchema = z.object({ courseId: courseId.optional(),
  start: instant.optional().describe("Window start (ISO 8601). Defaults to now."),
  end: instant.optional().describe("Window end, exclusive. Defaults to 14 days after start."),
  timeZone: zone, occurrences: z.boolean().default(true), ...paging })
  .refine(v => { const w = calendarWindow(v.start, v.end); return Date.parse(w.end) > Date.parse(w.start) && Date.parse(w.end) - Date.parse(w.start) <= 366 * 86400000; },
    "Calendar window must be positive and at most 366 days");
export const WorkSchema = z.object({ courseId: courseId.optional(), daysAhead: z.coerce.number().int().min(1).max(90).default(14),
  daysBehind: z.coerce.number().int().min(0).max(90).default(14), includeCompleted: z.boolean().default(false), includeUndated: z.boolean().default(false),
  includeCalendarContext: z.boolean().default(false), ...paging });
export const BriefingSchema = z.object({ courseId: courseId.optional(),
  daysAhead: z.coerce.number().int().min(1).max(30).default(7).describe("Days ahead for due work (default 7)."),
  since: instant.optional().describe("Announcements and grades after this time (ISO 8601). Defaults to 7 days ago."),
  limit: z.coerce.number().int().min(1).max(50).default(10).describe("Maximum items per section.") });
export const SubmissionSchema = z.object({ courseId, folderId: courseId, ...paging });
export const UpdatesSchema = z.object({ courseId: courseId.optional(),
  since: instant.optional().describe("Only updates after this time (ISO 8601). Defaults to 7 days ago."), until: instant.optional(), ...paging });
export const GroupsSchema = z.object({ courseId, ...paging });
export const ChecklistsSchema = z.object({ courseId, checklistId: courseId.optional(), ...paging });
export const SearchSchema = z.object({ courseId: courseId.optional(), query: z.string().trim().min(2).max(200),
  sources: z.array(z.enum(["announcements", "assignments", "content", "discussions", "course", "documents"])).min(1).default(["announcements", "assignments", "content", "course"])
    .describe("Sources to search. Discussions and document bodies are opt-in because they need many reads."),
  documentOffset: z.coerce.number().int().min(0).default(0), maxDocuments: z.coerce.number().int().min(1).max(10).default(3),
  maxDocumentChars: z.coerce.number().int().min(100).max(50_000).default(20_000),
  documentTopicIds: z.array(courseId).min(1).max(10).optional(), ...paging });
export const GradeSchema = z.object({ courseId, scenarios: z.array(z.object({ gradeItemId: courseId, points: z.number().finite().min(0) })).max(100).default([]) });
