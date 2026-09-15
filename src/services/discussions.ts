import type { D2LApiClient } from "../api/index.js";
import { readList, readObject, id, str, richText, num } from "./data.js";
import { recordLimit } from "../utils/read-status.js";
export interface PostOptions { pageNumber: number; pageSize: number; maxPagesToScan?: number; threadId?: number; unreadOnly?: boolean; ownOnly?: boolean; since?: string; threadsOnly?: boolean; sort?: string }
async function fetchDiscussionPage(api: D2LApiClient, courseId: number, forumId: number, topicId: number, options: PostOptions, reportContinuation = true) {
  const query = new URLSearchParams({ pageNumber: String(options.pageNumber), pageSize: String(options.pageSize), sort: options.sort ?? "-creationdate" });
  if (options.threadId) query.set("threadId", String(options.threadId));
  if (options.threadsOnly) query.set("threadsOnly", "true");
  const result = await readList(api, api.le(courseId, `/discussions/forums/${forumId}/topics/${topicId}/posts/?${query}`), options.pageSize);
  const user = options.ownOnly ? await readObject(api, api.lp("/users/whoami")) : null;
  const ownId = id(user?.data?.Identifier);
  const posts = (result.data ?? []).filter(p => p.IsDeleted !== true &&
    (!options.threadId || id(p.ThreadId) === options.threadId) && (!options.unreadOnly || p.IsRead === false) &&
    (!options.ownOnly || ownId !== null && id(p.PostingUserId) === ownId) &&
    (!options.since || typeof p.DatePosted === "string" && Date.parse(p.DatePosted) >= Date.parse(options.since)))
    .map(p => ({ postId: id(p.PostId), threadId: id(p.ThreadId), parentPostId: id(p.ParentPostId), subject: str(p.Subject), message: richText(p.Message),
      author: p.IsAnonymous === true ? "Anonymous" : str(p.PostingUserDisplayName), datePosted: str(p.DatePosted), lastEditedDate: str(p.LastEditedDate),
      replyCount: Array.isArray(p.ReplyPostIds) ? p.ReplyPostIds.length : null, wordCount: num(p.WordCount), attachmentCount: num(p.AttachmentCount),
      isRead: typeof p.IsRead === "boolean" ? p.IsRead : null }));
  const nextPage = result.status !== "available" || !result.complete || options.ownOnly && ownId === null ? options.pageNumber : result.data?.length === options.pageSize ? options.pageNumber + 1 : null;
  if (nextPage && reportContinuation) recordLimit("Discussion page may have more posts; follow nextPage even if local filters return no matches");
  return { status: result.status, identityStatus: user?.status ?? "not_requested", posts, postCount: posts.length,
    pageNumber: options.pageNumber, pageSize: options.pageSize, nextPage, pagesScanned: 1,
    exhausted: nextPage === null && result.complete,
    filterScope: "Unread, own-author and since filters apply to this API page; reading does not mark posts as read." };
}

export async function fetchDiscussionPosts(api: D2LApiClient, courseId: number, forumId: number, topicId: number, options: PostOptions) {
  if ((options.maxPagesToScan ?? 1) > 1) {
    const posts = []; let nextPage: number | null = options.pageNumber, pagesScanned = 0;
    let status = "available", identityStatus = "not_requested";
    while (nextPage !== null && pagesScanned < options.maxPagesToScan! && posts.length < options.pageSize) {
      const current = await fetchDiscussionPage(api, courseId, forumId, topicId,
        { ...options, maxPagesToScan: 1, pageNumber: nextPage }, false);
      pagesScanned++; status = current.status; identityStatus = current.identityStatus;
      posts.push(...current.posts);
      if (status !== "available" || current.nextPage === nextPage || options.ownOnly && identityStatus !== "available") break;
      nextPage = current.nextPage;
    }
    if (nextPage !== null) recordLimit("Discussion scan has unexamined posts; follow nextPage even if no matches were found");
    return { status, identityStatus, posts, postCount: posts.length, pageNumber: options.pageNumber, pageSize: options.pageSize,
      nextPage, pagesScanned, exhausted: nextPage === null && status === "available", filterScope: "Filters apply across scanned API pages. Follow nextPage; zero matches does not establish exhaustion." };
  }
  return fetchDiscussionPage(api, courseId, forumId, topicId, options);
}
