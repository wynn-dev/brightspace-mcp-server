# Brightspace MCP Server

An [MCP](https://modelcontextprotocol.io) server for D2L Brightspace. Connect it to Claude, ChatGPT, Cursor, Windsurf, or any MCP client and ask about your grades, due dates, assignments, announcements, course content, rosters, and discussions in plain language.

Works with any school on D2L Brightspace. Login is automated for Purdue (Duo MFA) and TU Delft (no MFA); other schools use the generic SSO flow or a manual browser login.

<p align="center">
  <img src="docs/how-it-works.svg" alt="Architecture diagram" width="100%">
</p>

## Install

Requires [Node.js 18+](https://nodejs.org/) and git. The project runs from a clone; everything is an `npm run` script.

```bash
git clone https://github.com/wynn-dev/brightspace-mcp-server.git
cd brightspace-mcp-server
npm install          # installs dependencies, downloads Chromium, builds
npm run setup        # add -- --tudelft or -- --purdue to skip the URL prompt
```

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
MCP_AUTH_TOKEN="$(openssl rand -hex 32)" MCP_HTTP_HOST=0.0.0.0 npm run start:http
```

Or put those settings in `.env` / `.env.local` (see `.env.example`) and just run `npm run start:http`.

This exposes the 11 read-only tools at `http://<host>:8787/mcp` (`download_file` is left out because it would write to the server's disk). Clients send `Authorization: Bearer <MCP_AUTH_TOKEN>`:

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

On a headless host, set `"headless": true` in `~/.brightspace-mcp/config.json` so re-login runs without a display (unattended re-login needs a school without an MFA prompt), install Chromium's system libraries on Linux with `npm run playwright:deps`, and keep the port behind a VPN or TLS-terminating proxy — the server itself speaks plain HTTP.

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Setup wizard (`-- --purdue`, `-- --tudelft`) |
| `npm run auth` | Log in again if automatic re-auth fails |
| `npm run start` | Stdio MCP server (what your AI client runs) |
| `npm run start:http` | Streamable HTTP MCP server |
| `npm run update` | Pull the latest code, reinstall, rebuild |
| `npm run build` / `npm run dev` | Compile once / watch |
| `npm test` | Run the test suite |
| `npm run playwright:deps` | Install Chromium system libraries (Linux) |

Sessions re-authenticate automatically. If that fails (missed Duo push, expired cookies), run `npm run auth`.

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

## Security

- Credentials stay on your machine in `~/.brightspace-mcp/config.json` (mode 0600)
- Session tokens are encrypted at rest (AES-256-GCM)
- All traffic to Brightspace is HTTPS; nothing is sent anywhere except your school's login page
- The HTTP server refuses to bind a non-loopback address without a bearer token

## Contributing

**Add your school:** add a preset to `SCHOOL_PRESETS` in `src/setup.ts`. If its login flow differs, add an `SSOFlow` in `src/auth/` (see `tudelft-sso.ts`) and select it in `BrowserAuth`.

**Add a tool:** create a file in `src/tools/`, add its schema to `schemas.ts`, export it from `src/tools/index.ts`, and register it in `createMcpServer()` in `src/server.ts`. Mark read-only tools with `annotations: { readOnlyHint: true }`.

`LLMs.md` has a codebase map for contributors and AI assistants.

## Credits & License

Originally created by [Rohan Muppa](https://github.com/rohanmuppa) (ECE @ Purdue) as [RohanMuppa/brightspace-mcp-server](https://github.com/RohanMuppa/brightspace-mcp-server). This repository is an independently maintained continuation that adds TU Delft SSO, a Streamable HTTP transport, and a clone-based workflow.

MIT License · Copyright 2026 Rohan Muppa and contributors · [Report a bug](https://github.com/wynn-dev/brightspace-mcp-server/issues)
