# LLMs.md

Guide for AI agents (Claude, Cursor, Windsurf, Copilot, Codex, etc.) helping a user install, use, or contribute to `brightspace-mcp-server`.

## Read the README first

Before anything else, read `README.md` for general context on what this project is, who it's for, and what a user can do with it. This file (LLMs.md) picks up from there with the concrete steps and codebase map you'll need to actually get things done.

## What this project is

An MCP (Model Context Protocol) server that connects an AI client to D2L Brightspace so it can read grades, assignments, announcements, syllabus, roster, discussions, and course content on demand.

It is run from a git clone — nothing is published to npm. Every user-facing action is a `package.json` script run with **pnpm** (`corepack enable` installs the pinned version). Always type `pnpm run setup` / `pnpm run update` with the explicit `run`: bare `pnpm setup` and `pnpm update` are pnpm built-ins that do something else.

## Installing it for a user

Follow these steps in order. Stop and report back if any step fails.

### 1. Verify Node.js 22+

```bash
node --version
```

If Node is missing or below v22, tell the user to install the LTS from https://nodejs.org/ and stop.

### 2. Clone and install

```bash
git clone <repo url> brightspace-mcp-server
cd brightspace-mcp-server
pnpm install
```

`pnpm install` also downloads Chromium for Playwright and compiles TypeScript into `build/` (via the `prepare` script). On Linux, install Chromium's system libraries once with `pnpm run playwright:deps`.

### 3. Run the setup wizard

```bash
pnpm run setup
```

School presets skip the URL prompt (pnpm forwards script arguments directly, no `--` separator):

```bash
pnpm run setup --purdue
pnpm run setup --tudelft
```

The wizard:
- prompts for the school's Brightspace URL (skipped with a preset)
- saves credentials to `~/.brightspace-mcp/config.json` (0600)
- optionally logs in right away with a Playwright Chromium browser (Duo push for Purdue; fully automatic for TU Delft) and writes the encrypted session to `~/.d2l-session/session.json` (AES-256-GCM)
- auto-configures Claude Desktop and Cursor if detected, registering `node <abs path>/build/index.js`

Wait for the user to finish login and MFA before continuing.

### 4. Register the MCP server in the user's AI client

Claude Desktop and Cursor are auto-configured by the wizard. For any other client (Windsurf, Copilot, Codex, Zed, Continue, etc.), register a stdio server with:

- command: the absolute path to `node`
- args: the absolute path to `build/index.js` inside the clone

The wizard prints this exact JSON at the end. Config formats and paths differ per client and change over time, so verify against current client docs rather than guessing.

For a client on another machine, run `pnpm run start:http` instead and point the client at `http://<host>:8787/mcp` with an `Authorization: Bearer <MCP_AUTH_TOKEN>` header (see README "Remote Access").

### 5. Restart the AI client

Tell the user to fully quit and reopen their AI client so it picks up the new MCP server.

## Re-auth

Sessions auto-reauthenticate on expiry. If auto-reauth fails (missed Duo push, expired cookies, stale locks), run in the clone:

```bash
pnpm run auth
```

## Available tools

Registered in `src/server.ts` via `src/tools/index.ts`, schemas in `src/tools/schemas.ts`:

| Tool | Purpose |
|------|---------|
| `get_my_courses` | List enrolled courses |
| `get_my_grades` | Grades for a course or all courses |
| `get_assignments` | Assignments with due dates and submission status |
| `get_upcoming_due_dates` | Due dates across all courses within a window |
| `get_announcements` | Recent course announcements |
| `get_syllabus` | Syllabus document for a course |
| `get_course_content` | Module tree and content topics |
| `get_discussions` | Discussion forums and recent posts |
| `get_roster` | Classlist for a course |
| `get_classlist_emails` | Emails of classmates and instructors |
| `download_file` | Download a file attachment (PDF, slides, etc.) — stdio only |

## Codebase map

```
src/
  index.ts                  stdio MCP entrypoint + subcommand routing (setup / auth / http)
  server.ts                 createMcpServer(): tool registration shared by both transports
  http-server.ts            Streamable HTTP entrypoint (read-only, bearer auth)
  http/server.ts            HTTP transport: sessions, auth, DNS-rebinding protection
  setup.ts                  Setup wizard (`pnpm run setup`)
  auth-cli.ts               Manual reauth (`pnpm run auth`)
  update.ts                 git-pull self-updater (`pnpm run update`)
  tools/
    index.ts                Tool registry
    schemas.ts              Zod input schemas for every tool
    tool-helpers.ts         Shared helpers (course resolution, formatting)
    get-*.ts                One file per tool
    download-file.ts        Binary download + file-type detection
  api/
    client.ts               HTTP client wrapping the Valence/D2L API
    version-discovery.ts    Resolves per-product API versions
    cache.ts                In-memory response cache
    rate-limiter.ts         Token-bucket limiter
    errors.ts               API error taxonomy
    types.ts                D2L response types
  auth/
    auth-runner.ts          Orchestrates reauth on 401/expiry
    browser-auth.ts         Playwright-driven login + token extraction
    sso-flow.ts             SSOFlow interface / BaseSSOFlow
    purdue-sso.ts           Purdue Shibboleth + Duo flow
    tudelft-sso.ts          TU Delft SURFconext / SimpleSAMLphp flow
    session-store.ts        AES-256-GCM session persistence
    token-manager.ts        Token refresh and validation
  utils/
    config-store.ts         ~/.brightspace-mcp/config.json reader/writer
    config.ts               Resolved config (store + env fallback)
    course-filter.ts        Filter enrolled vs archived courses
    download-helpers.ts     Stream-to-disk with validation
    file-validator.ts       Magic-byte file-type checks
    html-converter.ts       HTML to Markdown via turndown
    pdf-extractor.ts        PDF text extraction via unpdf
    logger.ts               Structured logging
    errors.ts               User-facing error taxonomy
  types/                    Shared TypeScript types
```

## Commands

| Command | What it does |
|---------|--------------|
| `pnpm install` | Install deps, download Chromium, build |
| `pnpm run setup` | Interactive setup wizard (`-- --purdue` / `-- --tudelft` for presets) |
| `pnpm run auth` | Manual reauth |
| `pnpm run start` | Run the stdio MCP server (what AI clients invoke via `node build/index.js`) |
| `pnpm run start:http` | Run the Streamable HTTP server |
| `pnpm run update` | `git pull` + install + build |
| `pnpm run build` | Compile TypeScript to `build/` |
| `pnpm run dev` | Watch-mode TypeScript compile |
| `pnpm run test` | Run Vitest suite |
| `pnpm run test:run` | Run Vitest once |
| `pnpm run playwright:deps` | Install Chromium system libraries (Linux) |

## Storage locations

| Path | Contents | Permissions |
|------|----------|-------------|
| `~/.brightspace-mcp/config.json` | School URL, credentials | 0600 |
| `~/.d2l-session/session.json` | Encrypted session cookies | 0600 |

`.env` fallback is supported for CI and dev, but the config store takes precedence.

## Adding a school

Add a preset to `SCHOOL_PRESETS` in `src/setup.ts`. If the school uses a non-standard login flow (SAML, Shibboleth, custom SSO), add an `SSOFlow` in `src/auth/` alongside `tudelft-sso.ts` and select it in `BrowserAuth`'s constructor.

## Adding a tool

1. Create `src/tools/<name>.ts` using an existing tool as a template (include `annotations: { readOnlyHint: true }` if it only reads).
2. Add the input schema to `src/tools/schemas.ts`.
3. Export it from `src/tools/index.ts`.
4. Register it in `createMcpServer()` in `src/server.ts`.
