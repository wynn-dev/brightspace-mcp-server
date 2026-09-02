/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { DEFAULT_CACHE_TTLS, getAllObjectListPages, isApiStatus, type D2LApiClient } from "../api/index.js";
import { GetAssignmentsSchema } from "./schemas.js";
import { defineTool } from "./define-tool.js";
import { fetchEnrolledCourses, settleAcrossCourses } from "./course-helpers.js";
import { toolResponse } from "./tool-helpers.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { log } from "../utils/logger.js";

// D2L Dropbox API types
interface DropboxFolder {
  Id: number;
  CategoryId: number | null;
  Name: string;
  CustomInstructions: { Text: string; Html: string } | null;
  DueDate: string | null;
  IsHidden: boolean;
  Assessment: {
    ScoreDenominator: number | null;
    Rubrics: Array<{
      RubricId: number;
      Name: string;
      Criteria: Array<{
        CriterionId: number;
        Name: string;
        Levels: Array<{
          LevelId: number;
          Name: string;
          Points: number;
          Description: { Text: string; Html: string } | null;
        }>;
      }>;
    }>;
  } | null;
  GroupTypeId: number | null; // null = individual, non-null = group
  SubmissionType: number | null;
}

interface DropboxSubmission {
  Id: number;
  SubmittedBy: { Identifier: string; DisplayName: string };
  SubmissionDate: string;
  Comment: { Text: string; Html: string } | null;
  Files: Array<{ FileId: number; FileName: string; Size: number }>;
}

interface DropboxFeedback {
  Score: number | null;
  Feedback: { Text: string; Html: string } | null;
  RubricAssessments: unknown[];
}

// D2L Quiz API types
interface QuizReadData {
  QuizId: number;
  Name: string;
  Description: { Text: string; Html: string } | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsActive: boolean;
  AttemptsAllowed: {
    IsUnlimited: boolean;
    NumberOfAttemptsAllowed: number | null;
  } | null;
  TimeLimit: {
    IsEnforced: boolean;
    ShowClock: boolean;
    TimeLimitValue: number; // minutes
  } | null;
}

interface QuizAttemptData {
  AttemptId: number;
  AttemptNumber: number;
  Score: number | null;
  IsCompleted: boolean;
  CompletedDate: string | null;
}

function mapDropboxFolder(
  folder: DropboxFolder,
  submissions: DropboxSubmission[],
  feedback: DropboxFeedback | null
) {
  return {
    type: "assignment",
    id: folder.Id,
    name: folder.Name,
    instructions: folder.CustomInstructions?.Html
      ? convertHtmlToMarkdown(folder.CustomInstructions.Html)
      : { markdown: "", html: "" },
    dueDate: folder.DueDate,
    points: folder.Assessment?.ScoreDenominator ?? null,
    isGroup: folder.GroupTypeId !== null,
    rubric:
      folder.Assessment?.Rubrics?.map((r) => ({
        name: r.Name,
        criteria:
          r.Criteria?.map((c) => ({
            name: c.Name,
            levels:
              c.Levels?.map((l) => ({
                name: l.Name,
                points: l.Points,
                description: l.Description?.Text ?? null,
              })) ?? [],
          })) ?? [],
      })) ?? null,
    submission:
      submissions.length > 0
        ? {
            submittedDate: submissions[0].SubmissionDate,
            files:
              submissions[0].Files?.map((f) => ({
                name: f.FileName,
                size: f.Size,
                fileId: f.FileId,
              })) ?? [],
            comment: submissions[0].Comment?.Text ?? null,
          }
        : null,
    feedback: feedback
      ? {
          score: feedback.Score,
          feedback: feedback.Feedback?.Html ? convertHtmlToMarkdown(feedback.Feedback.Html) : null,
        }
      : null,
  };
}

function mapQuiz(quiz: QuizReadData, attempts: QuizAttemptData[]) {
  const completedAttempts = attempts.filter((a) => a.IsCompleted);
  let attemptsRemaining: number | string = "Unlimited";
  let attemptWarning: string | null = null;

  if (quiz.AttemptsAllowed && !quiz.AttemptsAllowed.IsUnlimited) {
    const allowed = quiz.AttemptsAllowed.NumberOfAttemptsAllowed ?? 0;
    attemptsRemaining = allowed - completedAttempts.length;
    if (attemptsRemaining <= 0) {
      attemptWarning = "WARNING: No attempts remaining";
    } else if (attemptsRemaining === 1) {
      attemptWarning = "WARNING: Only 1 attempt remaining";
    }
  }

  return {
    type: "quiz",
    id: quiz.QuizId,
    name: quiz.Name,
    instructions: quiz.Description?.Html
      ? convertHtmlToMarkdown(quiz.Description.Html)
      : { markdown: "", html: "" },
    dueDate: quiz.DueDate,
    startDate: quiz.StartDate,
    endDate: quiz.EndDate,
    timeLimit: quiz.TimeLimit?.IsEnforced ? quiz.TimeLimit.TimeLimitValue : null,
    attemptsAllowed: quiz.AttemptsAllowed?.IsUnlimited
      ? "Unlimited"
      : quiz.AttemptsAllowed?.NumberOfAttemptsAllowed ?? null,
    attemptsUsed: completedAttempts.length,
    attemptsRemaining,
    attemptWarning,
    bestScore:
      completedAttempts.length > 0
        ? Math.max(...completedAttempts.map((a) => a.Score ?? 0))
        : null,
  };
}

type CourseAssignment = ReturnType<typeof mapDropboxFolder> | ReturnType<typeof mapQuiz>;

/**
 * Fetch assignments (dropbox folders + quizzes) for a single course.
 * Missing submissions/feedback/attempts (404, and 403 for the latter two) are
 * normal and treated as "none".
 */
async function fetchCourseAssignments(
  apiClient: D2LApiClient,
  courseId: number
): Promise<CourseAssignment[]> {
  const ttl = DEFAULT_CACHE_TTLS.assignments;
  const assignments: CourseAssignment[] = [];

  const [dropboxResult, quizResult] = await Promise.allSettled([
    getAllObjectListPages<DropboxFolder>(apiClient, apiClient.le(courseId, "/dropbox/folders/"), {
      ttl,
      label: "dropbox folders",
    }),
    getAllObjectListPages<QuizReadData>(apiClient, apiClient.le(courseId, "/quizzes/"), {
      ttl,
      label: "quizzes",
    }),
  ]);

  if (dropboxResult.status === "fulfilled") {
    for (const folder of dropboxResult.value) {
      if (folder.IsHidden) continue;

      let submissions: DropboxSubmission[] = [];
      try {
        submissions = await getAllObjectListPages<DropboxSubmission>(
          apiClient,
          apiClient.le(courseId, `/dropbox/folders/${folder.Id}/submissions/mysubmissions/`),
          { ttl, label: "submissions" }
        );
      } catch (error) {
        if (!isApiStatus(error, 404)) {
          log("DEBUG", `Failed to fetch submissions for folder ${folder.Id}`, error);
        }
      }

      let feedback: DropboxFeedback | null = null;
      try {
        feedback = await apiClient.get<DropboxFeedback>(
          apiClient.le(courseId, `/dropbox/folders/${folder.Id}/feedback/myFeedback/`),
          { ttl }
        );
      } catch (error) {
        if (!isApiStatus(error, 404, 403)) {
          log("DEBUG", `Failed to fetch feedback for folder ${folder.Id}`, error);
        }
      }

      assignments.push(mapDropboxFolder(folder, submissions, feedback));
    }
  } else {
    log("DEBUG", `Failed to fetch dropbox folders for course ${courseId}`, dropboxResult.reason);
  }

  if (quizResult.status === "fulfilled") {
    for (const quiz of quizResult.value) {
      if (!quiz.IsActive) continue;

      let attempts: QuizAttemptData[] = [];
      try {
        attempts = await getAllObjectListPages<QuizAttemptData>(
          apiClient,
          apiClient.le(courseId, `/quizzes/${quiz.QuizId}/attempts/`),
          { ttl, label: "quiz attempts" }
        );
      } catch (error) {
        if (!isApiStatus(error, 404, 403)) {
          log("DEBUG", `Failed to fetch attempts for quiz ${quiz.QuizId}`, error);
        }
      }

      assignments.push(mapQuiz(quiz, attempts));
    }
  } else {
    log("DEBUG", `Failed to fetch quizzes for course ${courseId}`, quizResult.reason);
  }

  return assignments;
}

export const registerGetAssignments = defineTool(
  {
    name: "get_assignments",
    title: "Get Assignments",
    description:
      "Fetch assignments and quizzes for a specific course or all enrolled courses. Shows dropbox submissions and quizzes with due dates, status, and rubric info. Use this when the user asks about assignments, homework, what to submit, quizzes, or assignment details and rubrics.",
    schema: GetAssignmentsSchema,
  },
  async ({ courseId }, { apiClient, config }) => {
    if (courseId) {
      const assignments = await fetchCourseAssignments(apiClient, courseId);
      log("INFO", `get_assignments: Retrieved ${assignments.length} assignments for course ${courseId}`);
      return toolResponse({ courseId, assignments });
    }

    const enrolled = await fetchEnrolledCourses(apiClient, config);
    const courses = await settleAcrossCourses(enrolled, "get_assignments", async (course) => ({
      courseId: course.id,
      courseName: course.name,
      assignments: await fetchCourseAssignments(apiClient, course.id),
    }));

    log("INFO", `get_assignments: Retrieved assignments for ${courses.length} of ${enrolled.length} courses`);
    return toolResponse({ courses });
  }
);
