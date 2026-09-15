# Pre-merge review and validation

Review date: 2026-09-15. Scope: PR #13, including the document reader, ten student-workflow areas, HTTP read-only enforcement and authentication reliability.

## Findings fixed

- Concurrent JSON/file requests receiving 401 could clear a newly refreshed session. Token invalidation and login now share one recovery operation; retries are bounded. Tests reproduce the race and exercise rejection of the refreshed token.
- A desktop configuration requesting a visible browser prevented automatic login on this Linux host without a display. Stored-credential login now selects headless mode in that environment. WSL/container detection also uses ESM-compatible filesystem imports.
- An earlier completed quiz attempt hid a newer active attempt from the work overview. Active attempts now take precedence.
- Malformed later pagination envelopes or continuation URLs discarded earlier data. Successful pages are retained with incomplete-result metadata.
- Duplicate published grade values or exemption records could produce an ambiguous projection. Calculations refuse these inputs and directly check source completeness.
- Calendar occurrences could inherit another occurrence's all-day dates. Dates now come from the occurrence itself; failed/truncated expansion is not reported as complete.
- Syllabus reading dropped plain-text descriptions, missed PDFs without an extension, and represented denied attachments as absent. These cases now preserve text, recognize PDFs and report unknown attachment presence.
- PDF extraction used by syllabus reads did not suppress PDF.js diagnostics or explicitly destroy its document. Both extraction paths now do so. Oversized attachment/download responses are cancelled.
- Cache expiration timers kept otherwise idle processes alive. They no longer retain the event loop. The stdio startup message now reports 21 tools.
- HTTPS enforcement accepted uppercase `HTTP://`. URL parsing now validates the protocol, including mixed-case and non-HTTP schemes.

## Automated validation

`pnpm run test:run` includes API, authentication, tool, document and transport tests. The subprocess end-to-end suite first runs `pnpm run build`, then launches both compiled production entrypoints through SDK clients. It uses a temporary encrypted synthetic session and substitutes only the remote fetch boundary. No live account data is stored in fixtures.

Both transport runs exercise every registered tool: 21 for stdio and 20 for HTTP. Assertions cover nonempty assignments, ongoing quizzes, older submissions and published rubric feedback, grade scenarios, recurring and all-day calendar events, updates, own groups, paged checklists, roster, discussions, search and course content. Actual generated PDFs, HTML and plain text pass through the real API client and extractors; PDF continuation preserves page references. HTTP rejects both saving routes before any Brightspace request. Stdio saves are confined to temporary test directories. All fixture Brightspace requests must be GETs, with the expected synthetic bearer token.

## Live validation and limits

All 20 HTTP tools were exercised through an SDK client against the configured TU Delft account, with automatic authentication available. The run made 96 GET requests to Brightspace and discovered seven active enrollments. Course content, assignments, announcements, the work overview, updates and search returned nonempty data. Real PDF and HTML extraction succeeded, including PDF continuation. Earlier checks on the same branch also exercised nonempty submission history and five visible grade items.

The account denies classlist and some course/grade metadata. These responses remain explicit errors or partial results. Missing final-grade, exemption or section endpoints are not treated as proof of empty data; unverifiable grade projections are refused. The content-tree check deliberately used a depth limit and reported it. Sampled quizzes, checklists, discussions, group memberships and recurring events did not provide nonempty live examples; their mappings are validated with synthetic fixtures. Simultaneous 401s and failed login are tested deterministically rather than by invalidating the user's session. Purdue's interactive MFA flow was not live-tested.

A separate production stdio check started with an empty temporary session directory. `check_auth` automatically launched the real TU Delft browser login, persisted a valid session, and successfully read seven courses. This reproduced the missing-display failure before the headless fallback and passed afterward without manual authentication. The temporary session was removed; the user's normal saved session was preserved.

## Earlier main changes

Local `main` and `origin/main` were both at `5c8536c` before this PR. The preceding cleanup PRs were already merged, and the Paseo setup commit was already present on `origin/main`; there was no unpublished main work needing another PR.

The base commit was checked in an isolated worktree. `pnpm install --frozen-lockfile` completed its Chromium and TypeScript hooks without modifying tracked files; all 152 baseline tests passed across 24 files. The environment-copy script passed checks for absent source configuration, missing source files, copying existing files, preserving destination overrides and repeated setup. No corrective change to that earlier work was needed.
