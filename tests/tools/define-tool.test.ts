import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { defineTool } from "../../src/tools/define-tool.js";
import { toolResponse, errorResponse } from "../../src/tools/tool-helpers.js";
import { ApiError, RateLimitError, NetworkError } from "../../src/api/index.js";
import { captureTool, fakeApiClient, parse, text, makeConfig, enrollment, enrollmentsPage } from "./helpers.js";

const Schema = z.object({
  count: z.coerce.number().int().min(1).default(7),
  name: z.string().optional(),
});

describe("defineTool", () => {
  it("registers synchronously with the tool metadata and readOnlyHint by default", () => {
    const register = defineTool(
      { name: "demo", title: "Demo", description: "A demo tool", schema: Schema },
      async () => toolResponse({})
    );
    const registerTool = vi.fn();

    register({ registerTool } as any, fakeApiClient() as any, makeConfig());

    expect(registerTool).toHaveBeenCalledOnce();
    const [name, meta, handler] = registerTool.mock.calls[0];
    expect(name).toBe("demo");
    expect(meta).toEqual({
      title: "Demo",
      description: "A demo tool",
      inputSchema: Schema,
      annotations: { readOnlyHint: true },
    });
    expect(typeof handler).toBe("function");
  });

  it("lets a tool override the annotations", () => {
    const register = defineTool(
      {
        name: "writer",
        title: "W",
        description: "d",
        schema: Schema,
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async () => toolResponse({})
    );
    const registerTool = vi.fn();
    register({ registerTool } as any, fakeApiClient() as any, makeConfig());
    expect(registerTool.mock.calls[0][1].annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
  });

  it("parses raw args so defaults and coercion apply, and passes the context", async () => {
    const seen: unknown[] = [];
    const apiClient = fakeApiClient();
    const config = makeConfig();
    const register = defineTool(
      { name: "demo", title: "D", description: "d", schema: Schema },
      async (args, ctx) => {
        seen.push(args, ctx.apiClient === (apiClient as any), ctx.config === config);
        return toolResponse(args);
      }
    );
    const { call } = captureTool(register, apiClient, config);

    expect(parse(await call({}))).toEqual({ count: 7 });
    expect(parse(await call({ count: "3", name: "x" }))).toEqual({ count: 3, name: "x" });
    expect(seen[1]).toBe(true);
    expect(seen[2]).toBe(true);
  });

  it("turns invalid input into an 'Invalid input' error result", async () => {
    const register = defineTool(
      { name: "demo", title: "D", description: "d", schema: Schema },
      async () => toolResponse({})
    );
    const { call } = captureTool(register, fakeApiClient());

    const result = await call({ count: 0 });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Invalid input: count/);
  });

  it("maps thrown API errors through sanitizeError", async () => {
    const make = (error: Error) =>
      captureTool(
        defineTool({ name: "demo", title: "D", description: "d", schema: Schema }, async () => {
          throw error;
        }),
        fakeApiClient()
      ).call;

    expect(text(await make(new ApiError(404, "/x", "nope"))({}))).toMatch(/not found/i);
    expect(text(await make(new ApiError(403, "/x", "nope"))({}))).toMatch(/access denied/i);
    expect(text(await make(new ApiError(401, "/x", "nope"))({}))).toMatch(/pnpm run auth/);
    expect(text(await make(new RateLimitError("/x", 5))({}))).toMatch(/rate limited/i);
    expect(text(await make(new NetworkError("boom"))({}))).toMatch(/could not connect/i);
    expect(text(await make(new Error("???"))({}))).toMatch(/unexpected error/i);
  });

  it("passes a returned errorResponse through untouched", async () => {
    const register = defineTool(
      { name: "demo", title: "D", description: "d", schema: Schema },
      async () => errorResponse("bad path")
    );
    const { call } = captureTool(register, fakeApiClient());

    const result = await call({});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("bad path");
    expect(result.structuredContent).toMatchObject({ error: "bad path", readStatus: { partial: true } });
  });

  it("puts the full payload in structuredContent, wrapping arrays as items", async () => {
    const make = (data: unknown) => captureTool(defineTool(
      { name: "demo", title: "D", description: "d", schema: Schema }, async () => toolResponse(data)), fakeApiClient()).call;
    expect((await make({ a: 1 })({})).structuredContent).toMatchObject({ a: 1, readStatus: { partial: false } });
    const listed = await make([{ id: 1 }])({});
    expect(listed.structuredContent).toMatchObject({ items: [{ id: 1 }] });
    expect(parse(listed)).toEqual([{ id: 1 }]);
  });

  describe("course names", () => {
    const CourseSchema = z.object({ courseId: z.coerce.number().int().positive(), n: z.number().default(1) }).strict();
    const courses = enrollmentsPage([enrollment(11, "Reasoning and Logic"), enrollment(12, "Linear Algebra"), enrollment(13, "Linear Algebra Lab"),
      enrollment(14, "Old Reasoning", { isActive: false })]);
    const make = () => {
      const seen: unknown[] = [];
      const register = defineTool({ name: "demo", title: "D", description: "d", schema: CourseSchema }, async (args) => { seen.push(args); return toolResponse(args); });
      const registerTool = vi.fn();
      register({ registerTool } as any, fakeApiClient() as any, makeConfig());
      return { seen, meta: registerTool.mock.calls[0][1], ...captureTool(register, fakeApiClient({ "/enrollments/myenrollments/": courses })) };
    };

    it("publishes course alongside an optional courseId and keeps strict schemas strict", () => {
      const { meta } = make();
      expect(meta.inputSchema.safeParse({ course: "Reasoning" }).success).toBe(true);
      expect(meta.inputSchema.safeParse({ courseId: 1, extra: true }).success).toBe(false);
    });

    it("resolves a course name, code or ID string and passes courseId to the body", async () => {
      const { call } = make();
      expect(parse(await call({ course: "reasoning" }))).toEqual({ courseId: 11, n: 1 });
      expect(parse(await call({ course: "CODE-12" }))).toEqual({ courseId: 12, n: 1 });
      expect(parse(await call({ course: "Linear Algebra" }))).toEqual({ courseId: 12, n: 1 });
      expect(parse(await call({ course: "13" }))).toEqual({ courseId: 13, n: 1 });
      // Unmatched numbers fall back to an ID; numbers that appear in names are matched as text.
      expect(parse(await call({ course: "44" }))).toEqual({ courseId: 44, n: 1 });
      expect(text(await call({ course: "1" }))).toMatch(/matches 3 courses/);
      // Inactive courses are only searched when no active course matches.
      expect(parse(await call({ course: "old reasoning" }))).toEqual({ courseId: 14, n: 1 });
    });

    it("returns candidates for ambiguous names and requires a course", async () => {
      const { call } = make();
      const ambiguous = await call({ course: "algebra" });
      expect(ambiguous.isError).toBe(true);
      expect(text(ambiguous)).toMatch(/matches 2 courses: 12 .*13 /);
      expect(text(await call({ course: "chemistry" }))).toMatch(/No enrolled course matches/);
      expect(text(await call({}))).toMatch(/Provide courseId or course/);
    });
  });
});
