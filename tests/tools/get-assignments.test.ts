import { describe, it, expect } from "vitest";
import { registerGetAssignments } from "../../src/tools/get-assignments.js";
import { ApiError } from "../../src/api/index.js";
import { captureTool, fakeApiClient, parse, objectPage } from "./helpers.js";

const folder = (id: number, overrides: Record<string, unknown> = {}) => ({
  Id: id,
  CategoryId: null,
  Name: `Folder ${id}`,
  CustomInstructions: null,
  DueDate: "2026-09-10T00:00:00Z",
  IsHidden: false,
  Assessment: { ScoreDenominator: 10, Rubrics: [] },
  GroupTypeId: null,
  SubmissionType: 1,
  ...overrides,
});

const quiz = (id: number, overrides: Record<string, unknown> = {}) => ({
  QuizId: id,
  Name: `Quiz ${id}`,
  Description: null,
  StartDate: null,
  EndDate: null,
  DueDate: null,
  IsActive: true,
  AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 2 },
  TimeLimit: { IsEnforced: true, ShowClock: true, TimeLimitValue: 30 },
  ...overrides,
});

describe("get_assignments", () => {
  it("accepts dropbox folders as a plain array or an ObjectListPage and skips hidden ones", async () => {
    const arrayClient = fakeApiClient({
      "/5/dropbox/folders/": [folder(1), folder(2, { IsHidden: true })],
      "/5/quizzes/": [],
    });
    const pagedClient = fakeApiClient({
      "/5/dropbox/folders/": objectPage([folder(1)]),
      "/5/quizzes/": objectPage([]),
    });

    for (const apiClient of [arrayClient, pagedClient]) {
      const { call } = captureTool(registerGetAssignments, apiClient);
      const result = parse(await call({ courseId: 5 }));
      expect(result.courseId).toBe(5);
      expect(result.assignments.map((a: { id: number }) => a.id)).toEqual([1]);
    }
  });

  it("treats a 404 on submissions/feedback as 'none' and maps a submission when present", async () => {
    const apiClient = fakeApiClient({
      "/5/dropbox/folders/": [folder(1), folder(2)],
      "/5/quizzes/": [],
      "/folders/1/submissions/mysubmissions/": [
        {
          Id: 77,
          SubmittedBy: { Identifier: "u", DisplayName: "Me" },
          SubmissionDate: "2026-09-02T00:00:00Z",
          Comment: { Text: "done", Html: "<p>done</p>" },
          Files: [{ FileId: 9, FileName: "hw.pdf", Size: 123 }],
        },
      ],
      "/folders/1/feedback/myFeedback/": { Score: 8, Feedback: null, RubricAssessments: [] },
      "/folders/2/submissions/mysubmissions/": () => {
        throw new ApiError(404, "/x", "none");
      },
      "/folders/2/feedback/myFeedback/": () => {
        throw new ApiError(404, "/x", "none");
      },
    });
    const { call } = captureTool(registerGetAssignments, apiClient);

    const { assignments } = parse(await call({ courseId: 5 }));

    expect(assignments[0]).toMatchObject({
      type: "assignment",
      id: 1,
      points: 10,
      isGroup: false,
      submission: {
        submittedDate: "2026-09-02T00:00:00Z",
        files: [{ name: "hw.pdf", size: 123, fileId: 9 }],
        comment: "done",
      },
      feedback: { score: 8, feedback: null },
    });
    expect(assignments[1]).toMatchObject({ id: 2, submission: null, feedback: null });
  });

  it("computes quiz attempts remaining and warnings, and skips inactive quizzes", async () => {
    const apiClient = fakeApiClient({
      "/5/dropbox/folders/": [],
      "/5/quizzes/": objectPage([quiz(1), quiz(2, { IsActive: false }), quiz(3, { AttemptsAllowed: { IsUnlimited: true, NumberOfAttemptsAllowed: null } })]),
      "/quizzes/1/attempts/": objectPage([
        { AttemptId: 1, AttemptNumber: 1, Score: 6, IsCompleted: true, CompletedDate: "2026-09-01T00:00:00Z" },
      ]),
      "/quizzes/3/attempts/": [],
    });
    const { call } = captureTool(registerGetAssignments, apiClient);

    const { assignments } = parse(await call({ courseId: 5 }));

    expect(assignments.map((a: { id: number }) => a.id)).toEqual([1, 3]);
    expect(assignments[0]).toMatchObject({
      type: "quiz",
      timeLimit: 30,
      attemptsAllowed: 2,
      attemptsUsed: 1,
      attemptsRemaining: 1,
      attemptWarning: "WARNING: Only 1 attempt remaining",
      bestScore: 6,
    });
    expect(assignments[1]).toMatchObject({
      attemptsAllowed: "Unlimited",
      attemptsRemaining: "Unlimited",
      attemptWarning: null,
      bestScore: null,
    });
  });
});
