import { describe, it, expect } from "vitest";
import { registerGetRoster } from "../../src/tools/get-roster.js";
import { ApiError } from "../../src/api/index.js";
import { captureTool, fakeApiClient, parse, objectPage } from "./helpers.js";
const user = (Identifier: number, role: string) => ({ Identifier, DisplayName: `User ${Identifier}`, Email: "person@example.edu", ClasslistRoleDisplayName: role });
describe("institution-aware roster", () => {
  it("uses role names and exposes unrecognized roles without Purdue IDs", async () => {
    const api = fakeApiClient({ "/classlist/paged/": objectPage([user(1, "Docent"), user(2, "TA"), user(3, "Student"), user(4, "Course Lead")]) });
    const r = parse(await captureTool(registerGetRoster, api).call({ courseId: 4, searchTerm: "smith" }));
    expect(r.items.map((x: any) => x.id)).toEqual([1, 2]); expect(r.availableRoles).toContain("Course Lead");
    expect(api.requested).toEqual(["/d2l/api/le/1.0/4/classlist/paged/?searchTerm=smith"]);
    const explicit = parse(await captureTool(registerGetRoster, api).call({ courseId: 4, roleNames: ["Course Lead"] }));
    expect(explicit.items.map((x: any) => x.id)).toEqual([4]);
  });
  it("provides continuation through large rosters", async () => {
    const api = fakeApiClient({ "/classlist/paged/": objectPage(Array.from({ length: 120 }, (_, i) => user(i + 1, "Student"))) });
    const call = captureTool(registerGetRoster, api).call;
    expect(parse(await call({ courseId: 4, includeStudents: true, limit: 100 })).nextOffset).toBe(100);
    const last = parse(await call({ courseId: 4, includeStudents: true, limit: 100, offset: 100 }));
    expect(last.items).toHaveLength(20); expect(last.nextOffset).toBeNull();
  });
  it("reports forbidden access as unavailable, not an empty staff success", async () => {
    const api = fakeApiClient({ "/classlist/paged/": () => { throw new ApiError(403, "/x", "private"); } });
    const r = await captureTool(registerGetRoster, api).call({ courseId: 4 });
    expect(parse(r).status).toBe("forbidden"); expect(r.structuredContent?.readStatus).toMatchObject({ partial: true });
  });
});
