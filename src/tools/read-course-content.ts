import { createHash } from "node:crypto";
import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { ReadCourseContentSchema } from "./schemas.js";
import { toolResponse, errorResponse } from "./tool-helpers.js";
import { ContentReadError, contentFilename, decodeContent, readContentBytes, textSliceEnd } from "../utils/content-reader.js";
import { readPdfPages } from "../utils/pdf-extractor.js";

const CursorSchema = z.object({
  version: z.literal(1),
  courseId: z.number().int().positive(),
  topicId: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  page: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  endPage: z.number().int().positive(),
}).strict();

interface ContentTopic { Title: string; TopicType: number; Url?: string }

export const registerReadCourseContent = defineTool(
  {
    name: "read_course_content",
    title: "Read Course Content",
    description: "Read text from a PDF, HTML, or plain-text course file. Find topicId using get_course_content first. PDF results include physical 1-based page numbers for citations. Follow nextCursor until null to read more, using the same courseId and topicId and omitting page selection. Extracts text in memory; no file saves, OCR, external links, or completion updates.",
    schema: ReadCourseContentSchema,
  },
  async ({ courseId, topicId, startPage, endPage, maxChars, cursor }, { apiClient, config }) => {
    try {
      if (cursor && (startPage !== undefined || endPage !== undefined)) {
        throw new ContentReadError("Use cursor or page selection, not both.");
      }
      if (endPage !== undefined && endPage < (startPage ?? 1)) {
        throw new ContentReadError("endPage must be at least startPage.");
      }
      let previous: z.infer<typeof CursorSchema> | undefined;
      if (cursor) {
        try {
          previous = CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
        } catch {
          throw new ContentReadError("Invalid cursor. Use the nextCursor returned by this tool.");
        }
        if (previous.courseId !== courseId || previous.topicId !== topicId) {
          throw new ContentReadError("This cursor belongs to a different course or topic.");
        }
      }

      // Recheck access on every call; do not cache protected document contents.
      const topic = await apiClient.get<ContentTopic>(apiClient.le(courseId, `/content/topics/${topicId}`));
      if (topic.TopicType !== 1) {
        throw new ContentReadError("This topic is not an uploaded file. External links, videos, and learning-tool activities are not supported.");
      }
      const response = await apiClient.getRaw(apiClient.le(courseId, `/content/topics/${topicId}/file`));
      const filename = contentFilename(response.headers.get("content-disposition") ?? "", topic.Url?.split("?")[0] ?? "document");
      const contentType = response.headers.get("content-type") ?? "";
      const buffer = await readContentBytes(response);
      const digest = createHash("sha256").update(contentType).update("\0").update(filename).update("\0").update(buffer).digest("hex");
      if (previous && previous.digest !== digest) {
        throw new ContentReadError("The document changed since the previous response. Restart reading without a cursor.");
      }
      const decoded = await decodeContent(buffer, contentType, filename);
      const metadata = {
        courseId, topicId, title: topic.Title, filename,
        mimeType: decoded.mimeType, format: decoded.format,
        sourceUrl: new URL(`/d2l/le/content/${courseId}/viewContent/${topicId}/View`, config.baseUrl).href,
      };
      const makeCursor = (page: number, offset: number, lastPage: number) => Buffer.from(JSON.stringify({
        version: 1, courseId, topicId, digest, page, offset, endPage: lastPage,
      })).toString("base64url");

      if (decoded.format === "pdf") {
        const result = await readPdfPages(buffer, { page: previous?.page ?? startPage ?? 1, offset: previous?.offset ?? 0 }, previous?.endPage ?? endPage, maxChars);
        return toolResponse({
          ...metadata, totalPages: result.totalPages, endPage: result.endPage, pages: result.pages,
          nextCursor: result.next ? makeCursor(result.next.page, result.next.offset, result.endPage) : null,
          ...(result.pages.some((page) => !page.hasText) ? { message: "Some returned pages have no extractable text. They may be blank or scanned; OCR is not supported." } : {}),
        });
      }
      if (startPage !== undefined || endPage !== undefined || (previous && (previous.page !== 1 || previous.endPage !== 1))) {
        throw new ContentReadError("Page selection is only available for PDF files.");
      }
      const offset = previous?.offset ?? 0;
      if (offset > decoded.text.length) throw new ContentReadError("Invalid continuation offset. Restart reading this document.");
      const end = textSliceEnd(decoded.text, offset, maxChars);
      return toolResponse({
        ...metadata, offset, text: decoded.text.slice(offset, end),
        nextCursor: end < decoded.text.length ? makeCursor(1, end, 1) : null,
        ...(decoded.text.trim().length === 0 ? { message: "This document contains no extractable text." } : {}),
      });
    } catch (error) {
      if (error instanceof ContentReadError) return errorResponse(error.message);
      throw error;
    }
  }
);
