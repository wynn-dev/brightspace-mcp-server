# Project Rules

## When Adding a New Feature

1. Update `README.md` to document the feature

## Commit Format

`{type}: {description}` (e.g., `feat: add course search tool`)

No Co-Authored-By lines. No phase/plan numbers.

## Distribution

This project is not published to npm. The package manager is pnpm (pinned via `packageManager`; `corepack enable`). Users clone the repo and run everything through `package.json` scripts — always with the explicit `run` for `setup`/`update`, since `pnpm setup`/`pnpm update` are pnpm built-ins (`pnpm run setup`, `pnpm run auth`, `pnpm run start`, `pnpm run start:http`, `pnpm run update`). `pnpm install` builds automatically via the `prepare` script. The setup wizard registers the server in MCP clients as `node <abs path>/build/index.js`.

## Architecture

- Config store: `~/.brightspace-mcp/config.json` (falls back to `.env`)
- Session tokens: `~/.d2l-session/session.json` (AES-256-GCM encrypted)
- Auth: Playwright-based browser login; institution flows in `src/auth/` (`PurdueSSOFlow` with Duo MFA, `TUDelftSSOFlow` with no MFA), selected by `baseUrl`
- Auto-reauth on token expiry via `AuthRunner`
- Transports: stdio (`build/index.js`) and Streamable HTTP (`build/http-server.js`, read-only, no `download_file`); both built by `createMcpServer()` in `src/server.ts`
- CLI subcommands: `setup`, `auth`, `http`, default (stdio MCP server)
- School presets: `--purdue`, `--tudelft` (extensible via `SCHOOL_PRESETS` in `src/setup.ts`)
