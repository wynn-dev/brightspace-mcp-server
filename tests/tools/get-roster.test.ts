import { describe, it, expect } from "vitest";
import { registerGetRoster } from "../../src/tools/get-roster.js";
import { captureTool, fakeApiClient, parse, objectPage } from "./helpers.js";

const user = (id: number, role: string, email: string | null = `u${id}@x.edu`) => ({
  Identifier: id,
  DisplayName: `User ${id}`,
  Email: email,
  FirstName: null,
  LastName: null,
  RoleId: null,
  ClasslistRoleDisplayName: role,
  IsOnline: false,
  LastAccessed: null,
});

describe("get_roster", () => {
  it("fetches instructors (109) and TAs (135) by default and forwards searchTerm", async () => {
    const apiClient = fakeApiClient({
      "roleId=109": objectPage([user(1, "Instructor")]),
      "roleId=135": objectPage([user(2, "TA", null)]),
    });
    const { call } = captureTool(registerGetRoster, apiClient);

    const result = parse(await call({ courseId: 4, searchTerm: "smith" }));

    expect(result).toEqual([
      { name: "User 1", email: "u1@x.edu", role: "Instructor" },
      { name: "User 2", email: null, role: "TA" },
    ]);
    expect(apiClient.requested.sort()).toEqual([
      "/d2l/api/le/1.0/4/classlist/paged/?roleId=109&searchTerm=smith",
      "/d2l/api/le/1.0/4/classlist/paged/?roleId=135&searchTerm=smith",
    ]);
  });

  it("returns everyone with includeStudents, capped at 100", async () => {
    const everyone = Array.from({ length: 120 }, (_, i) => user(i + 1, "Student"));
    const apiClient = fakeApiClient({ "/4/classlist/paged/": objectPage(everyone) });
    const { call } = captureTool(registerGetRoster, apiClient);

    const result = parse(await call({ courseId: 4, includeStudents: true }));

    expect(result).toHaveLength(100);
    expect(result[0].name).toBe("User 1");
    expect(apiClient.requested).toEqual(["/d2l/api/le/1.0/4/classlist/paged/"]);
  });
});
