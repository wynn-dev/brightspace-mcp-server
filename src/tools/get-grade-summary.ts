import { defineTool } from "./define-tool.js";
import { GradeSchema } from "./workflow-schemas.js";
import { gradeSummary } from "../services/grades.js";
import { toolResponse } from "./tool-helpers.js";
export const registerGetGradeSummary = defineTool({ name: "get_grade_summary", title: "Explain Grades and Calculate Scenarios",
  description: "Read visible grades, item rules, categories and official final grade separately. Optional scenario points change only an in-memory projection. Calculates only verified uncategorized numeric Points/Weighted rules and personal exemptions; refuses formulas, bonus, drop/category rules or missing data. Never writes grades.", schema: GradeSchema },
async ({ courseId, scenarios }, { apiClient }) => toolResponse(await gradeSummary(apiClient, courseId, scenarios)));
