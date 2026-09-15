# Brightspace MCP Server

> Originally created by [Rohan Muppa](https://github.com/rohanmuppa) (ECE @ Purdue) as [RohanMuppa/brightspace-mcp-server](https://github.com/RohanMuppa/brightspace-mcp-server). This repository is an independently maintained continuation that adds TU Delft SSO, a Streamable HTTP transport, and a clone-based workflow.

An [MCP](https://modelcontextprotocol.io) server for D2L Brightspace. Connect it to Claude, ChatGPT, Cursor, Windsurf, or any MCP client and ask about your grades, due dates, assignments, announcements, course content, rosters, and discussions in plain language.

Works with any school on D2L Brightspace. Login is automated for Purdue (Duo MFA) and TU Delft (no MFA); other schools use the generic SSO flow or a manual browser login.

## Install

Requires [Node.js 22+](https://nodejs.org/), git, and [pnpm](https://pnpm.io/) (`corepack enable` installs the pinned version). The project runs from a clone; everything is a `pnpm run` script.

```bash
git clone https://github.com/wynn-dev/brightspace-mcp-server.git
cd brightspace-mcp-server
pnpm install          # installs dependencies, downloads Chromium, builds
pnpm run setup       # add --tudelft or --purdue to skip the URL prompt
```

Always use `pnpm run setup` and `pnpm run update` with the explicit `run` — bare `pnpm setup` and `pnpm update` are pnpm's own built-in commands.

The wizard stores your credentials in `~/.brightspace-mcp/config.json`, logs in once, and registers the server in Claude Desktop and Cursor if they're installed. Restart your AI client afterwards.

<details>
<summary>Other clients</summary>

Register a stdio MCP server whose command is your `node` binary and whose only argument is the absolute path to `build/index.js` in this clone. The wizard prints the exact JSON at the end:

```json
{ "command": "/usr/local/bin/node", "args": ["/home/you/brightspace-mcp-server/build/index.js"] }
```

</details>

<details>
<summary>Let an AI assistant install it</summary>

Paste into Claude Code, Cursor, Windsurf, Copilot, or Codex:

```
Install brightspace-mcp-server for me by following LLMs.md in this repo
(use --tudelft if I'm at TU Delft, --purdue if I'm at Purdue).
```

</details>

## Remote access

To reach Brightspace from an MCP client on another machine, serve MCP over Streamable HTTP instead of stdio:

```bash
MCP_AUTH_TOKEN="$(openssl rand -hex 32)" MCP_HTTP_HOST=0.0.0.0 pnpm run start:http
```

Or put those settings in `.env` / `.env.local` (see `.env.example`) and just run `pnpm run start:http`.

This exposes the 20 read-only tools at `http://<host>:8787/mcp`, including `read_course_content`. `download_file` is left out, and `get_syllabus` rejects `downloadPath` over HTTP, so course files cannot be saved to the server's disk through these tools. Clients send `Authorization: Bearer <MCP_AUTH_TOKEN>`:

```bash
claude mcp add --transport http brightspace http://your-host:8787/mcp --header "Authorization: Bearer <token>"
```

| Variable | Default | Notes |
|---|---|---|
| `MCP_HTTP_HOST` | `127.0.0.1` | Any non-loopback address **requires** `MCP_AUTH_TOKEN`. |
| `MCP_HTTP_PORT` | `8787` | |
| `MCP_AUTH_TOKEN` | — | Static bearer token; the server holds your whole Brightspace session. |
| `MCP_ALLOWED_HOSTS` | loopback names | `host:port` values accepted in the `Host` header (DNS-rebinding protection), e.g. `myserver.lan:8787`. |
| `MCP_ALLOWED_ORIGINS` | — | Browser origins to accept, if any. |

On a headless host, set `"headless": true` in `~/.brightspace-mcp/config.json` so re-login runs without a display (unattended re-login needs a school without an MFA prompt), install Chromium's system libraries on Linux with `pnpm run playwright:deps`, and keep the port behind a VPN or TLS-terminating proxy — the server itself speaks plain HTTP.

## Checking tool discovery

Run `pnpm run diagnose` for the local stdio server, or `pnpm run diagnose --http https://your-host/mcp` for HTTP. The HTTP diagnostic reads `MCP_AUTH_TOKEN` from the environment/configured env files; do not put tokens in command arguments. Omitting the URL uses the first `MCP_ALLOWED_HOSTS` entry over HTTPS, or the local port if no host is configured. The diagnostic initializes MCP and reads `tools/list` without calling Brightspace tools. It reports the running version, expected/advertised tools, and missing names; differences produce a nonzero exit code.

Expect **21 tools over stdio and 20 over HTTP**. If tools are missing or the running version differs, run `pnpm run update` (or `pnpm run build` for local changes), then restart the server process. If discovery already contains all tools but your client shows fewer, refresh/reconnect the MCP connection or restart that client. Updating files does not replace an already running process, and clients may retain the old tool list. `check_auth` also includes the running version and tool inventory in its structured response.

## Reading course materials

The `read_course_content` tool reads uploaded **PDF, HTML, and plain-text files** over both HTTP and stdio. Files are fetched with your Brightspace session and processed in memory. It returns extracted text, not the original file, and does not update coursework or completion status.

1. Call `get_course_content` with a `courseId` (and optionally `moduleTitle` or `typeFilter: "file"`) to find a file's `topicId`. Topic descriptions in the tree are separate from uploaded file bodies; HTML pages can also appear as file topics.
2. Call `read_course_content` with those IDs. For example, to read physical PDF pages 2–4:

   ```json
   { "courseId": 12345, "topicId": 67890, "startPage": 2, "endPage": 4 }
   ```

3. If the response contains a non-null `nextCursor`, call again with the same IDs and that cursor, omitting `startPage` and `endPage`. Continue until `nextCursor` is null. The cursor preserves the selected range and rejects continuation if the file changes.

Responses include the document title, filename, content type, and a Brightspace `sourceUrl`. PDF `pages` entries contain physical **1-based** page numbers, text, and offsets within each page; these page numbers may differ from printed labels. HTML returns Markdown and plain-text files return decoded text, both with a text offset. Offsets and text budgets count JavaScript UTF-16 code units; continuation preserves Unicode characters. PDF pages can span multiple responses, and an empty page is reported explicitly.

Each response defaults to **20,000 text characters** (`maxChars`, configurable from 2 to 50,000) and at most **20 PDF pages**, including blank pages. Files have a **50 MiB** streaming limit. Page selection is PDF-only. UTF-8, Unicode BOMs, and supported encodings declared in `Content-Type` are recognized for text files. Continuation re-fetches the document; no document cache or downloaded file is persisted.

Scanned pages need OCR, which is not included. Images, diagrams, and equations may not be represented faithfully by PDF text extraction. Password-protected PDFs, Office documents, external links, videos, and learning-tool activities are unsupported. Access remains subject to your Brightspace account's permissions. Stdio clients can still save originals using `download_file` or `get_syllabus.downloadPath`.

## Student workflows

These tools work over both transports and only read Brightspace data. They do not submit coursework, change grades, join groups, check checklist items, or mark discussions as read.

| Tool | What it reads |
|---|---|
| `get_my_work` | Assignments, quizzes, scheduled content and calendar deadlines, including overdue or undated work. Useful for a weekly briefing. Completion, exemptions and unavailable sources stay explicit. |
| `get_submission_history` | All available individual/group submissions for a `folderId`, newest first, plus released feedback, rubric assessments and attachment/link references. |
| `get_course_updates` | Batch update counts, user feed and news created or edited since `since`; includes pinned announcements. This is an on-demand view, not a complete change log. |
| `get_grade_summary` | Visible grades, grading setup, categories, item rules and official final grade; optional in-memory what-if `scenarios`. |
| `search_course` | Case-insensitive keyword matches in announcement bodies, assignment instructions, module/topic titles and descriptions, discussions and course descriptions. Opt into `sources: ["documents"]` for bounded PDF/HTML/text body search with PDF page references. |
| `get_my_groups` | Your course groups, sections, group descriptions, enrollment windows and linked group assignments. |
| `get_calendar` | Reminders, due dates, opening/closing events, locations and recurring occurrences, with UTC and IANA time-zone display. |
| `get_checklists` | Checklists, categories, item descriptions and due dates. Personal completion is **unknown** because the API does not provide it. |

Existing tools also have more focused options:

- `get_my_courses`: `query` searches names/codes; `includeDetails`, `semester` and `onDate` read course dates and semester metadata; `sort: "recent"` orders by last access. An active enrollment is not proof of the current semester. If course details are denied, dates can fall back to enrollment access metadata and semester filters can use an explicitly typed semester/term ancestor. Each field identifies its source; names/codes alone are not used to infer a term. Courses with unavailable filter metadata are retained with a null match flag.
- `get_assignments`: `folderId` selects one assignment (requires `courseId`); submission history comes from Brightspace's entity/group response. Quiz attempts are restricted to the authenticated user and only published scores are returned. Own-user special-access routes are checked for personal dates and quiz settings; explicit null dates remove restrictions. Denied, missing or malformed responses leave personal dates unverified. `attemptsRemaining` stays null because a reliable remaining-attempt count requires more than an override. `attemptsRemainingAssumingDefault` is explicitly conditional.
- `get_syllabus` and `get_roster`: if their primary source is unavailable, `includeContentFallback` (default true) finds up to three accessible course-guide or staff/contact documents. Excerpts are separate candidates with source links and PDF page references; they do not establish an official syllabus or staff membership. Set the option to false to skip those reads.
- `get_upcoming_due_dates`: `includeReminders: true` adds separately labelled reminders to the familiar calendar workflow. The response guides broader coursework questions to `get_my_work` and recurring events/availability to `get_calendar`.
- `get_discussions`: supply `forumId` and `topicId`, then optionally `threadId`, `unreadOnly`, `ownOnly` (posts authored by you), `since`, `threadsOnly`, `sort`, `pageNumber` and `pageSize`. Forum-only calls list topics; request a topic to read posts. Forum/topic lists also use `pageNumber` and `pageSize`; follow `nextPage`, or select a forum and follow its `nextTopicPage`.
- `get_roster`: institution-provided role names replace Purdue-only role IDs. Default staff selection uses a name heuristic and exposes available/unrecognized roles. Use `roleNames` for exact institution labels or `includeStudents` for everyone. Denied classlist access is reported as unavailable.
- `get_upcoming_due_dates`: returns events explicitly classified as calendar due dates. Use `get_my_work` for deadlines that are absent from the calendar, and `get_calendar` for reminders and availability windows.
- `get_course_content`: completion uses the stable scheduled-content API; unlisted or optional items have null completion, rather than being reported as unread/incomplete. Reading file text does not update completion.

### Examples

A work overview for the next two weeks and the preceding week's overdue items:

```json
{ "courseId": 12345, "daysAhead": 14, "daysBehind": 7, "includeUndated": true }
```

Pass that to `get_my_work`. Submitted assignments and completed quiz attempts are omitted by default, though they may still allow further submissions; use `includeCompleted: true` to include them. Closing dates are separate from due dates. Assignment and quiz dates use verified own-user special access when permitted; an active own-user quiz attempt can supply its current attempt deadline. Otherwise dates remain labelled course defaults, with `overdue` and `closed` unknown and `overdueAssumingCourseDefaults` explicitly conditional. Each work item identifies its date scope. If unverified default dates exclude work from the requested window, `unverifiedDatesOutsideWindow` and a read-status limit warn that extensions could move it into the window; inspect `get_assignments` without a date window. Calendar context is capped at the requested limit; use `get_calendar` to continue. Sources can describe the same activity, so source identities are preserved instead of guessing which entries to merge.

A calendar view with recurring occurrences and local display, passed to `get_calendar`:

```json
{ "courseId": 12345, "start": "2026-09-01T00:00:00Z", "end": "2026-10-01T00:00:00Z", "timeZone": "Europe/Amsterdam" }
```

The window is start-inclusive/end-exclusive and limited to 366 days. All-day `endDayExclusive` values are preserved as dates, without interpreting them as midnight UTC. If the recurrence route is unavailable, the tool tries ordinary events and reports that occurrences were not expanded. Event types require LE 1.94 or newer; older responses may have an unknown type.

A hypothetical score, passed to `get_grade_summary`:

```json
{ "courseId": 12345, "scenarios": [{ "gradeItemId": 67890, "points": 8 }] }
```

Calculations currently support uncategorized numeric **Points** and **Weighted** gradebooks with verified item rules and personal exemption data. Verified ungraded items follow the returned course rule; missing does not automatically mean zero. If an unavailable score could instead be unreleased, the calculation requires an explicit scenario score. Formula grades, categories/drop rules, bonus/extra-credit rules, uncertain exemptions, invalid weights and incomplete sources return `calculation.status: "unsupported"` with reasons. The grade explanation still works when calculations are unavailable. Projections concern the grade objects returned to your account; they cannot infer hidden/unreleased items and are separate from `officialFinal`. No GPA or institution-wide degree rules are inferred.

### Pagination and reliability

Most new list tools accept `offset` (default 0) and `limit` (default 25, maximum 100), returning `items`, `nextOffset` and `matchedCount`. `get_assignments` keeps its `assignments` array and paginates per course. `get_roster` now returns a paginated object instead of a bare array. Follow continuation using the same filters. Offsets describe the current fetched results, not a durable snapshot; data can change between calls.

Discussion filters apply to the requested API page by default. Set `maxPagesToScan` (1–10, default 1) to continue automatically past sparse pages until a page-size worth of matches is found, the scan limit is reached, or the source ends. All matches on the final scanned page are retained, so the response can exceed `pageSize`. Inspect `pagesScanned`, `nextPage` and `exhausted`; an empty result is not proof of exhaustion. A full final API page can require one extra call to establish the end. Search scans up to 10 forums, 10 topics per forum and the first 100 posts per topic per course; use focused discussion pagination to continue. Document bodies are searched only when `sources` includes `"documents"`. This reads up to `maxDocuments` files (default 3, maximum 10) and `maxDocumentChars` characters per file (default 20,000, maximum 50,000), with a 20-page PDF cap. Use `documentTopicIds` to focus the scan and `nextDocumentOffset` as the next `documentOffset` to scan more files. Normal `offset`/`nextOffset` paginate matches within that same scan; exhaust those matches before advancing the document offset. Truncated excerpts and inaccessible/unsupported files remain explicit in `coverage` and `readStatus`; use `read_course_content` to read the rest of a document. An empty search result does not establish absence from unscanned text. No index is stored.

Data tools append `readStatus` in an additional text block and in `structuredContent`, preserving the main payload in the first text block. It reports source routes, availability (`available`, `forbidden`, `not_found`, `error`), fetch timestamps, cache use, limits and a `partial` flag. Inspect it before treating empty results as “nothing to do.” A 404 can mean an absent feature or inaccessible item, not necessarily an empty dataset. Partial page chains keep previously fetched items, including when a later response is malformed. Grade projections stop when required sources are incomplete or contain duplicate grade values or exemptions. A quiz with an ongoing attempt remains in the work overview even after an earlier completed attempt.

Concurrent expired-session reads share token invalidation and automatic login, then retry once. On Linux hosts without a display, automatic login with stored credentials uses a headless browser even if the saved desktop configuration requests a visible one. Manual login still requires a display. `get_syllabus` also preserves plain-text overviews and recognizes PDF attachments without a `.pdf` filename; an inaccessible attachment has unknown presence (`hasAttachment: null`).

New service reads use a 60-second in-memory cache and normally cap each source at 500 items/10 API pages; individual tools have additional limits recorded in `readStatus.limits`. The work overview inspects at most 100 assignments/quizzes per course; use assignment pagination for the rest. Aggregate calls stop after 200 API reads; narrow course/source filters if the response is partial. See [the coursework coverage review](docs/coursework-coverage-review.md) for addressed limitations and [API contract notes](docs/read-only-api-notes.md) for endpoint details and validation boundaries. No persistent document index, snapshots or alert jobs are created. Awards, competency maps, external systems and outbound alerts remain outside this scope.

## Commands

| Command | What it does |
|---|---|
| `pnpm run setup` | Setup wizard (`-- --purdue`, `-- --tudelft`) |
| `pnpm run auth` | Log in again if automatic re-auth fails |
| `pnpm run start` | Stdio MCP server (what your AI client runs) |
| `pnpm run start:http` | Streamable HTTP MCP server |
| `pnpm run diagnose` | Check MCP version and tool discovery; add `--http [url]` for an HTTP server |
| `pnpm run update` | Pull the latest code, reinstall, rebuild |
| `pnpm run build` / `pnpm run dev` | Compile once / watch |
| `pnpm test` | Run the test suite |
| `pnpm run playwright:deps` | Install Chromium system libraries (Linux) |

When a Brightspace request finds an expired session, it re-authenticates automatically and retries. Concurrent requests wait for the same login attempt. This uses the configured school login flow and stored credentials; required MFA or manual browser steps still need interaction. Run `pnpm run auth` only if automatic login fails. Authentication may refresh local session files; the read-only tools do not modify coursework or save course documents over HTTP.

## Configuration

Set in `~/.brightspace-mcp/config.json` (written by the wizard), or as environment variables — either in your shell or in a `.env` / `.env.local` file in the project root (copy `.env.example`). Precedence is shell > `.env.local` > `.env` > `config.json`.

| Variable | Default | Purpose |
|---|---|---|
| `D2L_BASE_URL` | — | Your Brightspace URL; also selects the login flow |
| `D2L_USERNAME` / `D2L_PASSWORD` | — | Credentials for automated login; omit for a manual browser login |
| `D2L_HEADLESS` | `false` | Hide the browser during login |
| `D2L_SESSION_DIR` | `~/.d2l-session` | Where the encrypted token and cookies live |
| `D2L_TOKEN_TTL` | `3600` | Seconds before a saved session is considered stale |
| `D2L_INCLUDE_COURSES` / `D2L_EXCLUDE_COURSES` | — | Comma-separated course IDs to filter |
| `D2L_ACTIVE_ONLY` | `true` | Hide inactive courses |
| `D2L_LOG_LEVEL` | `INFO` | Log verbosity on stderr: `DEBUG`, `INFO`, `WARN`, `ERROR` |

## Security

- Credentials stay on your machine in `~/.brightspace-mcp/config.json` (mode 0600)
- Session tokens are encrypted at rest (AES-256-GCM)
- All traffic to Brightspace is HTTPS; nothing is sent anywhere except your school's login page
- The HTTP server refuses to bind a non-loopback address without a bearer token

## Contributing

### Paseo workspaces

The repo includes [`paseo.json`](paseo.json) for [Paseo worktrees](https://paseo.sh/docs/worktrees). Install Node.js 22+ and enable pnpm with `corepack enable` on the Paseo host first. New worktrees first copy `.env` and `.env.local` from `PASEO_SOURCE_CHECKOUT_PATH` when present, preserving any existing worktree files. Setup then runs `pnpm install --frozen-lockfile`, which downloads Chromium and builds the server through the existing install hooks.

Paseo also offers `build`, `test` (a single test run), and `dev` (TypeScript watch) scripts. For example, run `paseo script start test` from the workspace directory.

Brightspace login remains a manual step: run `pnpm run setup` when needed. Worktrees on the same host share the home-directory config and session stores. Linux hosts that need Chromium system libraries can run `pnpm run playwright:deps` once.

Paseo reads this config from the committed base branch, so commit it to the branch used to create new worktrees before expecting automatic setup.

**Add your school:** add a preset to `SCHOOL_PRESETS` in `src/setup.ts`. If its login flow differs, add an `SSOFlow` in `src/auth/` (see `tudelft-sso.ts`) and select it in `BrowserAuth`.

**Add a tool:** create a file in `src/tools/`, add its schema to `schemas.ts`, export it from `src/tools/index.ts`, and register it in `createMcpServer()` in `src/server.ts`. Mark read-only tools with `annotations: { readOnlyHint: true }`.

`LLMs.md` has a codebase map for contributors and AI assistants.

## License

MIT License · Copyright 2026 Rohan Muppa and contributors · [Report a bug](https://github.com/wynn-dev/brightspace-mcp-server/issues)
