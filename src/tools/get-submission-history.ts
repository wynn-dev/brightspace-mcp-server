import { defineTool } from "./define-tool.js";
import { SubmissionSchema } from "./workflow-schemas.js";
import { getSubmissionHistory } from "../services/assignments.js";
import { page } from "../services/data.js";
import { toolResponse } from "./tool-helpers.js";
export const registerGetSubmissionHistory = defineTool({ name: "get_submission_history", title: "Get Submission History",
  description: "Read your individual or group assignment submissions, latest submission, file references, comments and published feedback including evaluated rubrics. No uploads, file saves or grading changes.", schema: SubmissionSchema },
async ({ courseId, folderId, offset, limit }, { apiClient }) => {
  const { history, ...metadata } = await getSubmissionHistory(apiClient, courseId, folderId);
  return toolResponse({ courseId, folderId, ...metadata, latestSubmission: history[0] ?? null, ...page(history, offset, limit) });
});
