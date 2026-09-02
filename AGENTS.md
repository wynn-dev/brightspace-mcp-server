# Project Rules

## When Adding a New Feature

1. Update `README.md` to document the feature
2. Update the architecture SVG at `docs/how-it-works.svg` if the feature changes how the system works

## Commit Format

`{type}: {description}` (e.g., `feat: add course search tool`)

No Co-Authored-By lines. No phase/plan numbers.

## Distribution

This project is not published to npm. Users clone the repo and run everything through `package.json` scripts (`npm run setup`, `npm run auth`, `npm run start`, `npm run start:http`, `npm run update`). `npm install` builds automatically via the `prepare` script. The setup wizard registers the server in MCP clients as `node <abs path>/build/index.js`.

## Architecture

- Config store: `~/.brightspace-mcp/config.json` (falls back to `.env`)
- Session tokens: `~/.d2l-session/session.json` (AES-256-GCM encrypted)
- Auth: Playwright-based browser login; institution flows in `src/auth/` (`PurdueSSOFlow` with Duo MFA, `TUDelftSSOFlow` with no MFA), selected by `baseUrl`
- Auto-reauth on token expiry via `AuthRunner`
- Transports: stdio (`build/index.js`) and Streamable HTTP (`build/http-server.js`, read-only, no `download_file`); both built by `createMcpServer()` in `src/server.ts`
- CLI subcommands: `setup`, `auth`, `http`, default (stdio MCP server)
- School presets: `--purdue`, `--tudelft` (extensible via `SCHOOL_PRESETS` in `src/setup.ts`)
