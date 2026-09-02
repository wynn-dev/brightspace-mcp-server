import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDownloadFile } from "../../src/tools/download-file.js";
import { captureTool, fakeApiClient, parse, text, fakeResponse } from "./helpers.js";

vi.mock("../../src/utils/download-helpers.js", () => ({
  secureDownload: vi.fn(async (opts: { targetDir: string; filename: string; data: Buffer }) => ({
    path: join(opts.targetDir, opts.filename),
    size: opts.data.length,
    mime: "application/pdf",
  })),
}));

const DIR = tmpdir();

describe("download_file", () => {
  it("rejects a relative download path", async () => {
    const { call } = captureTool(registerDownloadFile, fakeApiClient());
    const result = await call({ courseId: 1, topicId: 2, downloadPath: "downloads" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/absolute path/);
  });

  it("rejects a download directory that does not exist", async () => {
    const { call } = captureTool(registerDownloadFile, fakeApiClient());
    const missing = join(DIR, `definitely-missing-${Date.now()}`);
    const result = await call({ courseId: 1, topicId: 2, downloadPath: missing });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/does not exist/);
  });

  it("requires either topicId or folderId+fileId", async () => {
    const { call } = captureTool(registerDownloadFile, fakeApiClient());
    const result = await call({ courseId: 1, downloadPath: DIR });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/topicId .* folderId and fileId/);
  });

  it("downloads a content file, honouring customFilename but reporting the original name", async () => {
    const apiClient = fakeApiClient(
      {},
      {
        getRaw: async () =>
          fakeResponse("%PDF-1.4 data", {
            "Content-Length": "13",
            "Content-Disposition": 'attachment; filename="L07_v2.pdf"',
          }),
      }
    );
    const { call } = captureTool(registerDownloadFile, apiClient);

    const result = parse(
      await call({ courseId: 1, topicId: 2, downloadPath: DIR, customFilename: "Lecture 7.pdf" })
    );

    expect(result).toEqual({
      success: true,
      filePath: join(DIR, "Lecture 7.pdf"),
      fileSize: 13,
      mimeType: "application/pdf",
      originalFilename: "L07_v2.pdf",
      message: `File downloaded successfully to ${join(DIR, "Lecture 7.pdf")}`,
    });
    expect(apiClient.getRaw).toHaveBeenCalledWith("/d2l/api/le/1.0/1/content/topics/2/file");
  });

  it("downloads a submission file by looking it up in the user's submission", async () => {
    const apiClient = fakeApiClient(
      {
        "/folders/5/submissions/mysubmissions/": [
          { Id: 99, Files: [{ FileId: 7, FileName: "hw1.pdf", Size: 4 }] },
        ],
      },
      { getRaw: async () => fakeResponse("data") }
    );
    const { call } = captureTool(registerDownloadFile, apiClient);

    const result = parse(await call({ courseId: 1, folderId: 5, fileId: 7, downloadPath: DIR }));

    expect(result).toMatchObject({ success: true, originalFilename: "hw1.pdf", fileSize: 4 });
    expect(apiClient.getRaw).toHaveBeenCalledWith(
      "/d2l/api/le/1.0/1/dropbox/folders/5/submissions/99/files/7/download"
    );
  });
});
