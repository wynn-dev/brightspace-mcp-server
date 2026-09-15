import { defineTool } from "./define-tool.js";
import { UpdatesSchema } from "./workflow-schemas.js";
import { readList, object, id, str, richText, page, type Row } from "../services/data.js";
import { fetchEnrolledCourses } from "./course-helpers.js";
import { recordLimit } from "../utils/read-status.js";
import { toolResponse, errorResponse } from "./tool-helpers.js";
export const registerGetCourseUpdates = defineTool({ name: "get_course_updates", title: "Get Course Updates",
  description: "Read course update counts, the user's recent feed, and announcements created or edited since a timestamp. Includes pinned news. This is an on-demand view, not an exhaustive changelog or outbound notification service.", schema: UpdatesSchema },
async ({ courseId, since, until: untilArg, offset, limit }, { apiClient, config }) => {
  const until = untilArg ?? new Date().toISOString();
  if (Date.parse(until) <= Date.parse(since)) return errorResponse("until must be later than since");
  const courses = courseId ? [{ id: courseId }] : await fetchEnrolledCourses(apiClient, config);
  const ids = courses.map(c => c.id), counts: Row[] = [], sources = [];
  for (let index = 0; index < ids.length; index += 100) {
    const result = await readList(apiClient, apiClient.leGlobal(`/updates/myUpdates/?orgUnitIdsCSV=${ids.slice(index, index + 100).join(",")}&updateTypesCSV=1,3,6`));
    counts.push(...(result.data ?? [])); sources.push({ source: "counts", status: result.status });
  }
  const feed = await readList(apiClient, apiClient.lp(`/feed/?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`));
  const updates: Row[] = [];
  let unscoped = 0;
  for (const f of feed.data ?? []) {
    const metadata = object(f.Metadata ?? f.MessageMetaData), resource = object(f.Resource);
    let org = id(metadata.OrgUnitId) ?? id(resource.OrgUnitId);
    // Documented feed metadata normally supplies an API URL rather than an OrgUnitId.
    if (!org && typeof metadata.ApiViewUrl === "string") {
      try {
        const url = new URL(metadata.ApiViewUrl, config.baseUrl);
        if (url.origin === new URL(config.baseUrl).origin)
          org = id(url.pathname.match(/^\/d2l\/api\/(?:le|lp)\/\d+\.\d+\/(\d+)\//)?.[1]);
      } catch { /* Unknown course identity remains explicit below. */ }
    }
    if (org === null) { unscoped++; continue; }
    if (!ids.includes(org)) continue;
    updates.push({ source: "feed", courseId: org, type: str(f.Type), id: id(resource.Id),
      title: str(metadata.Title), summary: richText(metadata.Summary), date: str(metadata.Date),
      apiViewUrl: str(metadata.ApiViewUrl), sourceUrl: str(metadata.WebViewUrl) });
  }
  sources.push({ source: "feed", status: feed.status });
  if (unscoped) recordLimit(`${unscoped} feed entries without verifiable course identity omitted; per-course news is also checked`);
  for (const course of courses) {
    const news = await readList(apiClient, apiClient.le(course.id, "/news/"), 1000);
    sources.push({ source: `news:${course.id}`, status: news.status });
    for (const n of news.data ?? []) {
      const modified = str(n.LastModifiedDate) ?? str(n.CreatedDate);
      if (n.IsPublished === false || !modified || Date.parse(modified) < Date.parse(since) || Date.parse(modified) > Date.parse(until)) continue;
      updates.push({ source: "news", courseId: course.id, id: id(n.Id), title: str(n.Title), body: richText(n.Body),
        createdDate: str(n.CreatedDate), lastModifiedDate: modified, isPinned: n.IsPinned === true, attachments: n.Attachments ?? [] });
    }
  }
  updates.sort((a, b) => String(b.lastModifiedDate ?? b.date ?? "").localeCompare(String(a.lastModifiedDate ?? a.date ?? "")));
  return toolResponse({ since, until, sources, counts, countsNote: "Counts of -1 mean not requested, not zero. Feed and news may overlap; edits to every content type are not exposed.", ...page(updates, offset, limit) });
});
