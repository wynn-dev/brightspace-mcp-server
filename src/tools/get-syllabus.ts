/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { DEFAULT_CACHE_TTLS, isApiStatus } from "../api/index.js";
import { GetSyllabusSchema, ReadOnlyGetSyllabusSchema } from "./schemas.js";
import { defineTool, type ToolBody } from "./define-tool.js";
import { toolResponse, errorResponse } from "./tool-helpers.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { secureDownload } from "../utils/download-helpers.js";
import { extractPdfText } from "../utils/pdf-extractor.js";
import { isErrnoException } from "../utils/errors.js";
import { ContentReadError, contentFilename, readContentBytes } from "../utils/content-reader.js";
import { log } from "../utils/logger.js";
import path from "node:path";
import fs from "node:fs/promises";
import { courseMaterialFallback } from "../services/course-documents.js";

// D2L Overview API response shape
interface CourseOverview {
  Description: { Text: string; Html: string } | null;
}

interface DownloadOutcome {
  success: boolean;
  filePath?: string;
  fileSize?: number;
  mimeType?: string;
  error?: string;
}

const getSyllabus: ToolBody<typeof GetSyllabusSchema> =
  async ({ courseId, downloadPath, includeContentFallback }, { apiClient, config }) => {
    if (downloadPath !== undefined) {
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
    }

    // A missing overview is a normal, non-error answer
    let overview: CourseOverview | null = null;
    try {
      overview = await apiClient.get<CourseOverview>(apiClient.le(courseId, "/overview"), {
        ttl: DEFAULT_CACHE_TTLS.courseContent,
      });
    } catch (error) {
      if (isApiStatus(error, 404) || isApiStatus(error, 403)) {
        const fallback = includeContentFallback ? await courseMaterialFallback(apiClient, courseId, config.baseUrl, "syllabus") : null;
        return toolResponse({
          courseId,
          description: null,
          hasAttachment: isApiStatus(error, 404) ? false : null,
          ...(fallback ? { contentFallback: fallback } : {}),
          message: fallback?.materials.length ? "Overview endpoint unavailable; accessible course-material candidates are provided in contentFallback." :
            isApiStatus(error, 403) ? "Access to the overview endpoint is denied." : "No syllabus/overview found for this course.",
        });
      }
      throw error;
    }

    const description = overview?.Description?.Html
      ? convertHtmlToMarkdown(overview.Description.Html)
      : overview?.Description?.Text ? { markdown: overview.Description.Text, html: "" } : null;

    // Always attempt to fetch the attachment so we can extract PDF text
    let attachmentBuffer: Buffer | null = null;
    let attachmentFilename = "syllabus";
    let hasAttachment: boolean | null = null;
    let attachmentContentType = "";

    try {
      const response = await apiClient.getRaw(apiClient.le(courseId, "/overview/attachment"));

      if (response.ok) {
        hasAttachment = true;

        attachmentContentType = response.headers.get("Content-Type") ?? "";
        attachmentFilename = contentFilename(response.headers.get("Content-Disposition") ?? "", "syllabus");
        attachmentBuffer = await readContentBytes(response);
      }
    } catch (error) {
      if (error instanceof ContentReadError) return errorResponse(error.message);
      if (isApiStatus(error, 404)) {
        hasAttachment = false;
      } else {
        log("DEBUG", "Could not fetch syllabus attachment", error);
      }
    }

    let syllabusText: string | null = null;
    let totalPages: number | undefined;
    if (attachmentBuffer && (attachmentFilename.toLowerCase().endsWith(".pdf") ||
      attachmentContentType.split(";", 1)[0].trim().toLowerCase() === "application/pdf" ||
      attachmentBuffer.subarray(0, 1024).includes(Buffer.from("%PDF-")))) {
      const extracted = await extractPdfText(attachmentBuffer);
      if (extracted) {
        syllabusText = extracted.text;
        totalPages = extracted.totalPages;
      }
    }

    let download: DownloadOutcome | undefined;
    if (downloadPath && attachmentBuffer) {
      try {
        const result = await secureDownload({
          targetDir: downloadPath,
          filename: attachmentFilename,
          data: attachmentBuffer,
        });
        log("INFO", `Syllabus attachment downloaded: ${result.path} (${result.size} bytes)`);
        download = { success: true, filePath: result.path, fileSize: result.size, mimeType: result.mime };
      } catch (error) {
        log("ERROR", "Failed to save syllabus attachment", error);
        download = { success: false, error: "Failed to save attachment to disk." };
      }
    } else if (downloadPath && !attachmentBuffer) {
      download = { success: false, error: "No attachment found for this course's syllabus." };
    }

    log("INFO", `get_syllabus: Retrieved overview for course ${courseId}`);

    const result: Record<string, unknown> = { courseId, description };
    if (syllabusText) {
      result.syllabusText = syllabusText;
      if (totalPages) result.totalPages = totalPages;
    } else {
      result.hasAttachment = hasAttachment;
    }
    if (download) result.download = download;
    if (includeContentFallback && !description?.markdown && !syllabusText) {
      result.contentFallback = await courseMaterialFallback(apiClient, courseId, config.baseUrl, "syllabus");
    }

    return toolResponse(result);
  };

export const registerGetSyllabus = defineTool(
  {
    name: "get_syllabus",
    title: "Get Course Syllabus",
    description:
      "Fetch the syllabus/overview text and optional attachment for a course. Returns the course overview description as markdown. includeContentFallback (default true) finds separate course-guide excerpts when overview text is unavailable. If downloadPath is provided, also downloads the syllabus attachment (e.g. PDF). IMPORTANT: You MUST ask the user where they want to save the file before calling this tool with a downloadPath.",
    schema: GetSyllabusSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  getSyllabus
);

export const registerReadOnlyGetSyllabus = defineTool(
  {
    name: "get_syllabus",
    title: "Get Course Syllabus",
    description: "Read the course overview as markdown and extract text from its PDF attachment. includeContentFallback (default true) finds separate course-guide excerpts when overview text is unavailable. Attachments and fallback PDF/HTML/text excerpts are processed in memory. Saving files is unavailable over HTTP.",
    schema: ReadOnlyGetSyllabusSchema,
  },
  (args, context) => getSyllabus(args, context)
);
