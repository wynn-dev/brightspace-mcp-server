import { describe, it, expect, vi } from "vitest";
import { registerGetSyllabus } from "../../src/tools/get-syllabus.js";
import { ApiError } from "../../src/api/index.js";
import { captureTool, fakeApiClient, parse, text, fakeResponse } from "./helpers.js";

vi.mock("../../src/utils/pdf-extractor.js", () => ({
  extractPdfText: vi.fn(async () => ({ text: "PDF TEXT", totalPages: 2 })),
}));

describe("get_syllabus", () => {
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
