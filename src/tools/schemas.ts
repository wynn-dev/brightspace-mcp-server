/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { z } from "zod";
import { paging, instant } from "./workflow-schemas.js";

/**
 * Zod schemas for MCP tool input validation.
 * Passed directly to MCP SDK as inputSchema — SDK detects Zod v4 via ._zod property.
 * Also used in tool handlers for runtime parsing via .parse(args).
 */

export const GetMyCoursesSchema = z.object({
  query: z.string().trim().min(1).max(200).optional(),
  includeDetails: z.boolean().default(false),
  semester: z.string().trim().min(1).max(200).optional(),
  onDate: z.iso.date().optional(),
  sort: z.enum(["enrollment", "recent", "name"]).default("enrollment"),
  // Intentionally has no default: omitting it falls back to the configured
  // D2L_ACTIVE_ONLY / config.json policy (true unless the user changed it).
  // A default here would silently override that configuration on every call.
  activeOnly: z
    .boolean()
    .optional()
    .describe(
      "Only return currently active courses. Defaults to the server's configured activeOnly setting (true unless overridden)."
    ),
});

export const GetMyGradesSchema = z.object({
  courseId: z.coerce.number().int().positive().optional().describe("Course ID to get grades for. If omitted, returns grades for all enrolled courses."),
});

export const GetAnnouncementsSchema = z.object({
  courseId: z.coerce.number().int().positive().optional().describe("Course ID to get announcements for. If omitted, returns recent announcements across all courses."),
  count: z.coerce.number().int().min(1).max(50).default(10).describe("Maximum number of announcements to return"),
});

export const GetAssignmentsSchema = z.object({
  folderId: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  courseId: z.coerce.number().int().positive().optional()
    .describe("Course ID to get assignments for. If omitted, returns assignments for all enrolled courses."),
  detail: z.boolean().optional()
    .describe("Include instructions, rubrics, attachments, submission history and all feedback. Defaults to true with folderId, otherwise false (summary rows)."),
});

export const GetCourseContentSchema = z.object({
  courseId: z.coerce.number().int().positive()
    .describe("Course ID to get content tree for."),
  typeFilter: z.enum(["file", "link", "html", "video", "all"]).default("all").optional()
    .describe("Optional filter to narrow results by content type."),
  moduleTitle: z.string().optional()
    .describe("Case-insensitive substring match on module titles. Only returns modules whose title contains this string (e.g. 'Labs', 'Staff', 'Homeworks'). Children of matching modules are included in full."),
  maxDepth: z.coerce.number().int().min(1).max(10).optional()
    .describe("Limit recursive depth of the content tree. Depth 1 returns top-level modules with direct children only. Useful for getting a table of contents without all nested content."),
  includeDescriptions: z.boolean().default(false)
    .describe("Return full module/topic descriptions as Markdown instead of short snippets."),
});

export const ReadCourseContentSchema = z.object({
  courseId: z.coerce.number().int().positive().describe("Course ID from get_my_courses."),
  topicId: z.coerce.number().int().positive().optional()
    .describe("File topic ID from get_course_content. Use either topicId or attachment."),
  attachment: z.object({
    kind: z.enum(["assignment", "feedback", "announcement"])
      .describe("assignment: brief attachment from get_assignments; feedback: instructor feedback file on your own submission from get_submission_history or get_assignments; announcement: file attached to an announcement from get_announcements."),
    fileId: z.coerce.number().int().positive().describe("fileId of the attachment."),
    folderId: z.coerce.number().int().positive().optional().describe("Assignment folderId. Required for assignment and feedback."),
    newsItemId: z.coerce.number().int().positive().optional().describe("Announcement id. Required for announcement."),
    entityType: z.string().regex(/^(user|group)$/i).optional()
      .describe("Feedback only, optional: entityType of your own feedback entry (user or group) to disambiguate."),
    entityId: z.coerce.number().int().positive().optional()
      .describe("Feedback only, optional: entityId of your own feedback entry to disambiguate."),
  }).strict().optional()
    .describe("Read a file that is not a content topic. Use either topicId or attachment."),
  startPage: z.coerce.number().int().positive().optional()
    .describe("First physical PDF page to read (1-based). PDF only; omit when using cursor."),
  endPage: z.coerce.number().int().positive().optional()
    .describe("Last physical PDF page to read, inclusive. PDF only; omit when using cursor."),
  maxChars: z.coerce.number().int().min(2).max(50_000).default(20_000)
    .describe("Maximum extracted text characters per response (default 20000, maximum 50000)."),
  cursor: z.string().min(1).max(2048).optional()
    .describe("Opaque nextCursor from a previous response for this document. Omit page selection when continuing."),
  pageImages: z.boolean().default(true)
    .describe("PDF only: also return each page as an image (up to 5 pages per response) so scans, diagrams and equations are readable. Set false for text only (up to 20 pages per response)."),
}).strict();

export const DownloadFileSchema = z.object({
  courseId: z.coerce.number().int().positive()
    .describe("Course ID the file belongs to."),
  topicId: z.coerce.number().int().positive().optional()
    .describe("Content topic ID to download (for course content files)."),
  folderId: z.coerce.number().int().positive().optional()
    .describe("Dropbox folder ID (for submission/feedback file downloads)."),
  fileId: z.coerce.number().int().positive().optional()
    .describe("Specific file ID within a dropbox submission."),
  downloadPath: z.string().min(1)
    .describe("Absolute path to the directory where the file should be saved."),
  customFilename: z.string().max(255).optional()
    .describe("Custom filename for the downloaded file (include extension). If not provided, uses the original filename from Brightspace."),
});

export const GetSyllabusSchema = z.object({
  includeContentFallback: z.boolean().default(true),
  courseId: z.coerce.number().int().positive()
    .describe("Course ID to get syllabus for."),
  downloadPath: z.string().min(1).optional()
    .describe("Absolute path to the directory where the attachment should be saved."),
});

// Strict parsing also rejects downloadPath when the handler is invoked directly.
export const ReadOnlyGetSyllabusSchema = GetSyllabusSchema.omit({ downloadPath: true }).strict();

export const GetDiscussionsSchema = z.object({
  maxPagesToScan: z.coerce.number().int().min(1).max(10).default(1)
    .describe("Scan additional API pages when filters are sparse. Follow nextPage until null; each returned post is from a scanned page."),
  threadId: z.coerce.number().int().positive().optional(),
  pageNumber: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  unreadOnly: z.boolean().default(false),
  ownOnly: z.boolean().default(false),
  threadsOnly: z.boolean().default(false),
  since: instant.optional(),
  sort: z.enum(["creationdate", "-creationdate", "threaded"]).default("-creationdate"),
  courseId: z.coerce.number().int().positive()
    .describe("Course ID to get discussion boards for."),
  forumId: z.coerce.number().int().positive().optional()
    .describe("Specific forum ID to get topics and posts for. If omitted, returns all forums."),
  topicId: z.coerce.number().int().positive().optional()
    .describe("Specific topic ID to get posts for. Requires forumId."),
});

export const GetRosterSchema = z.object({
  includeContentFallback: z.boolean().default(true),
  ...paging,
  roleNames: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
  courseId: z.coerce.number().int().positive()
    .describe("Course ID to get roster for."),
  includeStudents: z.boolean().default(false)
    .describe("Include students in results. Default is instructors and TAs only."),
  searchTerm: z.string().max(200).optional()
    .describe("Optional search term to filter by name."),
});
