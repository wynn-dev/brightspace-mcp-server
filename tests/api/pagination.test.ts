import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getAllLpPages,
  getAllObjectListPages,
  withBookmark,
  nextToPath,
  unwrapObjects,
} from "../../src/api/pagination.js";

/** Fake client answering exact paths; records every call. */
function fakeClient(routes: Record<string, unknown>) {
  const calls: Array<{ path: string; ttl?: number }> = [];
  return {
    calls,
    get: vi.fn(async (path: string, options?: { ttl?: number }) => {
      calls.push({ path, ttl: options?.ttl });
      if (!(path in routes)) throw new Error(`no route for ${path}`);
      return routes[path];
    }),
  };
}

const lp = <T>(items: T[], bookmark?: string) => ({
  Items: items,
  PagingInfo: { HasMoreItems: bookmark !== undefined, Bookmark: bookmark ?? null },
});
const le = <T>(objects: T[], next?: string) => ({ Objects: objects, Next: next ?? null });

describe("withBookmark", () => {
  it("adds ?bookmark= or &bookmark= depending on an existing query, url-encoding the value", () => {
    expect(withBookmark("/a", "b1")).toBe("/a?bookmark=b1");
    expect(withBookmark("/a?x=1", "b 2&")).toBe("/a?x=1&bookmark=b%202%26");
  });
});

describe("nextToPath", () => {
  it("strips the host from an absolute Next URL and keeps the query", () => {
    expect(nextToPath("https://lms.example.edu/d2l/api/le/1.0/1/classlist/paged/?bookmark=abc")).toBe(
      "/d2l/api/le/1.0/1/classlist/paged/?bookmark=abc"
    );
  });

  it("accepts a path-relative Next", () => {
    expect(nextToPath("/x/y?z=1")).toBe("/x/y?z=1");
  });
});

describe("unwrapObjects", () => {
  it("accepts an array, an ObjectListPage, or nothing", () => {
    expect(unwrapObjects([1, 2])).toEqual([1, 2]);
    expect(unwrapObjects({ Objects: [3] })).toEqual([3]);
    expect(unwrapObjects({})).toEqual([]);
    expect(unwrapObjects(null)).toEqual([]);
  });
});

describe("getAllLpPages", () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  it("follows the bookmark chain and forwards the ttl", async () => {
    const client = fakeClient({
      "/p?a=1": lp([1, 2], "b1"),
      "/p?a=1&bookmark=b1": lp([3], "b2"),
      "/p?a=1&bookmark=b2": lp([4]),
    });

    const items = await getAllLpPages<number>(client, "/p?a=1", { ttl: 5 });

    expect(items).toEqual([1, 2, 3, 4]);
    expect(client.calls).toEqual([
      { path: "/p?a=1", ttl: 5 },
      { path: "/p?a=1&bookmark=b1", ttl: 5 },
      { path: "/p?a=1&bookmark=b2", ttl: 5 },
    ]);
  });

  it("stops at maxPages with a warning", async () => {
    const client = fakeClient({
      "/p": lp([1], "b1"),
      "/p?bookmark=b1": lp([2], "b2"),
      "/p?bookmark=b2": lp([3], "b3"),
    });

    const items = await getAllLpPages<number>(client, "/p", { maxPages: 2, label: "things" });

    expect(items).toEqual([1, 2]);
    expect(client.calls).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stopped after 2 pages for things"));
  });

  it("stops early once maxItems is reached", async () => {
    const client = fakeClient({ "/p": lp([1, 2, 3], "b1"), "/p?bookmark=b1": lp([4]) });

    const items = await getAllLpPages<number>(client, "/p", { maxItems: 2 });

    expect(items).toEqual([1, 2, 3]);
    expect(client.calls).toHaveLength(1);
  });
});

describe("getAllObjectListPages", () => {
  it("follows absolute Next URLs as host-less paths", async () => {
    const client = fakeClient({
      "/o": le([1], "https://lms.example.edu/o?page=2"),
      "/o?page=2": le([2], "https://lms.example.edu/o?page=3"),
      "/o?page=3": le([3]),
    });

    const items = await getAllObjectListPages<number>(client, "/o");

    expect(items).toEqual([1, 2, 3]);
    expect(client.calls.map((c) => c.path)).toEqual(["/o", "/o?page=2", "/o?page=3"]);
  });

  it("passes a plain array through with a single request", async () => {
    const client = fakeClient({ "/arr": [7, 8] });

    expect(await getAllObjectListPages<number>(client, "/arr")).toEqual([7, 8]);
    expect(client.calls).toHaveLength(1);
  });

  it("stops early once maxItems is reached", async () => {
    const client = fakeClient({ "/m": le([1, 2], "https://h/m?p=2"), "/m?p=2": le([3]) });

    expect(await getAllObjectListPages<number>(client, "/m", { maxItems: 2 })).toEqual([1, 2]);
    expect(client.calls).toHaveLength(1);
  });

  it("does not loop when the server echoes the current page as Next", async () => {
    const client = fakeClient({ "/echo": le([1], "https://h/echo") });

    expect(await getAllObjectListPages<number>(client, "/echo")).toEqual([1]);
    expect(client.calls).toHaveLength(1);
  });
});
