import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { defineTool } from "../../src/tools/define-tool.js";
import { toolResponse, errorResponse } from "../../src/tools/tool-helpers.js";
import { ApiError, RateLimitError, NetworkError } from "../../src/api/index.js";
import { captureTool, fakeApiClient, parse, text, makeConfig } from "./helpers.js";

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
  });
});
