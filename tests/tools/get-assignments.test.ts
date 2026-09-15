import { describe, it, expect } from "vitest";
import { registerGetAssignments } from "../../src/tools/get-assignments.js";
import { registerGetSubmissionHistory } from "../../src/tools/get-submission-history.js";
import { ApiError } from "../../src/api/index.js";
import { captureTool, fakeApiClient, parse, objectPage } from "./helpers.js";
const folder = (Id: number, extra = {}) => ({ Id, Name: `Folder ${Id}`, IsHidden: false, DropboxType: 2, SubmissionType: 0, Assessment: { ScoreDenominator: 10, Rubrics: [] }, ...extra });
const entity = (Submissions: unknown[], extra = {}) => ({ Entity: { EntityId: 42, EntityType: "Group" }, Submissions, ...extra });
const submission = (Id: number, SubmissionDate: string) => ({ Id, SubmissionDate, Comment: { Text: "done" }, Files: [{ FileId: Id, FileName: "work.pdf", Size: 12 }] });
const forbidden = () => { throw new ApiError(403, "/x", "private response"); };
describe("assignment reliability and submission history", () => {
  it("follows folder pages and distinguishes unavailable, empty and submitted histories", async () => {
    const api = fakeApiClient({ "/5/dropbox/folders/": objectPage([folder(1), folder(2, { IsHidden: true })], "/folders-next"),
      "/folders-next": objectPage([folder(3), folder(4)]), "/5/quizzes/": [],
      "/folders/1/submissions/mysubmissions/": [entity([submission(1, "2026-09-01T00:00:00Z")])],
      "/folders/3/submissions/mysubmissions/": forbidden, "/folders/4/submissions/mysubmissions/": [] });
    const response = await captureTool(registerGetAssignments, api).call({ courseId: 5 });
    const result = parse(response);
    expect(result.assignments.map((a: any) => [a.id, a.state])).toEqual([[1, "submitted"], [3, "unknown"], [4, "not_submitted"]]);
    expect(response.structuredContent?.readStatus).toMatchObject({ partial: true });
    expect(api.requested.some(p => p.includes("myFeedback"))).toBe(false);
  });
  it("sorts all entity histories, includes group feedback and pages without losing latest", async () => {
    const api = fakeApiClient({ "/mysubmissions/": [entity([submission(1, "2026-09-01T00:00:00Z"), submission(2, "2026-09-03T00:00:00Z")],
      { Feedback: { IsGraded: true, Score: 8, Feedback: { Html: "<p>Well done</p>" }, RubricAssessments: [{ RubricId: 4 }], Files: [], Links: [{ LinkId: 3, LinkName: "feedback", Href: "/feedback" }] } }),
      entity([submission(3, "2026-09-02T00:00:00Z")], { Feedback: { IsGraded: false, Score: 1, Feedback: { Text: "draft" } } })] });
    const r = parse(await captureTool(registerGetSubmissionHistory, api).call({ courseId: 5, folderId: 1, offset: 1, limit: 1 }));
    expect(r.latestSubmission.id).toBe(2); expect(r.items[0].id).toBe(3); expect(r.nextOffset).toBe(2);
    expect(r.feedback).toHaveLength(1); expect(r.feedback[0]).toMatchObject({ score: 8, feedback: "Well done", rubricAssessments: [{ RubricId: 4 }] });
    expect(JSON.stringify(r)).not.toContain("draft");
  });
  it("rejects the former flat submission shape instead of inventing no submission", async () => {
    const api = fakeApiClient({ "/mysubmissions/": [submission(1, "2026-09-01T00:00:00Z")] });
    const result = parse(await captureTool(registerGetSubmissionHistory, api).call({ courseId: 5, folderId: 1 }));
    expect(result.status).toBe("error");
  });
  it("filters quiz attempts to the authenticated user and never reveals unpublished scores", async () => {
    const api = fakeApiClient({ "/users/whoami": { Identifier: "42" }, "/5/dropbox/folders/": [], "/5/quizzes/": [{ QuizId: 1, Name: "Quiz", IsActive: true,
      Instructions: { IsDisplayed: true, Text: { Html: "<p>Instructions</p>" } }, SubmissionTimeLimit: { IsEnforced: true, TimeLimitValue: 30 },
      AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 3 } }], "/quizzes/1/attempts/": [
        { AttemptId: 1, UserId: 42, AttemptNumber: 1, Completed: "2026-09-01T00:00:00Z", IsPublished: true, Score: null },
        { AttemptId: 2, UserId: 42, AttemptNumber: 2, Completed: null, IsPublished: false, Score: 9, AttemptFeedback: { Text: "draft" } },
        { AttemptId: 3, UserId: 99, AttemptNumber: 1, IsPublished: true, Score: 100 },
      ] });
    const r = parse(await captureTool(registerGetAssignments, api).call({ courseId: 5 })).assignments[0];
    expect(r).toMatchObject({ timeLimit: 30, instructions: "Instructions", attemptsUsed: 2, attemptsRemaining: null, attemptsRemainingAssumingDefault: 1, bestScore: null });
    expect(r.attempts).toHaveLength(2); expect(r.attempts.every((a: any) => a.score === null)).toBe(true);
    expect(api.requested.some(p => p.endsWith("attempts/?userId=42"))).toBe(true);
  });
  it("pages assignments before fetching details", async () => {
    const api = fakeApiClient({ "/5/dropbox/folders/": [folder(1), folder(2)], "/5/quizzes/": [], "/mysubmissions/": [] });
    const r = parse(await captureTool(registerGetAssignments, api).call({ courseId: 5, limit: 1 }));
    expect(r.nextOffset).toBe(1); expect(api.requested.filter(p => p.includes("mysubmissions"))).toHaveLength(1);
  });
});
