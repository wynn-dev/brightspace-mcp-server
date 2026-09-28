import { createHash } from "node:crypto";
import { z } from "zod";
import type { D2LApiClient } from "../api/index.js";
import { defineTool } from "./define-tool.js";
import { ReadCourseContentSchema } from "./schemas.js";
import { toolResponse, errorResponse } from "./tool-helpers.js";
import { ContentReadError, contentFilename, decodeContent, readContentBytes, textSliceEnd } from "../utils/content-reader.js";
import { readPdfPages } from "../utils/pdf-extractor.js";
import { MAX_FILE_SIZE } from "../utils/file-validator.js";
import { getSubmissionHistory } from "../services/assignments.js";
import { object, rows, str, num, id } from "../services/data.js";

const CursorSchema = z.object({
  version: z.literal(2),
  courseId: z.number().int().positive(),
  /** Identity of the selected file (topic or attachment): a cursor only continues that file. */
  source: z.string().min(1).max(200),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  page: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  endPage: z.number().int().positive(),
}).strict();

type Attachment = NonNullable<z.output<typeof ReadCourseContentSchema>["attachment"]>;
interface ContentTopic { Title: string; TopicType: number; Url?: string }
interface ResolvedSource {
  /** API path of the file stream. */
  path: string;
  title: string | null;
  /** Filename used when the response has no Content-Disposition. */
  fallbackName: string;
  sourceUrl: string;
  /** Identifies the file in the response. */
  reference: Record<string, unknown>;
}

/** Validate the file selector and return its cursor identity, before any request. */
function sourceIdentity(topicId: number | undefined, attachment: Attachment | undefined): string {
  if ((topicId === undefined) === (attachment === undefined)) {
    throw new ContentReadError("Provide exactly one of topicId (course content file) or attachment.");
  }
  if (!attachment) return `topic:${topicId}`;
  const { kind, fileId, folderId, newsItemId, entityType, entityId } = attachment;
  if (kind !== "feedback" && (entityType !== undefined || entityId !== undefined)) {
    throw new ContentReadError("entityType and entityId only apply to feedback attachments.");
  }
  if (kind === "announcement") {
    if (newsItemId === undefined || folderId !== undefined) {
      throw new ContentReadError("Announcement attachments need newsItemId (and no folderId).");
    }
    return `announcement:${newsItemId}:${fileId}`;
  }
  if (folderId === undefined || newsItemId !== undefined) {
    throw new ContentReadError(`${kind === "assignment" ? "Assignment" : "Feedback"} attachments need folderId (and no newsItemId).`);
  }
  // Feedback always resolves to the user's own entity, so folder + file identify it.
  return `${kind}:${folderId}:${fileId}`;
}

function checkListedSize(size: number | null) {
  if (size !== null && size > MAX_FILE_SIZE) {
    throw new ContentReadError(`File too large. Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024} MiB.`);
  }
}

/**
 * Resolve the selected file to its API route, rechecking that it is listed where
 * the model found it. Runs on every call; protected contents are never cached.
 */
async function resolveSource(apiClient: D2LApiClient, baseUrl: string, courseId: number,
  topicId: number | undefined, attachment: Attachment | undefined): Promise<ResolvedSource> {
  const web = (path: string) => new URL(path, baseUrl).href;
  if (!attachment) {
    const topic = await apiClient.get<ContentTopic>(apiClient.le(courseId, `/content/topics/${topicId}`));
    if (topic.TopicType !== 1) {
      throw new ContentReadError("This topic is not an uploaded file. External links, videos, and learning-tool activities are not supported.");
    }
    return { path: apiClient.le(courseId, `/content/topics/${topicId}/file`), title: topic.Title,
      fallbackName: topic.Url?.split("?")[0] ?? "document", reference: { topicId },
      sourceUrl: web(`/d2l/le/content/${courseId}/viewContent/${topicId}/View`) };
  }

  const { kind, fileId, folderId, newsItemId } = attachment;
  const listedName = (files: unknown, where: string) => {
    const file = rows(files).find(f => id(f.FileId) === fileId);
    if (!file) throw new ContentReadError(`File ${fileId} is not attached to this ${where}. Use a fileId listed by the tool that returned it.`);
    checkListedSize(num(file.Size) ?? num(file.FileSize));
    return str(file.FileName) ?? "attachment";
  };

  if (kind === "assignment") {
    const folder = object(await apiClient.get<unknown>(apiClient.le(courseId, `/dropbox/folders/${folderId}`)));
    if (folder.IsHidden === true) throw new ContentReadError("This assignment is hidden.");
    return { path: apiClient.le(courseId, `/dropbox/folders/${folderId}/attachments/${fileId}`),
      title: str(folder.Name), fallbackName: listedName(folder.Attachments, "assignment"),
      reference: { attachment: { kind, folderId, fileId } },
      sourceUrl: web(`/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${folderId}&ou=${courseId}`) };
  }

  if (kind === "announcement") {
    const item = object(await apiClient.get<unknown>(apiClient.le(courseId, `/news/${newsItemId}`)));
    return { path: apiClient.le(courseId, `/news/${newsItemId}/attachments/${fileId}`),
      title: str(item.Title), fallbackName: listedName(item.Attachments, "announcement"),
      reference: { attachment: { kind, newsItemId, fileId } },
      sourceUrl: web(`/d2l/le/news/${courseId}/${newsItemId}/view`) };
  }

  // Feedback: only released feedback on the authenticated user's own user/group
  // entity (from mysubmissions) is eligible; other entities are never requested.
  const own = await getSubmissionHistory(apiClient, courseId, folderId!);
  if (own.status !== "available") {
    throw new ContentReadError(`Your submissions for this assignment are ${own.status}; cannot resolve the feedback file.`);
  }
  const wantedType = attachment.entityType?.toLowerCase();
  const matches = own.feedback.filter(f => f.files.some(file => file.fileId === fileId)
    && (wantedType === undefined || f.entityType?.toLowerCase() === wantedType)
    && (attachment.entityId === undefined || f.entityId === attachment.entityId));
  if (!matches.length) {
    throw new ContentReadError(`File ${fileId} is not a released feedback file on your own submission for this assignment. Use feedback files listed by get_submission_history.`);
  }
  if (matches.length > 1) {
    throw new ContentReadError("This fileId appears in more than one of your feedback entries; add entityType and entityId.");
  }
  const [entry] = matches;
  const entityType = entry.entityType?.toLowerCase();
  if ((entityType !== "user" && entityType !== "group") || !entry.entityId) {
    throw new ContentReadError("Brightspace returned feedback for an unsupported entity type.");
  }
  const file = entry.files.find(f => f.fileId === fileId)!;
  checkListedSize(file.size);
  return { path: apiClient.le(courseId, `/dropbox/folders/${folderId}/feedback/${entityType}/${entry.entityId}/attachments/${fileId}`),
    title: null, fallbackName: file.name ?? "feedback",
    reference: { attachment: { kind, folderId, entityType, entityId: entry.entityId, fileId } },
    sourceUrl: web(`/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${folderId}&ou=${courseId}`) };
}

export const registerReadCourseContent = defineTool(
  {
    name: "read_course_content",
    title: "Read Course Content",
    description: "Read a PDF, HTML, or plain-text file: a course content topic (topicId from get_course_content) or an attachment (assignment brief files from get_assignments, instructor feedback files on your own submissions from get_submission_history, announcement files from get_announcements). PDF results include physical 1-based page numbers for citations, plus an image of each page by default so scans, diagrams and equations are readable (pageImages: false for text only). Follow nextCursor until null to read more, using the same courseId and topicId or attachment and omitting page selection. Reads in memory; no file saves, OCR, external links, or completion updates.",
    schema: ReadCourseContentSchema,
  },
  async ({ courseId, topicId, attachment, startPage, endPage, maxChars, cursor, pageImages }, { apiClient, config }) => {
    try {
      const source = sourceIdentity(topicId, attachment);
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
        if (previous.courseId !== courseId || previous.source !== source) {
          throw new ContentReadError("This cursor belongs to a different course or file.");
        }
      }

      const resolved = await resolveSource(apiClient, config.baseUrl, courseId, topicId, attachment);
      const response = await apiClient.getRaw(resolved.path);
      const filename = contentFilename(response.headers.get("content-disposition") ?? "", resolved.fallbackName);
      const contentType = response.headers.get("content-type") ?? "";
      const buffer = await readContentBytes(response);
      const digest = createHash("sha256").update(contentType).update("\0").update(filename).update("\0").update(buffer).digest("hex");
      if (previous && previous.digest !== digest) {
        throw new ContentReadError("The document changed since the previous response. Restart reading without a cursor.");
      }
      const decoded = await decodeContent(buffer, contentType, filename);
      const metadata = {
        courseId, ...resolved.reference, title: resolved.title, filename,
        mimeType: decoded.mimeType, format: decoded.format, sourceUrl: resolved.sourceUrl,
      };
      const makeCursor = (page: number, offset: number, lastPage: number) => Buffer.from(JSON.stringify({
        version: 2, courseId, source, digest, page, offset, endPage: lastPage,
      })).toString("base64url");

      if (decoded.format === "pdf") {
        const result = await readPdfPages(buffer, { page: previous?.page ?? startPage ?? 1, offset: previous?.offset ?? 0 }, previous?.endPage ?? endPage, maxChars, { images: pageImages });
        const messages = [
          ...result.pages.some((page) => !page.hasText && !page.imageIncluded) ? ["Some returned pages have no extractable text. They may be blank or scanned; OCR is not supported."] : [],
          ...result.pages.some((page) => !page.hasText && page.imageIncluded) ? ["Some returned pages have no extractable text; read their page images instead."] : [],
          ...!result.imagesAvailable ? ["Page images are unavailable on this server; returning text only."] : [],
          ...result.renderFailures ? ["Some pages could not be rendered as images."] : [],
        ];
        const payload = {
          ...metadata, totalPages: result.totalPages, endPage: result.endPage, pages: result.pages,
          nextCursor: result.next ? makeCursor(result.next.page, result.next.offset, result.endPage) : null,
          ...(messages.length ? { message: messages.join(" ") } : {}),
        };
        if (!result.images.length) return toolResponse(payload);
        // No structuredContent here: clients that support it show it instead of the
        // content blocks, which would drop the page images.
        const text = toolResponse(payload).content;
        return {
          content: [...text, ...result.images.flatMap(({ page, mimeType, data, width, height }) => [
            { type: "text" as const, text: `Image of PDF page ${page} (${width}x${height}):` },
            { type: "image" as const, mimeType, data },
          ])],
        };
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
