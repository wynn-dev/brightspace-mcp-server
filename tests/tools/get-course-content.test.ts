import { describe, it, expect } from "vitest";
import { registerGetCourseContent } from "../../src/tools/get-course-content.js";
import { ApiError } from "../../src/api/index.js";
import { captureTool, fakeApiClient, parse } from "./helpers.js";

// Shapes follow the live /content/toc response.
const module = (id: number, title: string, sortOrder: number, extra: Record<string, unknown> = {}) => ({
  ModuleId: id, Title: title, SortOrder: sortOrder, IsHidden: false, IsLocked: false,
  Description: { Text: "", Html: "" }, Modules: [], Topics: [], ...extra,
});
const topic = (id: number, title: string, type: "File" | "Link", sortOrder: number, extra: Record<string, unknown> = {}) => ({
  TopicId: id, Identifier: String(id), TypeIdentifier: type, Title: title, SortOrder: sortOrder, IsHidden: false, IsLocked: false,
  Unread: false, Url: type === "File" ? `/content/enforced/3/${title}.pdf` : "https://example.com", Description: { Text: "", Html: "" }, ...extra,
});

describe("get_course_content", () => {
  it("builds a compact outline from one TOC read with scheduled due dates and completion", async () => {
    const apiClient = fakeApiClient({
      "/3/content/toc": { Modules: [module(1, "Week 1", 1, { Topics: [
        topic(10, "Slides", "File", 2, { Description: { Text: "pdf", Html: "<p>pdf</p>" }, Unread: true }),
        topic(11, "Video", "Link", 1, { Url: "https://youtube.com/x" }),
      ] })] },
      "/3/content/myItems/": [{ ItemId: 10, CompletionType: 2, DateCompleted: "2026-09-01T00:00:00Z", DueDate: "2026-09-02T00:00:00Z" }],
    });
    const { call } = captureTool(registerGetCourseContent, apiClient);

    const result = parse(await call({ courseId: 3 }));

    expect(result).toMatchObject({ courseId: 3, typeFilter: "all", topicCount: 2, moduleCount: 1 });
    const [week] = result.contentTree;
    expect(week).toEqual({ type: "module", moduleId: 1, title: "Week 1", children: expect.any(Array) });
    // SortOrder decides order; false flags and absent values are omitted.
    expect(week.children[0]).toEqual({ type: "link", topicId: 11, title: "Video", isCompleted: null, url: "https://youtube.com/x" });
    expect(week.children[1]).toEqual({
      type: "file", topicId: 10, title: "Slides", dueDate: "2026-09-02T00:00:00Z",
      isCompleted: true, completedDate: "2026-09-01T00:00:00Z", unread: true, description: "pdf",
    });
    // TOC + scheduled items, plus the two progress counts (course and top-level modules).
    expect(apiClient.requested.filter(p => p.includes("/content/"))).toHaveLength(4);
  });

  it("shortens descriptions to snippets unless full descriptions are requested", async () => {
    const long = `<p>${"Read the chapter carefully. ".repeat(20)}</p>`;
    const apiClient = fakeApiClient({
      "/3/content/toc": { Modules: [module(1, "Week 1", 1, { Description: { Text: "", Html: long } })] },
      "/3/content/myItems/": [],
    });
    const { call } = captureTool(registerGetCourseContent, apiClient);
    const outline = parse(await call({ courseId: 3 })).contentTree[0];
    expect(outline.description.length).toBeLessThanOrEqual(161);
    expect(outline.description).toMatch(/…$/);
    const full = parse(await call({ courseId: 3, includeDescriptions: true })).contentTree[0];
    expect(full.description).toMatch(/^Read the chapter carefully\./);
    expect(full.description.length).toBeGreaterThan(400);
    expect(full.description).not.toMatch(/…$/);
  });

  it("filters root modules by title and does not descend past maxDepth", async () => {
    const apiClient = fakeApiClient({
      "/3/content/toc": { Topics: [topic(9, "Root file", "File", 0)], Modules: [
        module(1, "Labs", 1, { Modules: [module(5, "Lab 1", 1, { Topics: [topic(50, "Deep", "File", 1)] })] }),
        module(2, "Lectures", 2),
      ] },
      "/3/content/myItems/": () => { throw new ApiError(404, "/x", "no progress"); },
    });
    const { call } = captureTool(registerGetCourseContent, apiClient);

    const response = await call({ courseId: 3, moduleTitle: "lab", maxDepth: 1 });
    const result = parse(response);

    expect(result.contentTree.map((m: { title: string }) => m.title)).toEqual(["Labs"]);
    expect(result.contentTree[0].children[0]).toMatchObject({ title: "Lab 1", children: [] });
    expect(response.structuredContent?.readStatus).toMatchObject({ partial: true, limits: ["Content depth limited by maxDepth"] });
  });

  it("applies the type filter and drops modules left empty by it", async () => {
    const apiClient = fakeApiClient({
      "/3/content/toc": { Modules: [
        module(1, "Files", 1, { Topics: [topic(10, "Doc", "File", 1)] }),
        module(2, "Links", 2, { Topics: [topic(20, "Site", "Link", 1)] }),
      ] },
      "/3/content/myItems/": [],
    });
    const { call } = captureTool(registerGetCourseContent, apiClient);

    const result = parse(await call({ courseId: 3, typeFilter: "link" }));

    expect(result.contentTree.map((m: { title: string }) => m.title)).toEqual(["Links"]);
    expect(result.topicCount).toBe(1);
  });
});
