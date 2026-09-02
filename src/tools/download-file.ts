/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { D2LApiClient } from "../api/index.js";
import { DownloadFileSchema } from "./schemas.js";
import { defineTool } from "./define-tool.js";
import { toolResponse, errorResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { isErrnoException } from "../utils/errors.js";
import { validateContentId, MAX_FILE_SIZE } from "../utils/file-validator.js";
import { secureDownload } from "../utils/download-helpers.js";
import fs from "node:fs/promises";
import path from "node:path";

export const registerDownloadFile = defineTool(
  {
    name: "download_file",
    title: "Download File",
    description:
      "Download a file from course content or assignment submissions to a local directory. Use this when the user wants to download, save, or get a file from Brightspace course content or dropbox submissions. IMPORTANT: You MUST ask the user where they want to save the file before calling this tool. Never guess or assume a download directory. After identifying the file to download, suggest a clean readable filename to the user (e.g., 'Lecture 7 - Memory Management.pdf' instead of 'L07_CS251_2026SP_v2.pdf') and ask if they'd like to rename it. Pass their preferred name as customFilename, or omit it to keep the original.",
    schema: DownloadFileSchema,
    // Reads from Brightspace but writes the file to the local disk
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ courseId, topicId, folderId, fileId, downloadPath, customFilename }, { apiClient }) => {
    validateContentId(courseId);

    if (!path.isAbsolute(downloadPath)) {
      return errorResponse(
        "Download path must be an absolute path (e.g., /Users/username/Downloads on Mac or C:\\Users\\username\\Downloads on Windows)"
      );
    }

    try {
      const stats = await fs.stat(downloadPath);
      if (!stats.isDirectory()) {
        return errorResponse(`Download path is not a directory: ${downloadPath}`);
      }
    } catch (error) {
      if (isErrnoException(error, "ENOENT")) {
        return errorResponse(`Download directory does not exist: ${downloadPath}`);
      }
      throw error;
    }

    if (topicId !== undefined) {
      validateContentId(topicId);
      return downloadContentFile(apiClient, courseId, topicId, downloadPath, customFilename);
    }
    if (folderId !== undefined && fileId !== undefined) {
      validateContentId(folderId);
      validateContentId(fileId);
      return downloadSubmissionFile(apiClient, courseId, folderId, fileId, downloadPath, customFilename);
    }
    return errorResponse(
      "Either topicId (for content files) or both folderId and fileId (for submission files) must be provided"
    );
  }
);

/**
 * Extract a filename from a Content-Disposition header.
 */
function parseContentDispositionFilename(disposition: string): string | null {
  const extended = disposition.match(/filename\*\s*=\s*([^;]+)/i);
  if (extended?.[1]) {
    const value = extended[1].trim();
    const parts = value.split("'");
    const encoded = parts.length >= 3 ? parts.slice(2).join("'") : value;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }

  const plain = disposition.match(/filename\s*=\s*("([^"]*)"|[^;\n]*)/i);
  if (plain) {
    const value = (plain[2] ?? plain[1] ?? "").trim();
    if (value) return value;
  }

  return null;
}

function tooLarge(bytes: number): CallToolResult {
  return errorResponse(
    `File too large (${Math.round(bytes / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
  );
}

async function saveAndRespond(
  downloadPath: string,
  filename: string,
  buffer: Buffer,
  logLabel: string
): Promise<CallToolResult> {
  // secureDownload handles path traversal, file type validation, and name conflicts
  const result = await secureDownload({ targetDir: downloadPath, filename, data: buffer });

  log("INFO", `${logLabel} downloaded successfully: ${result.path} (${result.size} bytes, ${result.mime})`);

  return toolResponse({
    success: true,
    filePath: result.path,
    fileSize: result.size,
    mimeType: result.mime,
    originalFilename: filename,
    message: `File downloaded successfully to ${result.path}`,
  });
}

/**
 * Download a content file using topicId
 */
async function downloadContentFile(
  apiClient: D2LApiClient,
  courseId: number,
  topicId: number,
  downloadPath: string,
  customFilename?: string
): Promise<CallToolResult> {
  log("INFO", `Downloading content file: courseId=${courseId}, topicId=${topicId}`);

  const response = await apiClient.getRaw(
    apiClient.le(courseId, `/content/topics/${topicId}/file`)
  );

  // Check Content-Length BEFORE downloading body (prevent memory exhaustion)
  const contentLength = parseInt(response.headers.get("Content-Length") ?? "0", 10);
  if (contentLength > MAX_FILE_SIZE) return tooLarge(contentLength);

  const disposition = response.headers.get("Content-Disposition") ?? "";
  const originalFilename = parseContentDispositionFilename(disposition) ?? "download";
  log("DEBUG", `Content-Disposition filename: ${originalFilename}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_FILE_SIZE) return tooLarge(buffer.length);

  const result = await saveAndRespond(downloadPath, customFilename || originalFilename, buffer, "File");
  return withOriginalFilename(result, originalFilename);
}

/**
 * Download a submission/feedback file using folderId + fileId
 */
async function downloadSubmissionFile(
  apiClient: D2LApiClient,
  courseId: number,
  folderId: number,
  fileId: number,
  downloadPath: string,
  customFilename?: string
): Promise<CallToolResult> {
  log("INFO", `Downloading submission file: courseId=${courseId}, folderId=${folderId}, fileId=${fileId}`);

  interface DropboxSubmission {
    Id: number;
    Files: Array<{ FileId: number; FileName: string; Size: number }>;
  }

  // Look the file up in the user's submission to learn its name and size
  const submissions = await apiClient.get<DropboxSubmission[]>(
    apiClient.le(courseId, `/dropbox/folders/${folderId}/submissions/mysubmissions/`)
  );

  if (!submissions || submissions.length === 0) {
    return errorResponse("No submissions found for this assignment. Upload a submission first.");
  }

  const submission = submissions[0];
  const file = submission.Files.find((f) => f.FileId === fileId);
  if (!file) {
    return errorResponse(
      `File ID ${fileId} not found in submission. Available files: ${submission.Files.map((f) => `${f.FileName} (ID: ${f.FileId})`).join(", ")}`
    );
  }
  if (file.Size > MAX_FILE_SIZE) return tooLarge(file.Size);

  const response = await apiClient.getRaw(
    apiClient.le(courseId, `/dropbox/folders/${folderId}/submissions/${submission.Id}/files/${fileId}/download`)
  );

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_FILE_SIZE) return tooLarge(buffer.length);

  const result = await saveAndRespond(downloadPath, customFilename || file.FileName, buffer, "Submission file");
  return withOriginalFilename(result, file.FileName);
}

/** The response reports the Brightspace filename even when customFilename was used. */
function withOriginalFilename(result: CallToolResult, originalFilename: string): CallToolResult {
  const payload = JSON.parse((result.content[0] as { text: string }).text);
  return toolResponse({ ...payload, originalFilename });
}
