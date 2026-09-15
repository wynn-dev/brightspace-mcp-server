import { describe, it, expect, vi } from "vitest";
import { registerGetSyllabus, registerReadOnlyGetSyllabus } from "../../src/tools/get-syllabus.js";
import { ApiError } from "../../src/api/index.js";
import { captureTool, fakeApiClient, parse, text, fakeResponse } from "./helpers.js";
import fs from "node:fs/promises";
import { secureDownload } from "../../src/utils/download-helpers.js";

vi.mock("../../src/utils/download-helpers.js", () => ({ secureDownload: vi.fn() }));

vi.mock("../../src/utils/pdf-extractor.js", () => ({
  extractPdfText: vi.fn(async () => ({ text: "PDF TEXT", totalPages: 2 })),
}));

describe("get_syllabus", () => {
  it("preserves plain overview text and detects PDFs without a filename extension", async () => {
    const api = fakeApiClient({ "/8/overview": { Description: { Text: "Read <chapter 2>", Html: "" } } }, {
      getRaw: async () => fakeResponse("%PDF-1.4", { "Content-Type": "application/pdf" }),
    });
    expect(parse(await captureTool(registerReadOnlyGetSyllabus, api).call({ courseId: 8 }))).toMatchObject({
      description: { markdown: "Read <chapter 2>", html: "" }, syllabusText: "PDF TEXT",
    });
  });

  it("does not claim that a forbidden attachment is absent", async () => {
    const api = fakeApiClient({ "/8/overview": { Description: null } }, {
      getRaw: async () => { throw new ApiError(403, "/attachment", "Forbidden"); },
    });
    expect(parse(await captureTool(registerReadOnlyGetSyllabus, api).call({ courseId: 8 })).hasAttachment).toBeNull();
  });

  it("cancels oversized attachment responses before reading the body", async () => {
    const cancel = vi.fn();
    const api = fakeApiClient({ "/8/overview": { Description: null } }, {
      getRaw: async () => new Response(new ReadableStream({ cancel }), { headers: { "Content-Length": String(51 * 1024 * 1024) } }),
    });
    expect((await captureTool(registerReadOnlyGetSyllabus, api).call({ courseId: 8 })).isError).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects downloadPath in the read-only handler, even without SDK validation", async () => {
    const apiClient = fakeApiClient();
    const { call } = captureTool(registerReadOnlyGetSyllabus, apiClient);
    expect((await call({ courseId: 8, downloadPath: "/tmp" })).isError).toBe(true);
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(apiClient.getRaw).not.toHaveBeenCalled();
    expect(secureDownload).not.toHaveBeenCalled();
  });

  it("preserves attachment saves for stdio", async () => {
    const stat = vi.spyOn(fs, "stat").mockResolvedValue({ isDirectory: () => true } as any);
    vi.mocked(secureDownload).mockResolvedValueOnce({ path: "/tmp/syllabus.pdf", size: 8, mime: "application/pdf" } as any);
    const apiClient = fakeApiClient({ "/8/overview": { Description: null } }, {
      getRaw: async () => fakeResponse("%PDF-1.4", { "Content-Disposition": 'attachment; filename="syllabus.pdf"' }),
    });
    try {
      const result = parse(await captureTool(registerGetSyllabus, apiClient).call({ courseId: 8, downloadPath: "/tmp" }));
      expect(result.download).toMatchObject({ success: true, filePath: "/tmp/syllabus.pdf" });
      expect(secureDownload).toHaveBeenCalledWith({ targetDir: "/tmp", filename: "syllabus.pdf", data: Buffer.from("%PDF-1.4") });
    } finally {
      stat.mockRestore();
      vi.mocked(secureDownload).mockClear();
    }
  });

  it("returns a successful 'no syllabus' payload when the overview is 404", async () => {
    const apiClient = fakeApiClient({
      "/8/overview": () => {
        throw new ApiError(404, "/x", "none");
      },
    });
    const { call } = captureTool(registerGetSyllabus, apiClient);

    const result = await call({ courseId: 8 });

    expect(result.isError).toBeUndefined();
    expect(parse(result)).toEqual({
      courseId: 8,
      description: null,
      hasAttachment: false,
      message: "No syllabus/overview found for this course.",
    });
  });

  it("rejects a relative downloadPath before touching the API", async () => {
    const apiClient = fakeApiClient();
    const { call } = captureTool(registerGetSyllabus, apiClient);

    const result = await call({ courseId: 8, downloadPath: "relative/dir" });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/absolute path/);
    expect(apiClient.requested).toHaveLength(0);
  });

  it("converts the overview to markdown and extracts text from a PDF attachment", async () => {
    const apiClient = fakeApiClient(
      { "/8/overview": { Description: { Text: "Welcome", Html: "<p>Welcome</p>" } } },
      {
        getRaw: async () =>
          fakeResponse("%PDF-1.4", { "Content-Disposition": 'attachment; filename="syllabus.pdf"' }),
      }
    );
    const { call } = captureTool(registerGetSyllabus, apiClient);

    const result = parse(await call({ courseId: 8 }));

    expect(result.courseId).toBe(8);
    expect(result.description.markdown).toContain("Welcome");
    expect(result.syllabusText).toBe("PDF TEXT");
    expect(result.totalPages).toBe(2);
    expect(result.hasAttachment).toBeUndefined();
  });

  it("reports hasAttachment=false when the attachment endpoint is 404", async () => {
    const apiClient = fakeApiClient({ "/8/overview": { Description: null } });
    const { call } = captureTool(registerGetSyllabus, apiClient);

    const result = parse(await call({ courseId: 8 }));

    expect(result).toEqual({ courseId: 8, description: null, hasAttachment: false });
  });
});
