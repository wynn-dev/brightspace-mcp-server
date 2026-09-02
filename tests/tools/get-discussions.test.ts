import { describe, it, expect } from "vitest";
import { registerGetDiscussions } from "../../src/tools/get-discussions.js";
import { ApiError } from "../../src/api/index.js";
import { captureTool, fakeApiClient, parse, text } from "./helpers.js";

const forum = (id: number) => ({
  ForumId: id,
  Name: `Forum ${id}`,
  Description: { Text: "desc", Html: "<p>desc</p>" },
  StartDate: null,
  EndDate: null,
  IsLocked: false,
  IsHidden: false,
  AllowAnonymous: false,
  RequiresApproval: false,
});

const topicOf = (forumId: number, id: number) => ({
  ForumId: forumId,
  TopicId: id,
  Name: `Topic ${id}`,
  Description: null,
  StartDate: null,
  EndDate: null,
  DueDate: null,
  IsLocked: false,
  IsHidden: false,
  AllowAnonymousPosts: false,
  MustPostToParticipate: false,
  RequiresApproval: false,
  ScoreOutOf: null,
});

const post = (id: number, datePosted: string, overrides: Record<string, unknown> = {}) => ({
  ForumId: 1,
  TopicId: 1,
  PostId: id,
  ThreadId: 1,
  ParentPostId: null,
  Subject: `Post ${id}`,
  Message: { Text: `msg ${id}`, Html: `<p>msg ${id}</p>` },
  PostingUserId: 5,
  PostingUserDisplayName: "Alice",
  DatePosted: datePosted,
  IsAnonymous: false,
  IsDeleted: false,
  LastEditedDate: null,
  ReplyPostIds: [],
  WordCount: 2,
  AttachmentCount: 0,
  IsRead: true,
  ...overrides,
});

describe("get_discussions", () => {
  it("requires forumId when topicId is given", async () => {
    const { call } = captureTool(registerGetDiscussions, fakeApiClient());
    const result = await call({ courseId: 2, topicId: 9 });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/topicId requires forumId/);
  });

  it("lists forums with their topics, tolerating forums whose topics are 403", async () => {
    const apiClient = fakeApiClient({
      "/2/discussions/forums/": [forum(1), forum(2)],
      "/forums/1/topics/": [topicOf(1, 10)],
      "/forums/2/topics/": () => {
        throw new ApiError(403, "/x", "forbidden");
      },
    });
    const { call } = captureTool(registerGetDiscussions, apiClient);

    const result = parse(await call({ courseId: 2 }));

    expect(result.forumCount).toBe(2);
    expect(result.forums[0]).toMatchObject({ forumId: 1, name: "Forum 1", topics: [expect.objectContaining({ topicId: 10 })] });
    expect(result.forums[1]).toMatchObject({ forumId: 2, topics: [] });
  });

  it("returns a topic's posts oldest-first, without deleted ones, anonymising as needed", async () => {
    const apiClient = fakeApiClient({
      "/forums/1/topics/10/posts/": [
        post(3, "2026-09-03T00:00:00Z", { IsAnonymous: true }),
        post(1, "2026-09-01T00:00:00Z"),
        post(2, "2026-09-02T00:00:00Z", { IsDeleted: true }),
      ],
      "/forums/1/topics/10": topicOf(1, 10),
    });
    const { call } = captureTool(registerGetDiscussions, apiClient);

    const result = parse(await call({ courseId: 2, forumId: 1, topicId: 10 }));

    expect(result.topic).toMatchObject({ topicId: 10, name: "Topic 10" });
    expect(result.postCount).toBe(3);
    expect(result.posts.map((p: { postId: number; author: string }) => [p.postId, p.author])).toEqual([
      [1, "Alice"],
      [3, "Anonymous"],
    ]);
    expect(result.posts[0].message).toContain("msg 1");
  });
});
