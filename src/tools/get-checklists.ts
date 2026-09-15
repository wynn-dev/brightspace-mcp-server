import { recordLimit } from "../utils/read-status.js";
import { defineTool } from "./define-tool.js";
import { ChecklistsSchema } from "./workflow-schemas.js";
import { readList, readObject, id, str, num, richText, page } from "../services/data.js";
import { toolResponse } from "./tool-helpers.js";
export const registerGetChecklists = defineTool({ name: "get_checklists", title: "Get Checklists",
  description: "Read course checklists, categories, item descriptions and due dates. Brightspace's checklist API does not expose personal completion; completion is returned as unknown. Never checks or unchecks items.", schema: ChecklistsSchema },
async ({ courseId, checklistId, offset, limit }, { apiClient }) => {
  const path = apiClient.le(courseId, "/checklists/");
  const result = checklistId ? await readObject(apiClient, `${path}${checklistId}`).then(r => ({ ...r, data: r.data ? [r.data] : null })) : await readList(apiClient, path);
  const selected = page(result.data ?? [], offset, limit), checklists = [];
  for (const c of selected.items) {
    // Current institutions return ChecklistId; the public contract also documents Id.
    const checklist = id(c.ChecklistId) ?? id(c.Id);
    if (!checklist) {
      recordLimit("Checklist response contained an invalid ID; details could not be loaded");
      checklists.push({ id: null, name: str(c.Name), description: richText(c.Description),
        sources: { categories: "unavailable", items: "unavailable" }, categories: [], items: [] });
      continue;
    }
    const [categories, items] = await Promise.all([readList(apiClient, `${path}${checklist}/categories/`), readList(apiClient, `${path}${checklist}/items/`)]);
    checklists.push({ id: checklist, name: str(c.Name), description: richText(c.Description),
      sources: { categories: categories.status, items: items.status },
      categories: (categories.data ?? []).map(k => ({ id: id(k.CategoryId), name: str(k.Name), description: richText(k.Description), sortOrder: num(k.SortOrder) })),
      items: (items.data ?? []).map(i => ({ id: id(i.ChecklistItemId), categoryId: id(i.CategoryId), name: str(i.Name),
        description: richText(i.Description), dueDate: str(i.DueDate), sortOrder: num(i.SortOrder), isCompleted: null }))
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)) });
  }
  return toolResponse({ courseId, status: result.status, completionAvailable: false, ...selected, items: checklists });
});
