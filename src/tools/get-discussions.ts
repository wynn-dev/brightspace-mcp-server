/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { recordLimit } from "../utils/read-status.js";
import { defineTool } from "./define-tool.js";
import { GetDiscussionsSchema } from "./schemas.js";
import { readList, readObject, id, str, num, richText, page, type Row } from "../services/data.js";
import { fetchDiscussionPosts } from "../services/discussions.js";
import { toolResponse, errorResponse } from "./tool-helpers.js";
const mapTopic = (t: Row) => ({ topicId: id(t.TopicId), forumId: id(t.ForumId), name: str(t.Name), description: richText(t.Description),
  dueDate: str(t.DueDate), isLocked: t.IsLocked ?? null, isHidden: t.IsHidden ?? null, mustPostToParticipate: t.MustPostToParticipate ?? null, scoreOutOf: num(t.ScoreOutOf) });
export const registerGetDiscussions = defineTool({ name: "get_discussions", title: "Get Discussions",
  description: "Read forums and topics, or a page of discussion posts. Supply forumId and topicId for threadId, unreadOnly, ownOnly and since filters. Follow nextPage even after an empty filtered page. No posts or read-status changes.", schema: GetDiscussionsSchema },
async ({ courseId, forumId, topicId, ...options }, { apiClient }) => {
  if ((topicId && !forumId) || ((options.threadId || options.unreadOnly || options.ownOnly || options.since || options.threadsOnly) && !topicId))
    return errorResponse("Post filters require both forumId and topicId; topicId requires forumId.");
  const root = apiClient.le(courseId, "/discussions/forums/");
  if (forumId && topicId) {
    const topic = await readObject(apiClient, `${root}${forumId}/topics/${topicId}`);
    return toolResponse({ courseId, forumId, topic: topic.data ? mapTopic(topic.data) : null, topicStatus: topic.status,
      ...await fetchDiscussionPosts(apiClient, courseId, forumId, topicId, options) });
  }
  const forums = forumId ? await readObject(apiClient, `${root}${forumId}`).then(r => ({ ...r, data: r.data ? [r.data] : null })) : await readList(apiClient, root, 500);
  const selectedForums = forumId ? { items: forums.data ?? [], nextOffset: null } : page(forums.data ?? [], (options.pageNumber - 1) * options.pageSize, options.pageSize);
  const result = [];
  for (const f of selectedForums.items) {
    const fid = id(f.ForumId);
    if (!fid) { recordLimit("Discussion forum response contained an invalid ID"); continue; }
    const topics = await readList(apiClient, `${root}${fid}/topics/`, 500);
    const topicPageNumber = forumId ? options.pageNumber : 1;
    const selectedTopics = page(topics.data ?? [], (topicPageNumber - 1) * options.pageSize, options.pageSize);
    result.push({ forumId: fid, name: str(f.Name), description: richText(f.Description), isLocked: f.IsLocked ?? null,
      isHidden: f.IsHidden ?? null, topicStatus: topics.status, topics: selectedTopics.items.map(mapTopic),
      topicPageNumber, nextTopicPage: selectedTopics.nextOffset === null ? null : topicPageNumber + 1 });
  }
  return toolResponse({ courseId, status: forums.status, forumCount: result.length, forums: result, pageNumber: options.pageNumber, pageSize: options.pageSize,
    nextPage: forumId ? result[0]?.nextTopicPage ?? null : selectedForums.nextOffset === null ? null : options.pageNumber + 1 });
});
