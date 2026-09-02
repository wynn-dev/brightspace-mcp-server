import { describe, it, expect } from "vitest";
import { registerGetClasslistEmails } from "../../src/tools/get-classlist-emails.js";
import { captureTool, fakeApiClient, parse, objectPage } from "./helpers.js";

const user = (id: number, email: string | null, role = "Student") => ({
  Identifier: id,
  DisplayName: `User ${id}`,
  Email: email,
  ClasslistRoleDisplayName: role,
});

describe("get_classlist_emails", () => {
  it("returns name/email/role and drops users whose email is hidden", async () => {
    const apiClient = fakeApiClient({
      "/4/classlist/paged/": objectPage([user(1, "a@x.edu", "Instructor"), user(2, null), user(3, "c@x.edu")]),
    });
    const { call } = captureTool(registerGetClasslistEmails, apiClient);

    const result = parse(await call({ courseId: 4 }));

    expect(result).toEqual([
      { name: "User 1", email: "a@x.edu", role: "Instructor" },
      { name: "User 3", email: "c@x.edu", role: "Student" },
    ]);
    expect(apiClient.requested).toEqual(["/d2l/api/le/1.0/4/classlist/paged/"]);
  });
});
