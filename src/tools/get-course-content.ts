/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { DEFAULT_CACHE_TTLS, isApiStatus, type D2LApiClient } from "../api/index.js";
import { GetCourseContentSchema } from "./schemas.js";
import { defineTool } from "./define-tool.js";
import { toolResponse } from "./tool-helpers.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { log } from "../utils/logger.js";

// D2L Content API response type
interface ContentObject {
  Id: number;
  Title: string;
  ShortTitle: string | null;
  Type: number; // 0 = Module, 1 = Topic
  Description: { Text: string; Html: string } | null;
  ModuleStartDate: string | null;
  ModuleEndDate: string | null;
  ModuleDueDate: string | null;
  IsHidden: boolean;
  IsLocked: boolean;
  LastModifiedDate: string | null;
  // Module-specific
  Structure?: ContentObject[];
  // Topic-specific
  TopicType?: number; // 1=File, 2=Link/URL, 3=ExternalLink, etc.
  Url?: string;
  StartDate?: string | null;
  EndDate?: string | null;
  DueDate?: string | null;
}

// Progress tracking
interface ContentProgress {
  UserId: number;
  ContentObjectId: number;
  IsRead: boolean;
  DateCompleted: string | null;
}

// Output tree — property order here is the JSON order clients see
interface ModuleNode {
  type: "module";
  id: number;
  title: string;
  description: string | null;
  dueDate: string | null;
  isHidden: boolean;
  isLocked: boolean;
  children: ContentNode[];
}

interface TopicNode {
  type: "topic";
  topicType: string;
  id: number;
  title: string;
  isHidden: boolean;
  isLocked: boolean;
  dueDate: string | null;
  isCompleted: boolean;
  completedDate: string | null;
  description?: string | null;
  topicId?: number;
  url?: string | null;
  content?: ReturnType<typeof convertHtmlToMarkdown>;
}

type ContentNode = ModuleNode | TopicNode;

// Topic type mapping
const TOPIC_TYPE_MAP: Record<number, string> = {
  1: "file",
  2: "link",
  3: "link", // External link
};

function matchesTypeFilter(item: ContentObject, filter: string): boolean {
  switch (filter) {
    case "file":
      return item.TopicType === 1;
    case "link":
      return item.TopicType === 2 || item.TopicType === 3;
    case "html":
      return !!item.Description?.Html && item.TopicType !== 1;
    case "video":
      return (
        (item.TopicType === 2 || item.TopicType === 3) &&
        /youtube|vimeo|kaltura|video/i.test(item.Url ?? "")
      );
    default:
      return true;
  }
}

/**
 * Recursively build the content tree with progress tracking.
 */
async function buildContentTree(
  apiClient: D2LApiClient,
  courseId: number,
  modules: ContentObject[],
  progressMap: Map<number, ContentProgress>,
  typeFilter: string,
  maxDepth?: number,
  currentDepth: number = 0
): Promise<ContentNode[]> {
  const tree: ContentNode[] = [];

  for (const item of modules) {
    if (item.Type === 0) {
      // Module — fetch children recursively (unless maxDepth reached)
      let processedChildren: ContentNode[] = [];

      if (maxDepth === undefined || currentDepth < maxDepth) {
        let children: ContentObject[] = [];
        try {
          children = await apiClient.get<ContentObject[]>(
            apiClient.le(courseId, `/content/modules/${item.Id}/structure/`),
            { ttl: DEFAULT_CACHE_TTLS.courseContent }
          );
        } catch {
          log("DEBUG", `Failed to fetch children for module ${item.Id}: skipping`);
        }

        processedChildren = await buildContentTree(
          apiClient, courseId, children, progressMap, typeFilter, maxDepth, currentDepth + 1
        );
      }

      // Only include module if it has matching children (or filter is 'all')
      if (typeFilter === "all" || processedChildren.length > 0) {
        tree.push({
          type: "module",
          id: item.Id,
          title: item.Title,
          description: item.Description?.Text ?? null,
          dueDate: item.ModuleDueDate ?? null,
          isHidden: item.IsHidden,
          isLocked: item.IsLocked,
          children: processedChildren,
        });
      }
    } else if (item.Type === 1) {
      const topicType = TOPIC_TYPE_MAP[item.TopicType ?? 0] ?? "other";

      if (typeFilter !== "all" && !matchesTypeFilter(item, typeFilter)) {
        continue;
      }

      const topicProgress = progressMap.get(item.Id);

      const topic: TopicNode = {
        type: "topic",
        topicType,
        id: item.Id,
        title: item.Title,
        isHidden: item.IsHidden,
        isLocked: item.IsLocked,
        dueDate: item.DueDate ?? null,
        isCompleted: topicProgress?.IsRead ?? false,
        completedDate: topicProgress?.DateCompleted ?? null,
      };

      if (item.TopicType === 1) {
        // File topic — include description and the id download_file needs
        topic.description = item.Description?.Text ?? null;
        topic.topicId = item.Id;
      } else if (item.TopicType === 2 || item.TopicType === 3) {
        topic.url = item.Url ?? null;
      }

      // HTML content — include body converted to markdown
      if (item.Description?.Html) {
        topic.content = convertHtmlToMarkdown(item.Description.Html);
      }

      tree.push(topic);
    }
  }

  return tree;
}

function countTopics(tree: ContentNode[]): number {
  let count = 0;
  for (const item of tree) {
    if (item.type === "topic") {
      count++;
    } else {
      count += countTopics(item.children);
    }
  }
  return count;
}

function countModules(tree: ContentNode[]): number {
  let count = 0;
  for (const item of tree) {
    if (item.type === "module") {
      count += 1 + countModules(item.children);
    }
  }
  return count;
}

export const registerGetCourseContent = defineTool(
  {
    name: "get_course_content",
    title: "Get Course Content",
    description:
      "Fetch the content tree for a course showing modules, topics, files, and links. Use this when the user asks about course materials, lecture slides, uploaded files, content structure, or what's in a course module. Use moduleTitle to filter to a specific module (e.g. 'Labs', 'Staff', 'Homeworks') instead of fetching the entire tree. Use maxDepth to limit recursion depth for a table-of-contents view.",
    schema: GetCourseContentSchema,
  },
  async ({ courseId, typeFilter = "all", moduleTitle, maxDepth }, { apiClient }) => {
    let rootModules = await apiClient.get<ContentObject[]>(
      apiClient.le(courseId, "/content/root/"),
      { ttl: DEFAULT_CACHE_TTLS.courseContent }
    );

    if (moduleTitle) {
      const searchTerm = moduleTitle.toLowerCase();
      rootModules = rootModules.filter((m) => m.Title.toLowerCase().includes(searchTerm));
    }

    // User progress is optional — 404/403 just means none is available
    let progressArray: ContentProgress[] = [];
    try {
      progressArray = await apiClient.get<ContentProgress[]>(
        apiClient.le(courseId, "/content/userprogress/"),
        { ttl: DEFAULT_CACHE_TTLS.courseContent }
      );
    } catch (error) {
      if (!isApiStatus(error, 404, 403)) {
        log("DEBUG", `Failed to fetch progress for course ${courseId}`, error);
      }
    }

    const progressMap = new Map<number, ContentProgress>();
    for (const p of progressArray) {
      progressMap.set(p.ContentObjectId, p);
    }

    const contentTree = await buildContentTree(
      apiClient, courseId, rootModules, progressMap, typeFilter, maxDepth
    );

    const topicCount = countTopics(contentTree);
    const moduleCount = countModules(contentTree);

    log("INFO", `get_course_content: Retrieved ${moduleCount} modules and ${topicCount} topics for course ${courseId} (filter: ${typeFilter})`);

    return toolResponse({ courseId, typeFilter, contentTree, topicCount, moduleCount });
  }
);
