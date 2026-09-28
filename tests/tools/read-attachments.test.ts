import { describe, it, expect, vi } from "vitest";
import { ApiError } from "../../src/api/index.js";
import { registerReadCourseContent } from "../../src/tools/read-course-content.js";
import { captureTool, fakeApiClient, parse, text } from "./helpers.js";
import { makePdf } from "../fixtures/pdf.js";
import { secureDownload } from "../../src/utils/download-helpers.js";

vi.mock("../../src/utils/download-helpers.js", () => ({ secureDownload: vi.fn() }));

const pdf = makePdf(["Brief page one", "Brief page two"]);
const folder = { Id: 4, Name: "Lab report", IsHidden: false,
  Attachments: [{ FileId: 50, FileName: "brief.pdf", Size: pdf.length }, { FileId: 51, FileName: "huge.pdf", Size: 60 * 1024 * 1024 }] };
const news = { Id: 7, Title: "Exam info", Attachments: [{ FileId: 60, FileName: "rooms.html", Size: 100 }] };
/** mysubmissions: the user's own group entity with released feedback, plus an ungraded draft on the user entity. */
const mySubmissions = [
  { Entity: { EntityId: 33, EntityType: "Group" }, Submissions: [{ Id: 1, Files: [] }],
    Feedback: { IsGraded: true, Score: 7, Files: [{ FileId: 70, FileName: "comments.txt", Size: 20 }] } },
  { Entity: { EntityId: 42, EntityType: "User" }, Submissions: [{ Id: 2, Files: [] }],
    Feedback: { IsGraded: false, Files: [{ FileId: 71, FileName: "draft.txt", Size: 20 }] } },
];

function files(bodies: Record<string, { body: Buffer | string; mime: string; name: string }>) {
  const api = fakeApiClient({
    "/5/dropbox/folders/4": folder,
    "/5/news/7": news,
    "/5/dropbox/folders/4/submissions/mysubmissions/": mySubmissions,
  }, {
    getRaw: async (path: string) => {
      const match = Object.entries(bodies).find(([suffix]) => path.endsWith(suffix));
      if (!match) throw new ApiError(404, path, "private not found body");
      const { body, mime, name } = match[1];
      return new Response(typeof body === "string" ? body : new Uint8Array(body), {
        headers: { "Content-Type": mime, "Content-Disposition": `attachment; filename="${name}"` },
      });
    },
  });
  return { ...captureTool(registerReadCourseContent, api), api };
}

const standard = () => files({
  "/dropbox/folders/4/attachments/50": { body: pdf, mime: "application/pdf", name: "brief.pdf" },
  "/news/7/attachments/60": { body: "<h1>Rooms</h1><p>Hall A</p>", mime: "text/html", name: "rooms.html" },
  "/dropbox/folders/4/feedback/group/33/attachments/70": { body: "Well structured report", mime: "text/plain", name: "comments.txt" },
});

describe("read_course_content attachments", () => {
  it("reads an assignment brief PDF with page images from the folder attachment route", async () => {
    const { call, api } = standard();
    const response = await call({ courseId: 5, attachment: { kind: "assignment", folderId: 4, fileId: 50 }, startPage: 2 });
    const result = parse(response);
    expect(result).toMatchObject({
      courseId: 5, attachment: { kind: "assignment", folderId: 4, fileId: 50 }, title: "Lab report",
      filename: "brief.pdf", format: "pdf", totalPages: 2, nextCursor: null,
      sourceUrl: "https://brightspace.example.edu/d2l/lms/dropbox/user/folder_submit_files.d2l?db=4&ou=5",
    });
    expect(result).not.toHaveProperty("topicId");
    expect(result.pages).toEqual([{ page: 2, offset: 0, text: "Brief page two", hasText: true, imageIncluded: true }]);
    expect(response.content.filter(b => b.type === "image")).toHaveLength(1);
    expect(api.getRaw).toHaveBeenCalledWith("/d2l/api/le/1.0/5/dropbox/folders/4/attachments/50");
    expect(secureDownload).not.toHaveBeenCalled();
  });

  it("reads an announcement attachment as Markdown from the news attachment route", async () => {
    const { call, api } = standard();
    const result = parse(await call({ courseId: 5, attachment: { kind: "announcement", newsItemId: 7, fileId: 60 } }));
    expect(result).toMatchObject({
      attachment: { kind: "announcement", newsItemId: 7, fileId: 60 }, title: "Exam info", format: "markdown",
      text: "# Rooms\n\nHall A", nextCursor: null, sourceUrl: "https://brightspace.example.edu/d2l/le/news/5/7/view",
    });
    expect(api.getRaw).toHaveBeenCalledWith("/d2l/api/le/1.0/5/news/7/attachments/60");
  });

  it("reads released feedback files through the user's own entity from mysubmissions", async () => {
    const { call, api } = standard();
    const result = parse(await call({ courseId: 5, attachment: { kind: "feedback", folderId: 4, fileId: 70 } }));
    expect(result).toMatchObject({
      attachment: { kind: "feedback", folderId: 4, entityType: "group", entityId: 33, fileId: 70 },
      filename: "comments.txt", format: "text", text: "Well structured report",
    });
    expect(api.getRaw).toHaveBeenCalledWith("/d2l/api/le/1.0/5/dropbox/folders/4/feedback/group/33/attachments/70");
    expect(api.requested).toEqual(["/d2l/api/le/1.0/5/dropbox/folders/4/submissions/mysubmissions/"]);
    // Case-insensitive, matching disambiguation is accepted.
    expect((await call({ courseId: 5, attachment: { kind: "feedback", folderId: 4, fileId: 70, entityType: "Group", entityId: 33 } })).isError).toBeFalsy();
  });

  it.each([
    [{ fileId: 70, entityType: "user" }, "entity type that does not own the file"],
    [{ fileId: 70, entityId: 99 }, "another entity"],
    [{ fileId: 71 }, "ungraded draft feedback"],
    [{ fileId: 999 }, "unknown file"],
  ])("never requests feedback files outside the user's released feedback: %j (%s)", async (selector) => {
    const { call, api } = standard();
    const result = await call({ courseId: 5, attachment: { kind: "feedback", folderId: 4, ...selector } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not a released feedback file on your own submission/);
    expect(api.getRaw).not.toHaveBeenCalled();
  });

  it("reports unavailable submissions instead of guessing a feedback entity", async () => {
    const { call, api } = standard();
    api.get.mockRejectedValueOnce(new ApiError(403, "/mysubmissions/", "forbidden"));
    const result = await call({ courseId: 5, attachment: { kind: "feedback", folderId: 4, fileId: 70 } });
    expect(text(result)).toMatch(/submissions for this assignment are forbidden/);
    expect(api.getRaw).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "assignment", folderId: 4, fileId: 99 }, /not attached to this assignment/],
    [{ kind: "announcement", newsItemId: 7, fileId: 99 }, /not attached to this announcement/],
    [{ kind: "assignment", folderId: 4, fileId: 51 }, /too large/],
  ])("checks the listed attachment before fetching: %j", async (attachment, message) => {
    const { call, api } = standard();
    expect(text(await call({ courseId: 5, attachment }))).toMatch(message);
    expect(api.getRaw).not.toHaveBeenCalled();
  });

  it("does not read attachments of hidden assignments", async () => {
    const { call, api } = standard();
    api.get.mockResolvedValueOnce({ ...folder, IsHidden: true });
    expect(text(await call({ courseId: 5, attachment: { kind: "assignment", folderId: 4, fileId: 50 } }))).toMatch(/hidden/);
    expect(api.getRaw).not.toHaveBeenCalled();
  });

  it.each([
    [404, "raw", /not found/],
    [403, "raw", /Access denied/],
    [404, "metadata", /not found/],
    [403, "metadata", /Access denied/],
  ] as const)("maps %i on the %s request without leaking the response", async (status, where, message) => {
    const { call, api } = standard();
    const error = new ApiError(status, "/x", "private response");
    if (where === "raw") api.getRaw.mockRejectedValueOnce(error); else api.get.mockRejectedValueOnce(error);
    const result = await call({ courseId: 5, attachment: { kind: "assignment", folderId: 4, fileId: 50 } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(message);
    expect(text(result)).not.toContain("private response");
  });

  it.each(["announcement", "feedback"] as const)("maps a 404 attachment stream for %s", async (kind) => {
    const { call } = files({});
    const attachment = kind === "announcement" ? { kind, newsItemId: 7, fileId: 60 } : { kind, folderId: 4, fileId: 70 };
    const result = await call({ courseId: 5, attachment });
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain("private not found body");
  });

  it("binds cursors to the selected attachment", async () => {
    const { call } = files({
      "/dropbox/folders/4/attachments/50": { body: "abcdefghij", mime: "text/plain", name: "brief.txt" },
      "/news/7/attachments/60": { body: "abcdefghij", mime: "text/plain", name: "brief.txt" },
      "/content/topics/50/file": { body: "abcdefghij", mime: "text/plain", name: "brief.txt" },
    });
    const brief = { kind: "assignment", folderId: 4, fileId: 50 };
    const first = parse(await call({ courseId: 5, attachment: brief, maxChars: 4 }));
    expect(first.text).toBe("abcd");
    const rest = parse(await call({ courseId: 5, attachment: brief, cursor: first.nextCursor }));
    expect(rest).toMatchObject({ offset: 4, text: "efghij", nextCursor: null });

    for (const other of [
      { topicId: 50 },
      { attachment: { kind: "announcement", newsItemId: 7, fileId: 60 } },
      { attachment: { kind: "feedback", folderId: 4, fileId: 50 } },
      { attachment: { ...brief, folderId: 5 } },
      { attachment: { ...brief, fileId: 51 } },
    ]) {
      expect(text(await call({ courseId: 5, ...other, cursor: first.nextCursor }))).toMatch(/different course or file/);
    }
  });

  it.each([
    {}, { topicId: 10, attachment: { kind: "assignment", folderId: 4, fileId: 50 } },
    { attachment: { kind: "assignment", fileId: 50 } },
    { attachment: { kind: "assignment", folderId: 4, newsItemId: 7, fileId: 50 } },
    { attachment: { kind: "announcement", fileId: 60 } },
    { attachment: { kind: "announcement", newsItemId: 7, folderId: 4, fileId: 60 } },
    { attachment: { kind: "assignment", folderId: 4, fileId: 50, entityId: 42 } },
    { attachment: { kind: "feedback", folderId: 4, fileId: 70, entityType: "org" } },
    { attachment: { kind: "syllabus", fileId: 1 } },
    { attachment: { kind: "assignment", folderId: 4, fileId: 50, downloadPath: "/tmp" } },
  ])("rejects invalid selectors before any request: %j", async (args) => {
    const { call, api } = standard();
    expect((await call({ courseId: 5, ...args })).isError).toBe(true);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.getRaw).not.toHaveBeenCalled();
  });
});
