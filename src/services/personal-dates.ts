import type { D2LApiClient } from "../api/index.js";
import { readObject, str } from "./data.js";
import { recordLimit } from "../utils/read-status.js";

export interface Dates { startDate: string | null; endDate: string | null; dueDate: string | null }
/** Only the authenticated user's dedicated route is read; never enumerate other users. */
export async function personalDates(api: D2LApiClient, courseId: number, kind: string, itemId: number | null,
  userId: number | null, defaults: Dates, skip: false | "not_requested" | "not_checked_after_denial" = false) {
  const result = !skip && itemId && userId ? await readObject(api,
    api.le(courseId, `/${kind === "assignment" ? "dropbox/folders" : "quizzes"}/${itemId}/specialaccess/${userId}`)) : null;
  const data = result?.data;
  const verified = !!data && ["StartDate", "EndDate", "DueDate"].every(k => data[k] === null ||
    typeof data[k] === "string" && Number.isFinite(Date.parse(data[k] as string)));
  if (data && !verified) recordLimit("Special-access response lacks valid dates; personal deadline changes remain unverified");
  return { ...verified ? { startDate: str(data!.StartDate), endDate: str(data!.EndDate), dueDate: str(data!.DueDate) } : defaults,
    courseDefaultDates: defaults, personalDatesVerified: verified, datesSource: verified ? "special_access" : "course_defaults",
    specialAccessStatus: result?.status ?? (skip || "unavailable"),
    datesScope: verified ? "Verified own-user special access; null dates remove restrictions." : "Course defaults; personal deadline changes could not be verified.",
    specialAccess: verified ? { submissionTimeLimit: data!.SubmissionTimeLimit ?? null, attemptsAllowed: data!.AttemptsAllowed ?? null } : null };
}
