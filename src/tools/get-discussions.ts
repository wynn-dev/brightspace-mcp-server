/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_CACHE_TTLS, isApiStatus, type D2LApiClient } from "../api/index.js";
import { GetDiscussionsSchema } from "./schemas.js";
import { defineTool } from "./define-tool.js";
import { toolResponse, errorResponse } from "./tool-helpers.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { log } from "../utils/logger.js";

// D2L Discussion API response types
interface D2LForum {
  ForumId: number;
  Name: string;
  Description: { Text: string; Html: string } | null;
  StartDate: string | null;
  EndDate: string | null;
  IsLocked: boolean;
  IsHidden: boolean;
  AllowAnonymous: boolean;
  RequiresApproval: boolean;
}

interface D2LTopic {
  ForumId: number;
  TopicId: number;
  Name: string;
  Description: { Text: string; Html: string } | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsLocked: boolean;
  IsHidden: boolean;
  AllowAnonymousPosts: boolean;
  MustPostToParticipate: boolean;
  RequiresApproval: boolean;
  ScoreOutOf: number | null;
}

interface D2LPost {
  ForumId: number;
  TopicId: number;
  PostId: number;
  ThreadId: number;
  ParentPostId: number | null;
  Subject: string;
  Message: { Text: string; Html: string };
  PostingUserId: number | null;
  PostingUserDisplayName: string;
  DatePosted: string;
  IsAnonymous: boolean;
  IsDeleted: boolean;
  LastEditedDate: string | null;
  ReplyPostIds: number[];
  WordCount: number;
  AttachmentCount: number;
  IsRead: boolean;
}

export const registerGetDiscussions = defineTool(
  {
    name: "get_discussions",
    title: "Get Discussions",
    description:
      "Fetch discussion board content for a course including forums, topics, and posts. Use this when the user asks about discussion boards, forum posts, class discussions, or wants to see what's been posted. Provide just courseId to list all forums and their topics. Add forumId to get topics and posts for a specific forum. Add both forumId and topicId to get all posts in a specific discussion topic.",
    schema: GetDiscussionsSchema,
  },
  async ({ courseId, forumId, topicId }, { apiClient }) => {
    if (topicId !== undefined && forumId === undefined) {
      return errorResponse(
        "topicId requires forumId. Provide both forumId and topicId to get posts for a specific topic."
      );
    }
    if (forumId !== undefined && topicId !== undefined) {
      return getTopicPosts(apiClient, courseId, forumId, topicId);
    }
    if (forumId !== undefined) {
      return getForumDetail(apiClient, courseId, forumId);
    }
    return getForumsOverview(apiClient, courseId);
  }
);

function fetchTopics(apiClient: D2LApiClient, courseId: number, forumId: number) {
  return apiClient.get<D2LTopic[]>(
    apiClient.le(courseId, `/discussions/forums/${forumId}/topics/`),
    { ttl: DEFAULT_CACHE_TTLS.courseContent }
  );
}

function fetchPosts(apiClient: D2LApiClient, courseId: number, forumId: number, topicId: number) {
  return apiClient.get<D2LPost[]>(
    apiClient.le(courseId, `/discussions/forums/${forumId}/topics/${topicId}/posts/`),
    { ttl: DEFAULT_CACHE_TTLS.announcements }
  );
}

/**
 * Get all forums for a course with their topics (no posts).
 */
async function getForumsOverview(apiClient: D2LApiClient, courseId: number): Promise<CallToolResult> {
  const forums = await apiClient.get<D2LForum[]>(
    apiClient.le(courseId, "/discussions/forums/"),
    { ttl: DEFAULT_CACHE_TTLS.courseContent }
  );

  const result = [];

  for (const forum of forums) {
    let topics: D2LTopic[] = [];
    try {
      topics = await fetchTopics(apiClient, courseId, forum.ForumId);
    } catch (error) {
      if (isApiStatus(error, 403)) {
        log("DEBUG", `No access to topics for forum ${forum.ForumId}, skipping`);
      } else {
        log("DEBUG", `Failed to fetch topics for forum ${forum.ForumId}`, error);
      }
    }

    result.push({
      forumId: forum.ForumId,
      name: forum.Name,
      description: forum.Description?.Text ?? null,
      isLocked: forum.IsLocked,
      isHidden: forum.IsHidden,
      topics: topics.map((t) => ({
        topicId: t.TopicId,
        forumId: t.ForumId,
        name: t.Name,
        description: t.Description?.Text ?? null,
        dueDate: t.DueDate,
        isLocked: t.IsLocked,
        isHidden: t.IsHidden,
        mustPostToParticipate: t.MustPostToParticipate,
        scoreOutOf: t.ScoreOutOf,
      })),
    });
  }

  log("INFO", `get_discussions: Retrieved ${forums.length} forums for course ${courseId}`);

  return toolResponse({ courseId, forumCount: result.length, forums: result });
}

/**
 * Get a specific forum with its topics and posts.
 */
async function getForumDetail(
  apiClient: D2LApiClient,
  courseId: number,
  forumId: number
): Promise<CallToolResult> {
  const forum = await apiClient.get<D2LForum>(
    apiClient.le(courseId, `/discussions/forums/${forumId}`),
    { ttl: DEFAULT_CACHE_TTLS.courseContent }
  );
  const topics = await fetchTopics(apiClient, courseId, forumId);

  const topicsWithPosts = [];
  for (const topic of topics) {
    let posts: D2LPost[] = [];
    try {
      posts = await fetchPosts(apiClient, courseId, forumId, topic.TopicId);
    } catch (error) {
      if (isApiStatus(error, 403)) {
        log("DEBUG", `No access to posts for topic ${topic.TopicId}, skipping`);
      } else {
        log("DEBUG", `Failed to fetch posts for topic ${topic.TopicId}`, error);
      }
    }

    topicsWithPosts.push({
      topicId: topic.TopicId,
      name: topic.Name,
      description: topic.Description?.Html
        ? convertHtmlToMarkdown(topic.Description.Html).markdown
        : topic.Description?.Text ?? null,
      dueDate: topic.DueDate,
      isLocked: topic.IsLocked,
      mustPostToParticipate: topic.MustPostToParticipate,
      scoreOutOf: topic.ScoreOutOf,
      postCount: posts.length,
      posts: formatPosts(posts),
    });
  }

  log("INFO", `get_discussions: Retrieved forum ${forumId} with ${topics.length} topics for course ${courseId}`);

  return toolResponse({
    courseId,
    forum: {
      forumId: forum.ForumId,
      name: forum.Name,
      description: forum.Description?.Text ?? null,
      isLocked: forum.IsLocked,
      isHidden: forum.IsHidden,
    },
    topicCount: topicsWithPosts.length,
    topics: topicsWithPosts,
  });
}

/**
 * Get all posts for a specific topic.
 */
async function getTopicPosts(
  apiClient: D2LApiClient,
  courseId: number,
  forumId: number,
  topicId: number
): Promise<CallToolResult> {
  const topic = await apiClient.get<D2LTopic>(
    apiClient.le(courseId, `/discussions/forums/${forumId}/topics/${topicId}`),
    { ttl: DEFAULT_CACHE_TTLS.courseContent }
  );
  const posts = await fetchPosts(apiClient, courseId, forumId, topicId);

  log("INFO", `get_discussions: Retrieved ${posts.length} posts for topic ${topicId} in forum ${forumId}`);

  return toolResponse({
    courseId,
    forumId,
    topic: {
      topicId: topic.TopicId,
      name: topic.Name,
      description: topic.Description?.Html
        ? convertHtmlToMarkdown(topic.Description.Html).markdown
        : topic.Description?.Text ?? null,
      dueDate: topic.DueDate,
      isLocked: topic.IsLocked,
      mustPostToParticipate: topic.MustPostToParticipate,
      scoreOutOf: topic.ScoreOutOf,
    },
    postCount: posts.length,
    posts: formatPosts(posts),
  });
}

/**
 * Format posts into a clean thread structure, oldest first, deleted posts dropped.
 */
function formatPosts(posts: D2LPost[]) {
  return posts
    .filter((p) => !p.IsDeleted)
    .map((p) => ({
      postId: p.PostId,
      threadId: p.ThreadId,
      parentPostId: p.ParentPostId,
      subject: p.Subject,
      message: p.Message?.Html
        ? convertHtmlToMarkdown(p.Message.Html).markdown
        : p.Message?.Text ?? "",
      author: p.IsAnonymous ? "Anonymous" : p.PostingUserDisplayName,
      datePosted: p.DatePosted,
      lastEditedDate: p.LastEditedDate,
      replyCount: p.ReplyPostIds?.length ?? 0,
      wordCount: p.WordCount,
      attachmentCount: p.AttachmentCount,
      isRead: p.IsRead,
    }))
    .sort((a, b) => new Date(a.datePosted).getTime() - new Date(b.datePosted).getTime());
}
