import { readSource } from "../utils/read-status.js";
import type { D2LApiClient } from "../api/index.js";
import { object, rows, str, num, id, richText, readList, readObject, page, type Row } from "./data.js";

const files = (value: unknown) => rows(value).map(f => ({ fileId: id(f.FileId), name: str(f.FileName), size: num(f.Size) }));
export function mapSubmissionEntities(entities: Row[]) {
  const history = entities.flatMap(e => rows(e.Submissions).map(s => ({
    id: id(s.Id), entityId: id(object(e.Entity).EntityId), entityType: str(object(e.Entity).EntityType),
    submittedBy: str(object(s.SubmittedBy).DisplayName), submittedDate: str(s.SubmissionDate),
    files: files(s.Files), comment: richText(s.Comment),
  }))).sort((a, b) => (b.submittedDate ?? "").localeCompare(a.submittedDate ?? ""));
  const feedback = entities.flatMap(e => {
    const f = object(e.Feedback);
    // Self-submission responses include released feedback; never surface explicitly ungraded drafts.
    if (!Object.keys(f).length || f.IsGraded !== true) return [];
    return [{ entityId: id(object(e.Entity).EntityId), score: num(f.Score), feedback: richText(f.Feedback),
      gradedSymbol: str(f.GradedSymbol), rubricAssessments: rows(f.RubricAssessments), files: files(f.Files),
      links: rows(f.Links).map(l => ({ id: id(l.LinkId), name: str(l.LinkName), url: str(l.Href) })) }];
  });
  const completionDate = entities.map(e => str(e.CompletionDate)).filter((d): d is string => !!d).sort().at(-1) ?? null;
  return { history, feedback, completionDate };
}
export async function getSubmissionHistory(api: D2LApiClient, courseId: number, folderId: number) {
  const path = api.le(courseId, `/dropbox/folders/${folderId}/submissions/mysubmissions/`);
  const result = await readList(api, path);
  if (result.status !== "available") return { status: result.status, complete: false, ...mapSubmissionEntities([]) };
  const mapped = await readSource(path, async () => {
    if (result.data?.some(e => !Array.isArray(e.Submissions) || !Object.keys(object(e.Entity)).length || rows(e.Submissions).some(s => !id(s.Id))))
      throw new Error("Invalid EntityDropbox response");
    return mapSubmissionEntities(result.data ?? []);
  });
  return { status: mapped.status, complete: result.complete && mapped.status === "available", ...mapped.data ?? mapSubmissionEntities([]) };
}
export async function fetchCourseAssignments(api: D2LApiClient, courseId: number,
  options: { offset?: number; limit?: number; folderId?: number; includeDetails?: boolean } = {}) {
  const { offset = 0, limit = 25, folderId, includeDetails = true } = options;
  const [folders, quizzes] = await Promise.all([
    folderId ? readObject(api, api.le(courseId, `/dropbox/folders/${folderId}`)).then(r => ({ ...r, data: r.data ? [r.data] : null })) :
      readList(api, api.le(courseId, "/dropbox/folders/")),
    folderId ? Promise.resolve({ status: "available" as const, data: [] as Row[] }) : readList(api, api.le(courseId, "/quizzes/")),
  ]);
  const all = [...(folders.data ?? []).filter(f => f.IsHidden !== true).map(row => ({ kind: "assignment", row })),
    ...(quizzes.data ?? []).filter(q => q.IsActive !== false).map(row => ({ kind: "quiz", row }))];
  const selected = page(all, offset, limit);
  const user = includeDetails && selected.items.some(x => x.kind === "quiz") ?
    await readObject(api, api.lp("/users/whoami")) : null;
  const ownId = id(user?.data?.Identifier);
  const assignments = [];
  for (const { kind, row: r } of selected.items) {
    if (kind === "assignment") {
      const folder = id(r.Id);
      const submissions = includeDetails && folder ? await getSubmissionHistory(api, courseId, folder) : null;
      const assessment = object(r.Assessment), availability = object(r.Availability);
      const state = !submissions || submissions.status !== "available" ? "unknown" : submissions.completionDate ? "completed" :
        submissions.history.length ? "submitted" : !submissions.complete ? "unknown" : [0, 1, 4].includes(num(r.SubmissionType) ?? -1) ? "not_submitted" : "unknown";
      assignments.push({ type: kind, id: folder, name: str(r.Name), instructions: richText(r.CustomInstructions),
        dueDate: str(r.DueDate), startDate: str(availability.StartDate), endDate: str(availability.EndDate),
        datesScope: "Course defaults; individual special-access dates are not verified.",
        points: num(assessment.ScoreDenominator), isGroup: r.DropboxType === 1, groupCategoryId: id(r.GroupTypeId),
        submissionType: num(r.SubmissionType), completionType: num(r.CompletionType), gradeItemId: id(r.GradeItemId),
        attachments: files(r.Attachments), allowableFileType: r.AllowableFileType ?? null,
        customAllowableFileTypes: r.CustomAllowableFileTypes ?? null, rubric: rows(assessment.Rubrics),
        state, submissionStatus: submissions?.status ?? "not_requested", submission: submissions?.history[0] ?? null,
        submissionHistory: submissions?.history ?? [], feedback: submissions?.feedback[0] ?? null,
        allFeedback: submissions?.feedback ?? [], completionDate: submissions?.completionDate ?? null });
    } else {
      const quizId = id(r.QuizId);
      const attempts = includeDetails && ownId && quizId ? await readList(api,
        api.le(courseId, `/quizzes/${quizId}/attempts/?userId=${ownId}`)) : null;
      const own = (attempts?.data ?? []).filter(a => id(a.UserId) === ownId).map(a => ({
        id: id(a.AttemptId), attemptNumber: num(a.AttemptNumber), started: str(a.Started), completed: str(a.Completed),
        isPublished: a.IsPublished === true, score: a.IsPublished === true ? num(a.Score) : null,
        feedback: a.IsPublished === true ? richText(a.AttemptFeedback) : "", dueDate: str(a.AttemptDueDate),
      })).sort((a, b) => (b.attemptNumber ?? 0) - (a.attemptNumber ?? 0));
      const allowed = object(r.AttemptsAllowed), timing = object(r.SubmissionTimeLimit);
      const scores = own.map(a => a.score).filter((s): s is number => s !== null);
      assignments.push({ type: kind, id: quizId, name: str(r.Name), instructions: richText(r.Instructions) || richText(r.Description),
        dueDate: str(r.DueDate), startDate: str(r.StartDate), endDate: str(r.EndDate), gradeItemId: id(r.GradeItemId),
        state: !attempts?.complete ? "unknown" : own.some(a => a.completed) ? "attempt_completed" : own.length ? "in_progress" : "not_started",
        timeLimit: timing.IsEnforced === true ? num(timing.TimeLimitValue) : null, isSynchronous: r.IsSynchronous === true,
        attemptsAllowed: allowed.IsUnlimited === true ? "Unlimited" : num(allowed.NumberOfAttemptsAllowed),
        attemptsUsed: attempts?.complete ? own.length : null, attemptsRemaining: null,
        attemptsRemainingAssumingDefault: !attempts?.complete ? null : allowed.IsUnlimited === true ? "Unlimited" :
          num(allowed.NumberOfAttemptsAllowed) === null ? null : Math.max(0, Number(allowed.NumberOfAttemptsAllowed) - own.length),
        settingsScope: "Course defaults; individual special access may change dates, time limits and attempts.",
        attemptStatus: attempts?.status ?? "unavailable", attempts: own, bestScore: scores.length ? Math.max(...scores) : null });
    }
  }
  return { assignments, offset, nextOffset: selected.nextOffset, matchedCount: selected.matchedCount,
    sources: { assignments: folders.status, quizzes: quizzes.status } };
}
