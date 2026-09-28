import { describe, it, expect, vi } from "vitest";
import { ApiError } from "../../src/api/index.js";
import { registerReadCourseContent } from "../../src/tools/read-course-content.js";
import { captureTool, fakeApiClient, parse, text } from "./helpers.js";
import { makePdf } from "../fixtures/pdf.js";
import { secureDownload } from "../../src/utils/download-helpers.js";

vi.mock("../../src/utils/download-helpers.js", () => ({ secureDownload: vi.fn() }));

function reader(body: Buffer | string, mime = "application/pdf", filename = "notes.pdf") {
  const api = fakeApiClient({
    "/3/content/topics/10": { Title: "Lecture notes", TopicType: 1, Url: `/content/enforced/notes/${filename}` },
  }, {
    getRaw: async () => new Response(typeof body === "string" ? body : new Uint8Array(body), {
      headers: { "Content-Type": mime, "Content-Disposition": `attachment; filename="${filename}"` },
    }),
  });
  return { ...captureTool(registerReadCourseContent, api), api };
}

describe("read_course_content", () => {
  it("extracts real PDF pages with physical page references and no file saves", async () => {
    const { call, api } = reader(makePdf(["First lecture", "Second lecture", "Appendix"]));
    const response = await call({ courseId: 3, topicId: 10, startPage: 2, endPage: 2 });
    const result = parse(response);
    expect(result).toMatchObject({ filename: "notes.pdf", title: "Lecture notes", format: "pdf", totalPages: 3, nextCursor: null });
    expect(result.pages).toEqual([{ page: 2, offset: 0, text: "Second lecture", hasText: true, imageIncluded: true }]);
    // Page images ride along as JPEG image blocks, labelled with their page.
    const images = response.content.filter(b => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ mimeType: "image/jpeg", data: expect.stringMatching(/^\/9j\//) });
    expect(response.content).toContainEqual({ type: "text", text: "Image of PDF page 2 (927x1200):" });
    // structuredContent would hide the image blocks from clients that prefer it.
    expect(response.structuredContent).toBeUndefined();
    expect(result.sourceUrl).toBe("https://brightspace.example.edu/d2l/le/content/3/viewContent/10/View");
    expect(api.getRaw).toHaveBeenCalledWith("/d2l/api/le/1.0/3/content/topics/10/file");
    expect(secureDownload).not.toHaveBeenCalled();
  });

  it("continues within and across PDF pages without losing text", async () => {
    const { call } = reader(makePdf(["abcdefgh", "ijklmnop"]));
    const pages = new Map<number, string>();
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const result = parse(await call({ courseId: 3, topicId: 10, maxChars: 5, ...(cursor ? { cursor } : {}) }));
      expect(result.pages.reduce((n: number, p: { text: string }) => n + p.text.length, 0)).toBeLessThanOrEqual(5);
      for (const p of result.pages) pages.set(p.page, (pages.get(p.page) ?? "") + p.text);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect([...pages]).toEqual([[1, "abcdefgh"], [2, "ijklmnop"]]);
  });

  it("continues blank pages with a bounded page count and explains missing text", async () => {
    const { call } = reader(makePdf(Array(21).fill("")));
    const first = await call({ courseId: 3, topicId: 10, pageImages: false });
    expect(parse(first).pages).toHaveLength(20);
    expect(parse(first).message).toMatch(/blank or scanned/);
    expect(first.structuredContent).toMatchObject({ totalPages: 21 });
    const last = parse(await call({ courseId: 3, topicId: 10, cursor: parse(first).nextCursor, pageImages: false }));
    expect(last.pages).toEqual([{ page: 21, offset: 0, text: "", hasText: false, imageIncluded: false }]);
    expect(last.nextCursor).toBeNull();
  });

  it("limits image responses to five pages and points textless pages at their images", async () => {
    const { call } = reader(makePdf(Array(7).fill("")));
    const response = await call({ courseId: 3, topicId: 10 });
    expect(parse(response).pages.map((p: { page: number }) => p.page)).toEqual([1, 2, 3, 4, 5]);
    expect(response.content.filter(b => b.type === "image")).toHaveLength(5);
    expect(parse(response).message).toMatch(/read their page images/);
  });

  it("renders a page image only in the response where the page starts", async () => {
    const { call } = reader(makePdf(["abcdefgh", "ijklmnop"]));
    const first = await call({ courseId: 3, topicId: 10, maxChars: 5 });
    expect(parse(first).pages).toMatchObject([{ page: 1, offset: 0, imageIncluded: true }]);
    const second = await call({ courseId: 3, topicId: 10, cursor: parse(first).nextCursor });
    expect(parse(second).pages).toMatchObject([{ page: 1, offset: 5, imageIncluded: false }, { page: 2, offset: 0, imageIncluded: true }]);
    expect(second.content).toContainEqual(expect.objectContaining({ text: expect.stringMatching(/^Image of PDF page 2 /) }));
    expect(second.content.filter(b => b.type === "image")).toHaveLength(1);
  });

  it.each([
    ["text/plain", "notes.txt", "ab😀cdef😀", "ab😀cdef😀"],
    ["text/html", "lab.html", "<h1>Lab</h1><p>Steps</p>", "# Lab\n\nSteps"],
  ])("returns complete bounded %s text", async (mime, filename, body, expected) => {
    const { call } = reader(body, mime, filename);
    let combined = "";
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const result = parse(await call({ courseId: 3, topicId: 10, maxChars: 3, ...(cursor ? { cursor } : {}) }));
      expect(result.offset).toBe(combined.length);
      expect(result.text.length).toBeLessThanOrEqual(3);
      expect(result.text.isWellFormed()).toBe(true);
      combined += result.text;
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(combined).toBe(expected);
  });

  it("rejects stale and cross-document cursors", async () => {
    const { call, api } = reader("first document", "text/plain", "notes.txt");
    const first = parse(await call({ courseId: 3, topicId: 10, maxChars: 3 }));
    const wrong = await call({ courseId: 4, topicId: 10, cursor: first.nextCursor });
    expect(text(wrong)).toMatch(/different course or topic/);
    expect(api.get).toHaveBeenCalledTimes(1);
    api.getRaw.mockResolvedValueOnce(new Response("changed document", { headers: { "Content-Type": "text/plain" } }));
    expect(text(await call({ courseId: 3, topicId: 10, cursor: first.nextCursor }))).toMatch(/document changed/);
  });

  it.each([
    { cursor: "bad-cursor" }, { startPage: 3, endPage: 2 }, { startPage: 0 },
    { cursor: "anything", startPage: 1 }, { downloadPath: "/tmp" },
  ])("rejects invalid input before fetching: %j", async (args) => {
    const { call, api } = reader("test");
    expect((await call({ courseId: 3, topicId: 10, ...args })).isError).toBe(true);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.getRaw).not.toHaveBeenCalled();
  });

  it("rejects out-of-range PDF pages and page selection for text", async () => {
    expect(text(await reader(makePdf(["One"])).call({ courseId: 3, topicId: 10, startPage: 2 }))).toMatch(/1 pages/);
    expect(text(await reader("Hello", "text/plain", "notes.txt").call({ courseId: 3, topicId: 10, startPage: 1 }))).toMatch(/only available for PDF/);
  });

  it("reports malformed PDFs", async () => {
    const result = await reader("%PDF-1.4\nnot a PDF").call({ courseId: 3, topicId: 10 });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/malformed/);
  });

  it.each([403, 404])("preserves access errors (%i)", async (status) => {
    const { call, api } = reader("test");
    api.getRaw.mockRejectedValueOnce(new ApiError(status, "/file", "private response"));
    const result = await call({ courseId: 3, topicId: 10 });
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain("private response");
  });

  it("does not fetch external-link topics", async () => {
    const { call, api } = reader("test");
    api.get.mockResolvedValueOnce({ Title: "External", TopicType: 3, Url: "https://example.com/file.pdf" });
    expect(text(await call({ courseId: 3, topicId: 10 }))).toMatch(/not an uploaded file/);
    expect(api.getRaw).not.toHaveBeenCalled();
  });
});
