import { z } from "zod";
export const courseId = z.coerce.number().int().positive();
export const paging = { offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(25) };
export const instant = z.iso.datetime({ offset: true });
export const zone = z.string().max(100).default("UTC").refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }, "Invalid IANA time zone");
export const CalendarSchema = z.object({ courseId: courseId.optional(), start: instant, end: instant, timeZone: zone, occurrences: z.boolean().default(true), ...paging })
  .refine(v => Date.parse(v.end) > Date.parse(v.start) && Date.parse(v.end) - Date.parse(v.start) <= 366 * 86400000, "Calendar window must be positive and at most 366 days");
export const WorkSchema = z.object({ courseId: courseId.optional(), daysAhead: z.coerce.number().int().min(1).max(90).default(14),
  daysBehind: z.coerce.number().int().min(0).max(90).default(14), includeCompleted: z.boolean().default(false), includeUndated: z.boolean().default(true), ...paging });
export const SubmissionSchema = z.object({ courseId, folderId: courseId, ...paging });
export const UpdatesSchema = z.object({ courseId: courseId.optional(), since: instant, until: instant.optional(), ...paging });
export const GroupsSchema = z.object({ courseId, ...paging });
export const ChecklistsSchema = z.object({ courseId, checklistId: courseId.optional(), ...paging });
export const SearchSchema = z.object({ courseId: courseId.optional(), query: z.string().trim().min(2).max(200),
  sources: z.array(z.enum(["announcements", "assignments", "content", "discussions", "course"])).min(1).default(["announcements", "assignments", "content", "discussions", "course"]), ...paging });
export const GradeSchema = z.object({ courseId, scenarios: z.array(z.object({ gradeItemId: courseId, points: z.number().finite().min(0) })).max(100).default([]) });
