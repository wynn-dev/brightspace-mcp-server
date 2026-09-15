/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { defineTool } from "./define-tool.js";
import { GetRosterSchema } from "./schemas.js";
import { readList, str, id, page } from "../services/data.js";
import { toolResponse } from "./tool-helpers.js";
const STAFF = /\b(instructor|professor|lecturer|teacher|tutor|teaching assistant|ta|docent)\b/i;
export const registerGetRoster = defineTool({ name: "get_roster", title: "Get Course Roster",
  description: "Read staff or classmates using institution-provided role names instead of institution-specific role IDs. Staff recognition is a name heuristic; roleNames selects exact institution labels. Reports denied access and unrecognized roles explicitly.", schema: GetRosterSchema },
async ({ courseId, includeStudents, searchTerm, roleNames, offset, limit }, { apiClient }) => {
  const query = searchTerm ? `?searchTerm=${encodeURIComponent(searchTerm)}` : "";
  const result = await readList(apiClient, apiClient.le(courseId, `/classlist/paged/${query}`), 2000);
  const roles = [...new Set((result.data ?? []).map(u => str(u.ClasslistRoleDisplayName)).filter((v): v is string => v !== null))];
  const names = roleNames?.map(r => r.toLocaleLowerCase());
  const roster = (result.data ?? []).filter(u => names ? names.includes(String(u.ClasslistRoleDisplayName).toLocaleLowerCase()) : includeStudents || STAFF.test(String(u.ClasslistRoleDisplayName)))
    .map(u => ({ id: id(u.Identifier), name: str(u.DisplayName), email: str(u.Email) || null, role: str(u.ClasslistRoleDisplayName) }));
  return toolResponse({ courseId, status: result.status, roleSelection: names ? "explicit_names" : includeStudents ? "all" : "staff_name_heuristic",
    availableRoles: roles, unrecognizedRoles: roles.filter(r => !STAFF.test(r)), ...page(roster, offset, limit) });
});
