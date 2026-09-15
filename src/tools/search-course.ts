import { defineTool } from "./define-tool.js";
import { SearchSchema } from "./workflow-schemas.js";
import { readList, readObject, rows, id, str, richText, page, type Row } from "../services/data.js";
import { fetchDiscussionPosts } from "../services/discussions.js";
import { fetchEnrolledCourses } from "./course-helpers.js";
import { recordLimit } from "../utils/read-status.js";
import { toolResponse } from "./tool-helpers.js";
export const registerSearchCourse = defineTool({ name: "search_course", title: "Search Course Information",
  description: "Bounded case-insensitive keyword search across course descriptions, announcement bodies, assignment instructions, module/topic titles and discussion posts. Returns source references and search coverage. Does not index document bodies; use read_course_content for files.", schema: SearchSchema },
async ({ courseId, query, sources, offset, limit }, { apiClient, config }) => {
  const courses = courseId ? [{ id: courseId }] : await fetchEnrolledCourses(apiClient, config);
  const matches: Row[] = [], coverage: Row[] = [], needle = query.toLocaleLowerCase();
  const add = (cid: number, source: string, itemId: number | null, title: string, body: string, reference: Row = {}) => {
    const text = `${title}\n${body}`, index = text.toLocaleLowerCase().indexOf(needle);
    if (index < 0) return;
    matches.push({ courseId: cid, source, id: itemId, title, snippet: text.slice(Math.max(0, index - 100), index + needle.length + 300),
      sourceUrl: `${config.baseUrl.replace(/\/$/, "")}/d2l/home/${cid}`, ...reference });
  };
  for (const course of courses) {
    const cid = course.id;
    if (sources.includes("course")) {
      const result = await readObject(apiClient, apiClient.lp(`/courses/${cid}`));
      coverage.push({ courseId: cid, source: "course", status: result.status });
      if (result.data) add(cid, "course", cid, str(result.data.Name) ?? "", richText(result.data.Description));
    }
    for (const source of ["announcements", "assignments"] as const) {
      if (!sources.includes(source)) continue;
      const result = await readList(apiClient, apiClient.le(cid, source === "announcements" ? "/news/" : "/dropbox/folders/"), 500);
      coverage.push({ courseId: cid, source, status: result.status, scanned: result.data?.length ?? null });
      for (const r of result.data ?? []) if (r.IsHidden !== true && r.IsPublished !== false)
        add(cid, source, id(r.Id), str(r.Title ?? r.Name) ?? "", richText(r.Body ?? r.CustomInstructions), source === "assignments" ? { folderId: id(r.Id) } : {});
    }
    if (sources.includes("content")) {
      const toc = await readObject(apiClient, apiClient.le(cid, "/content/toc"));
      coverage.push({ courseId: cid, source: "content", status: toc.status });
      let scanned = 0;
      const walk = (nodes: Row[], depth = 0) => {
        if (depth > 10) { recordLimit("Search content depth capped at 10"); return; }
        for (const node of nodes) {
          if (++scanned > 2000) { recordLimit("Search content capped at 2000 nodes"); return; }
          add(cid, "content", id(node.TopicId ?? node.ModuleId), str(node.Title) ?? "", richText(node.Description),
            { topicId: id(node.TopicId), moduleId: id(node.ModuleId), sourceUrl: str(node.Url) ?? `/d2l/home/${cid}` });
          walk([...rows(node.Modules), ...rows(node.Topics)], depth + 1);
        }
      };
      if (toc.data) walk([...rows(toc.data.Modules), ...rows(toc.data.Topics)]);
    }
    if (sources.includes("discussions")) {
      const forums = await readList(apiClient, apiClient.le(cid, "/discussions/forums/"), 10);
      coverage.push({ courseId: cid, source: "discussion_forums", status: forums.status });
      for (const f of forums.data ?? []) {
        const fid = id(f.ForumId); if (!fid) continue;
        const topics = await readList(apiClient, apiClient.le(cid, `/discussions/forums/${fid}/topics/`), 10);
        coverage.push({ courseId: cid, source: "discussion_topics", forumId: fid, status: topics.status });
        for (const t of topics.data ?? []) {
          const tid = id(t.TopicId); if (!tid) continue;
          add(cid, "discussion_topic", tid, str(t.Name) ?? "", richText(t.Description), { forumId: fid, topicId: tid });
          const posts = await fetchDiscussionPosts(apiClient, cid, fid, tid, { pageNumber: 1, pageSize: 100 });
          coverage.push({ courseId: cid, source: "discussion_posts", forumId: fid, topicId: tid, status: posts.status, scanned: posts.postCount, nextPage: posts.nextPage });
          for (const p of posts.posts) add(cid, "discussion_post", p.postId, p.subject ?? "", p.message,
            { forumId: fid, topicId: tid, threadId: p.threadId, postId: p.postId });
        }
      }
    }
  }
  return toolResponse({ query, searchedSources: sources, coverage, documentBodiesSearched: false, ...page(matches, offset, limit) });
});
