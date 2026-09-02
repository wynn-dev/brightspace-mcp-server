import { describe, it, expect } from "vitest";
import { registerGetCourseContent } from "../../src/tools/get-course-content.js";
import { ApiError } from "../../src/api/index.js";
import { captureTool, fakeApiClient, parse } from "./helpers.js";

const module = (id: number, title: string) => ({
  Id: id,
  Title: title,
  ShortTitle: null,
  Type: 0,
  Description: null,
  ModuleStartDate: null,
  ModuleEndDate: null,
  ModuleDueDate: null,
  IsHidden: false,
  IsLocked: false,
  LastModifiedDate: null,
});

const topic = (id: number, title: string, topicType: number, extra: Record<string, unknown> = {}) => ({
  ...module(id, title),
  Type: 1,
  TopicType: topicType,
  ...extra,
});

describe("get_course_content", () => {
  it("builds the tree with progress, defaults typeFilter to 'all', and counts nodes", async () => {
    const apiClient = fakeApiClient({
      "/3/content/root/": [module(1, "Week 1")],
      "/content/modules/1/structure/": [
        topic(10, "Slides", 1, { Description: { Text: "pdf", Html: "" } }),
        topic(11, "Video", 2, { Url: "https://youtube.com/x" }),
      ],
      "/3/content/userprogress/": [{ UserId: 1, ContentObjectId: 10, IsRead: true, DateCompleted: "2026-09-01T00:00:00Z" }],
    });
    const { call } = captureTool(registerGetCourseContent, apiClient);

    const result = parse(await call({ courseId: 3 }));

    expect(result).toMatchObject({ courseId: 3, typeFilter: "all", topicCount: 2, moduleCount: 1 });
    const [week] = result.contentTree;
    expect(week).toMatchObject({ type: "module", id: 1, title: "Week 1" });
    expect(week.children[0]).toEqual({
      type: "topic",
      topicType: "file",
      id: 10,
      title: "Slides",
      isHidden: false,
      isLocked: false,
      dueDate: null,
      isCompleted: true,
      completedDate: "2026-09-01T00:00:00Z",
      description: "pdf",
      topicId: 10,
    });
    expect(week.children[1]).toMatchObject({ topicType: "link", url: "https://youtube.com/x", isCompleted: false });
  });

  it("filters root modules by title and does not descend past maxDepth", async () => {
    const apiClient = fakeApiClient({
      "/3/content/root/": [module(1, "Labs"), module(2, "Lectures")],
      "/content/modules/1/structure/": [module(5, "Lab 1")],
      "/content/modules/5/structure/": [topic(50, "Deep", 1)],
      "/3/content/userprogress/": () => {
        throw new ApiError(404, "/x", "no progress");
      },
    });
    const { call } = captureTool(registerGetCourseContent, apiClient);

    const result = parse(await call({ courseId: 3, moduleTitle: "lab", maxDepth: 1 }));

    expect(result.contentTree.map((m: { title: string }) => m.title)).toEqual(["Labs"]);
    expect(result.contentTree[0].children[0]).toMatchObject({ title: "Lab 1", children: [] });
    expect(apiClient.requested.some((p) => p.includes("/modules/5/structure/"))).toBe(false);
  });

  it("applies the type filter and drops modules left empty by it", async () => {
    const apiClient = fakeApiClient({
      "/3/content/root/": [module(1, "Files"), module(2, "Links")],
      "/content/modules/1/structure/": [topic(10, "Doc", 1)],
      "/content/modules/2/structure/": [topic(20, "Site", 2, { Url: "https://example.com" })],
      "/3/content/userprogress/": [],
    });
    const { call } = captureTool(registerGetCourseContent, apiClient);

    const result = parse(await call({ courseId: 3, typeFilter: "link" }));

    expect(result.contentTree.map((m: { title: string }) => m.title)).toEqual(["Links"]);
    expect(result.topicCount).toBe(1);
  });
});
