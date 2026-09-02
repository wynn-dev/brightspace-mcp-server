import { describe, it, expect } from "vitest";
import { registerGetAnnouncements } from "../../src/tools/get-announcements.js";
import { ApiError } from "../../src/api/index.js";
import { captureTool, fakeApiClient, parse, enrollment, enrollmentsPage } from "./helpers.js";

const news = (id: number, createdDate: string) => ({
  Id: id,
  Title: `News ${id}`,
  Body: { Text: `Body ${id}`, Html: `<p>Body ${id}</p>` },
  CreatedBy: { Identifier: "u", DisplayName: "Prof" },
  CreatedDate: createdDate,
  LastModifiedBy: { Identifier: "u", DisplayName: "Prof" },
  LastModifiedDate: createdDate,
  StartDate: createdDate,
  EndDate: null,
  IsPublished: true,
  IsPinned: false,
  IsGlobal: false,
  Attachments: [],
});

describe("get_announcements", () => {
  it("returns the newest announcements for one course, capped at count", async () => {
    const apiClient = fakeApiClient({
      "/9/news/": [news(1, "2026-09-01T00:00:00Z"), news(2, "2026-09-03T00:00:00Z"), news(3, "2026-09-02T00:00:00Z")],
    });
    const { call } = captureTool(registerGetAnnouncements, apiClient);

    const result = parse(await call({ courseId: 9, count: 2 }));

    expect(result.map((a: { id: number }) => a.id)).toEqual([2, 3]);
    expect(result[0]).toEqual({
      id: 2,
      title: "News 2",
      body: "Body 2",
      createdBy: "Prof",
      createdDate: "2026-09-03T00:00:00Z",
      startDate: "2026-09-03T00:00:00Z",
      isPinned: false,
    });
  });

  it("merges announcements across courses, tagging each with its course, and skips 403 courses", async () => {
    const apiClient = fakeApiClient({
      "/enrollments/myenrollments/": enrollmentsPage([enrollment(1, "Alpha"), enrollment(2, "Beta"), enrollment(3, "Gamma")]),
      "/1/news/": [news(10, "2026-09-01T00:00:00Z")],
      "/2/news/": [news(20, "2026-09-05T00:00:00Z")],
      "/3/news/": () => {
        throw new ApiError(403, "/x", "forbidden");
      },
    });
    const { call } = captureTool(registerGetAnnouncements, apiClient);

    const result = parse(await call({}));

    expect(result.map((a: { id: number; courseName: string }) => [a.id, a.courseName])).toEqual([
      [20, "Beta"],
      [10, "Alpha"],
    ]);
  });
});
