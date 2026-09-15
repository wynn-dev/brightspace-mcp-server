// Subprocess fixture: replace only the remote network boundary. Production
// entrypoints, token decryption, API client, parsers and transports stay real.
import { readFileSync, appendFileSync } from "node:fs";
const fixture = JSON.parse(readFileSync(process.env.BRIGHTSPACE_E2E_FIXTURE, "utf8"));
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? input);
  const method = init.method ?? "GET";
  if (url.origin !== "https://brightspace-fixture.invalid" || method !== "GET") {
    throw new Error("E2E fixture blocked an unexpected destination or LMS mutation");
  }
  appendFileSync(process.env.BRIGHTSPACE_E2E_REQUESTS, JSON.stringify({ method, path: url.pathname, query: url.search }) + "\n");
  if (url.pathname !== "/d2l/api/versions/" && new Headers(init.headers).get("authorization") !== "Bearer synthetic-e2e-token") {
    throw new Error("E2E fixture received an unexpected credential");
  }
  const route = fixture[url.pathname + url.search] ?? fixture[url.pathname];
  if (!route) return Response.json({ error: "No fixture for this route" }, { status: 404 });
  if (route.binary) return new Response(Buffer.from(route.binary, "base64"), { headers: route.headers });
  return Response.json(route.body, { status: route.status ?? 200 });
};
