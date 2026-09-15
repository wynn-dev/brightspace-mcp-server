import { recordLimit } from "../utils/read-status.js";
import { defineTool } from "./define-tool.js";
import { GroupsSchema } from "./workflow-schemas.js";
import { readList, readObject, rows, id, str, richText, page } from "../services/data.js";
import { toolResponse } from "./tool-helpers.js";
export const registerGetMyGroups = defineTool({ name: "get_my_groups", title: "Get My Groups",
  description: "Read your course groups and sections, group descriptions, enrollment windows and linked group assignments. Membership is filtered to the authenticated user; no joining, leaving or messaging.", schema: GroupsSchema },
async ({ courseId, offset, limit }, { apiClient }) => {
  const [user, categories, sections, folders] = await Promise.all([
    readObject(apiClient, apiClient.lp("/users/whoami")), readList(apiClient, apiClient.lp(`/${courseId}/groupcategories/`), 50),
    readList(apiClient, apiClient.lp(`/${courseId}/sections/mysections/`)), readList(apiClient, apiClient.le(courseId, "/dropbox/folders/")),
  ]);
  const ownId = id(user.data?.Identifier), groups = [], categorySources = [];
  for (const category of categories.data ?? []) {
    const categoryId = id(category.GroupCategoryId);
    if (!ownId) continue;
    if (!categoryId) { recordLimit("Group category response contained an invalid ID"); continue; }
    const result = await readList(apiClient, apiClient.lp(`/${courseId}/groupcategories/${categoryId}/groups/`));
    categorySources.push({ categoryId, status: result.status });
    for (const g of result.data ?? []) {
      if (!Array.isArray(g.Enrollments)) { recordLimit("Group membership list was unavailable in a group response"); continue; }
      if (!g.Enrollments.some(member => id(member) === ownId)) continue;
      groups.push({ id: id(g.GroupId), name: str(g.Name), code: str(g.Code), description: richText(g.Description),
        categoryId, categoryName: str(category.Name), categoryDescription: richText(category.Description),
        selfEnrollmentStartDate: str(category.SelfEnrollmentStartDate), selfEnrollmentExpiryDate: str(category.SelfEnrollmentExpiryDate),
        memberCount: g.Enrollments.length, assignments: (folders.data ?? []).filter(f => f.DropboxType === 1 && id(f.GroupTypeId) === categoryId && f.IsHidden !== true)
          .map(f => ({ id: id(f.Id), name: str(f.Name), dueDate: str(f.DueDate), instructions: richText(f.CustomInstructions) })) });
    }
  }
  return toolResponse({ courseId, sources: { identity: user.status, categories: categories.status, sections: sections.status, assignments: folders.status },
    categorySources, sections: rows(sections.data).map(s => ({ id: id(s.SectionId), name: str(s.Name), code: str(s.Code) })),
    note: "A missing sections endpoint may mean sections are not configured. Unavailable membership data is not proof of no groups.", ...page(groups, offset, limit) });
});
