import type { D2LApiClient } from "../api/index.js";
import { readObject, rows, id, str, richText, type Row } from "./data.js";
import { readSource, recordLimit } from "../utils/read-status.js";
import { contentFilename, decodeContent, readContentBytes, textSliceEnd, ContentReadError } from "../utils/content-reader.js";
import { readPdfPages } from "../utils/pdf-extractor.js";

export async function courseTopics(api: D2LApiClient, courseId: number, baseUrl: string) {
  const toc = await readObject(api, api.le(courseId, "/content/toc"));
  const topics: Row[] = [], seen = new Set<number>(); let scanned = 0;
  const walk = (nodes: Row[], parents: string[], depth: number) => {
    if (!nodes.length) return;
    if (depth > 10) { recordLimit("Document discovery depth capped at 10"); return; }
    for (const node of nodes) {
      if (++scanned > 2000) { recordLimit("Document discovery capped at 2000 nodes"); return; }
      if (node.IsHidden === true || node.IsLocked === true) continue;
      const title = str(node.Title) ?? "", topicId = id(node.TopicId);
      if (topicId && (node.TopicType === undefined || node.TopicType === 1) && !seen.has(topicId)) {
        seen.add(topicId);
        topics.push({ courseId, topicId, title, description: richText(node.Description), modulePath: parents.join(" / "),
          sourceUrl: new URL(`/d2l/le/content/${courseId}/viewContent/${topicId}/View`, baseUrl).href });
      }
      walk([...rows(node.Modules), ...rows(node.Topics)], [...parents, title], depth + 1);
    }
  };
  if (toc.data) walk([...rows(toc.data.Modules), ...rows(toc.data.Topics)], [], 0);
  return { status: toc.status, topics };
}

/** Bounded excerpts for search/fallbacks; continuation remains in read_course_content. */
export async function documentExcerpt(api: D2LApiClient, courseId: number, topicId: number, maxChars = 20_000) {
  const source = api.le(courseId, `/content/topics/${topicId}/file`);
  return readSource(source, async () => {
    const topic = await api.get<Row>(api.le(courseId, `/content/topics/${topicId}`));
    if (topic.TopicType !== 1) throw new ContentReadError("Topic is not an uploaded file.");
    const response = await api.getRaw(source);
    const filename = contentFilename(response.headers.get("content-disposition") ?? "", str(topic.Url)?.split("?")[0] ?? "document");
    const buffer = await readContentBytes(response);
    const decoded = await decodeContent(buffer, response.headers.get("content-type") ?? "", filename);
    if (decoded.format === "pdf") {
      const result = await readPdfPages(buffer, { page: 1, offset: 0 }, undefined, maxChars);
      return { format: "pdf", filename, pages: result.pages, text: null, truncated: !!result.next, totalPages: result.totalPages };
    }
    const end = textSliceEnd(decoded.text, 0, maxChars);
    return { format: decoded.format, filename, pages: [], text: decoded.text.slice(0, end), truncated: end < decoded.text.length, totalPages: null };
  });
}

export async function courseMaterialFallback(api: D2LApiClient, courseId: number, baseUrl: string, kind: "syllabus" | "staff") {
  const found = await courseTopics(api, courseId, baseUrl);
  const pattern = kind === "syllabus" ? /syllabus|study guide|course (?:guide|manual|overview|information|outline|handbook)|studiewijzer/i : /staff|teaching team|teacher|lecturer|instructor|contact|docent/i;
  const candidates = found.topics.filter(t => pattern.test(`${t.modulePath} ${t.title}`));
  if (candidates.length > 3) recordLimit(`${kind} fallback limited to three course materials; use search_course for more`);
  const materials = [];
  for (const candidate of candidates.slice(0, 3)) {
    const excerpt = await documentExcerpt(api, courseId, Number(candidate.topicId), 10_000);
    if (excerpt.data?.truncated) recordLimit(`${kind} material excerpt truncated; use read_course_content for continuation`);
    materials.push({ ...candidate, status: excerpt.status, excerpt: excerpt.data });
  }
  return { status: found.status, materials, candidateCount: candidates.length,
    note: "Candidates selected from accessible course-content titles. These excerpts do not establish an official syllabus, verified staff membership, or personal deadlines." };
}
