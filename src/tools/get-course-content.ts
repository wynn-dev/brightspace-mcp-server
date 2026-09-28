/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetCourseContentSchema } from "./schemas.js";
import { defineTool } from "./define-tool.js";
import { toolResponse } from "./tool-helpers.js";
import { readList, rows, id, str, num, richText, type Row } from "../services/data.js";
import { recordLimit } from "../utils/read-status.js";
import { courseProgress, moduleProgress, type ContentProgress } from "../services/progress.js";
import { log } from "../utils/logger.js";

/** Outline descriptions are cut to this many characters unless includeDescriptions is set. */
const SNIPPET_CHARS = 160;
const MAX_NODES = 2000;

// Output tree — property order here is the JSON order clients see
interface ModuleNode {
  type: "module";
  moduleId: number;
  title: string;
  /** Top-level modules only: Brightspace's required-topic completion count. */
  progress?: ContentProgress;
  description?: string;
  isHidden?: true;
  isLocked?: true;
  children: ContentNode[];
}

interface TopicNode {
  /** Topic kind: "file", "link", ... — "module" is reserved for modules. */
  type: string;
  topicId: number;
  title: string;
  dueDate?: string;
  isCompleted: boolean | null;
  completedDate?: string;
  unread?: true;
  isHidden?: true;
  isLocked?: true;
  description?: string;
  url?: string | null;
}

type ContentNode = ModuleNode | TopicNode;

interface Progress { dueDate: string | null; completionType: number | null; dateCompleted: string | null }

/** The table of contents names topic kinds; older payloads may carry the numeric TopicType instead. */
function topicKind(topic: Row): string {
  const identifier = str(topic.TypeIdentifier)?.toLowerCase();
  if (identifier) return identifier;
  return topic.TopicType === 1 ? "file" : topic.TopicType === 2 || topic.TopicType === 3 ? "link" : "other";
}

function matchesTypeFilter(topic: Row, kind: string, filter: string): boolean {
  switch (filter) {
    case "file":
      return kind === "file";
    case "link":
      return kind === "link";
    case "html":
      return !!str((topic.Description as Row | undefined)?.Html) && kind !== "file";
    case "video":
      return kind === "link" && /youtube|youtu\.be|vimeo|kaltura|video/i.test(str(topic.Url) ?? "");
    default:
      return true;
  }
}

/** Snippets end in "…" when shortened. */
function describe(node: { description?: string }, value: unknown, full: boolean) {
  const text = richText(value).trim();
  if (!text) return;
  node.description = full || text.length <= SNIPPET_CHARS ? text : `${text.slice(0, SNIPPET_CHARS).trimEnd()}…`;
}

/**
 * Build the outline from the course table of contents (one request) and join
 * due dates and completion from the scheduled-content list.
 */
function buildTree(
  modules: Row[], topics: Row[], progress: Map<number, Progress>,
  options: { typeFilter: string; maxDepth?: number; includeDescriptions: boolean; moduleProgress?: Map<number, ContentProgress> | null },
  depth = 0, budget = { nodes: 0 }
): ContentNode[] {
  const tree: ContentNode[] = [];
  // Topics and sub-modules interleave in Brightspace's SortOrder.
  const entries = [...topics.map(row => ({ row, isModule: false })), ...modules.map(row => ({ row, isModule: true }))]
    .sort((a, b) => (num(a.row.SortOrder) ?? 0) - (num(b.row.SortOrder) ?? 0));
  for (const { row, isModule } of entries) {
    if (++budget.nodes > MAX_NODES) { recordLimit(`Content outline capped at ${MAX_NODES} nodes; use moduleTitle`); break; }
    if (isModule) {
      const module = row;
      const children = options.maxDepth === undefined || depth < options.maxDepth
        ? buildTree(rows(module.Modules), rows(module.Topics), progress, options, depth + 1, budget)
        : [];
      if (options.maxDepth !== undefined && depth >= options.maxDepth && (rows(module.Modules).length || rows(module.Topics).length))
        recordLimit("Content depth limited by maxDepth");
      // Only include module if it has matching children (or filter is 'all')
      if (options.typeFilter !== "all" && children.length === 0) continue;
      const head: Omit<ModuleNode, "children"> = { type: "module", moduleId: id(module.ModuleId) ?? 0, title: str(module.Title) ?? "" };
      const counts = depth === 0 ? options.moduleProgress?.get(head.moduleId) : undefined;
      if (counts) head.progress = counts;
      describe(head, module.Description, options.includeDescriptions);
      if (module.IsHidden === true) head.isHidden = true;
      if (module.IsLocked === true) head.isLocked = true;
      tree.push({ ...head, children });
      continue;
    }
    const topic = row, topicId = id(topic.TopicId);
    if (!topicId) continue;
    const kind = topicKind(topic);
    if (options.typeFilter !== "all" && !matchesTypeFilter(topic, kind, options.typeFilter)) continue;
    const scheduled = progress.get(topicId);
    const node: TopicNode = {
      type: kind, topicId, title: str(topic.Title) ?? "",
      isCompleted: scheduled?.dateCompleted ? true : scheduled && [1, 2].includes(scheduled.completionType ?? -1) ? false : null,
    };
    const dueDate = scheduled?.dueDate ?? str(topic.DueDateTime) ?? str(topic.DueDate);
    if (dueDate) node.dueDate = dueDate;
    if (scheduled?.dateCompleted) node.completedDate = scheduled.dateCompleted;
    if (topic.Unread === true) node.unread = true;
    if (topic.IsHidden === true) node.isHidden = true;
    if (topic.IsLocked === true) node.isLocked = true;
    describe(node, topic.Description, options.includeDescriptions);
    if (kind === "link") node.url = str(topic.Url);
    tree.push(node);
  }
  return tree;
}

function count(tree: ContentNode[]): { topics: number; modules: number } {
  let topics = 0, modules = 0;
  for (const item of tree) {
    if (item.type !== "module") topics++;
    else { const inner = count((item as ModuleNode).children); modules += 1 + inner.modules; topics += inner.topics; }
  }
  return { topics, modules };
}

export const registerGetCourseContent = defineTool(
  {
    name: "get_course_content",
    title: "Get Course Content",
    description:
      "Fetch a compact outline of a course's modules, topics, files, and links with due dates, completion and unread flags. Use this when the user asks about course materials, lecture slides, uploaded files, content structure, or what's in a course module. Use moduleTitle to filter to a specific module (e.g. 'Labs', 'Staff', 'Homeworks') and maxDepth for a table of contents. Nodes are modules (type 'module', moduleId, children) or topics (type 'file', 'link', ...; topicId). Descriptions are shortened to a snippet ending in '…' unless includeDescriptions is true; false flags are omitted. To read a PDF, HTML, or plain-text file, call read_course_content with courseId and the file's topicId. Topic descriptions are not the uploaded file body. progress ({ completed, required }) is Brightspace's own count of completed vs required topics for the course and on each top-level module; it covers required topics only (optional topics are not counted in required) and is null when Brightspace does not return it: unavailable is not zero.",
    schema: GetCourseContentSchema,
  },
  async ({ courseId, typeFilter = "all", moduleTitle, maxDepth, includeDescriptions, includeProgress }, { apiClient }) => {
    const [toc, scheduled, courseCounts, moduleCounts] = await Promise.all([
      apiClient.get<Row>(apiClient.le(courseId, "/content/toc"), { ttl: DEFAULT_CACHE_TTLS.courseContent }),
      // Stable scheduled-content API. Unlisted/optional items have unknown completion.
      readList(apiClient, apiClient.le(courseId, "/content/myItems/")),
      includeProgress ? courseProgress(apiClient, courseId) : null,
      includeProgress ? moduleProgress(apiClient, courseId) : null,
    ]);

    let modules = rows(toc.Modules);
    if (moduleTitle) {
      const searchTerm = moduleTitle.toLowerCase();
      modules = modules.filter((m) => (str(m.Title) ?? "").toLowerCase().includes(searchTerm));
    }

    const progress = new Map<number, Progress>();
    for (const p of scheduled.data ?? []) {
      const itemId = id(p.ItemId);
      if (itemId) progress.set(itemId, { dueDate: str(p.DueDate), completionType: num(p.CompletionType), dateCompleted: str(p.DateCompleted) });
    }

    const contentTree = buildTree(modules, moduleTitle ? [] : rows(toc.Topics), progress,
      { typeFilter, maxDepth, includeDescriptions, moduleProgress: moduleCounts?.data });
    const { topics: topicCount, modules: moduleCount } = count(contentTree);

    log("INFO", `get_course_content: Retrieved ${moduleCount} modules and ${topicCount} topics for course ${courseId} (filter: ${typeFilter})`);

    // Unavailable counts stay null (see readStatus), never zero.
    return toolResponse({ courseId, typeFilter, ...includeProgress ? { progress: courseCounts?.data ?? null } : {},
      contentTree, topicCount, moduleCount });
  }
);
