import { describe, it, expect, vi } from "vitest";
import { withReadStatus, readSource, countRead, recordRead } from "../../src/utils/read-status.js";
import { getAllObjectListPages, getAllLpPages, ApiError } from "../../src/api/index.js";
const result = async () => ({ content: [{ type: "text" as const, text: "{}" }] });
describe("read-status isolation and pagination reliability", () => {
  it("isolates simultaneous requests and records cached freshness without overwriting it", async () => {
    const [a, b] = await Promise.all([
      withReadStatus(async () => { recordRead("a", "available", "2026-09-01T00:00:00Z", true); await readSource("a", async () => 1); return result(); }),
      withReadStatus(async () => { await readSource("b", async () => { throw new ApiError(403, "/b", "sensitive response"); }); return result(); }),
    ]);
    expect(a.structuredContent?.readStatus).toMatchObject({ partial: false, sources: [{ source: "a", fetchedAt: "2026-09-01T00:00:00Z", cached: true }] });
    expect(b.structuredContent?.readStatus).toMatchObject({ partial: true, sources: [{ source: "b", status: "forbidden" }] });
    expect(JSON.stringify(b)).not.toContain("sensitive response");
  });
  it("keeps already-read pages when a later page fails", async () => {
    const client = { get: vi.fn().mockResolvedValueOnce({ Objects: [1], Next: "/page2" }).mockRejectedValue(new ApiError(403, "/page2", "private")) };
    const r = await withReadStatus(async () => { expect(await getAllObjectListPages(client, "/page1")).toEqual([1]); return result(); });
    expect(r.structuredContent?.readStatus).toMatchObject({ partial: true, limits: [expect.stringContaining("Later page")] });
  });
  it("stops multi-page cycles before duplicating results", async () => {
    const client = { get: vi.fn().mockResolvedValueOnce({ Objects: [1], Next: "/b" }).mockResolvedValueOnce({ Objects: [2], Next: "/a" }) };
    const r = await withReadStatus(async () => { expect(await getAllObjectListPages(client, "/a")).toEqual([1, 2]); return result(); });
    expect(client.get).toHaveBeenCalledTimes(2); expect(r.structuredContent?.readStatus).toMatchObject({ partial: true });
  });
  it("reports a missing LP bookmark rather than treating it as complete", async () => {
    const r = await withReadStatus(async () => {
      expect(await getAllLpPages({ get: vi.fn().mockResolvedValue({ Items: [1], PagingInfo: { HasMoreItems: true } }) }, "/a")).toEqual([1]);
      return result();
    });
    expect(r.structuredContent?.readStatus).toMatchObject({ partial: true });
  });
  it("rejects malformed page envelopes and limits aggregate fan-out", async () => {
    await expect(getAllObjectListPages({ get: vi.fn().mockResolvedValue({ SomethingElse: [] }) }, "/a")).rejects.toThrow("Invalid paged response");
    const r = await withReadStatus(async () => { for (let i = 0; i < 200; i++) countRead(); expect(() => countRead()).toThrow(); return result(); });
    expect(r.structuredContent?.readStatus).toMatchObject({ partial: true, limits: [expect.stringContaining("200 reads")] });
  });
});
