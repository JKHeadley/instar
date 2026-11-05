---
title: "Native console pages and a read-only file browser for the Instar iPhone app"
slug: "mobile-native-console-pages"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "mobile-native-console-pages.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under Justin's request (Telegram topic 134088, 2026-11-03 22:01 PST: the app should do every feature natively; 2026-11-04 23:39 PST: continue another 24 hours). The plan of record is .instar/lanes/app-native-coverage-plan.md."
review-convergence: "2026-11-05T08:04:18.237Z"
review-iterations: 5
review-completed-at: "2026-11-05T08:04:18.237Z"
review-report: "docs/specs/reports/mobile-native-console-pages-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

## 1. Problem

Justin asked for every feature to be native in the iPhone app. Five rows of the plan remain web pages: Ideas, Pace, Development, the Maturation board and Files. A paired phone signs each request with its device key, and `deviceAuthenticator` admits only paths in `DEVICE_ALLOWLIST`, so none of the console's routes are open to it.

## 2. What exists

- `GET /ecosystem-ideas`, `GET /queue-pace?scope=pool`, `GET /maturation/board?scope=pool`, `GET /green-pr-automerge`, `GET /local-verify`, `GET /feedback-factory/triage/summary`: bearer routes that answer 503 or 404 when off, with their own peer fan-out, deadlines, rate limits and caches.
- `GET /api/files/list` and `GET /api/files/read`: the file viewer, with never-served paths, blocked filenames, allowed folders and symlink checks in `validatePath`.
- The mobile read pattern from PRs #2706 to #2767: purpose-built trimmed routes, `ownerOrBearer`, `rowKey`, `singleFlight` (15 s), `freeText`.

## 3. Design

New module `src/server/mobileConsolePagesRoutes.ts`, mounted in `createRoutes`.

| Route | Reads | Answers |
|---|---|---|
| `GET /mobile/ideas` | `/ecosystem-ideas` | headline, funnel counts, ideas by band (claim, project, reason, risk words, cost), watched projects, a count of suggestions |
| `GET /mobile/pace` | `/queue-pace?scope=pool` | headline and one plain line per busy queue, machine name, who did not answer |
| `GET /mobile/development` | `/green-pr-automerge`, `/local-verify`, `/feedback-factory/triage/summary` | headline, shipping counts, failing pull requests, feedback counts |
| `GET /mobile/maturation` | `/maturation/board?scope=pool` | headline, plain groups, rows (name, area, line, purpose, next step) |
| `GET /mobile/files?path=` | `/api/files/list` | one folder: name, kind, size, modified |
| `GET /mobile/files/read?path=` | `/api/files/read` | one text file, cut and scrubbed |

**The read is a loopback GET to this server with its own token**, the same way the existing `/jobs?scope=pool` and topic-history reads work. That is the central design choice: the phone's answer is built from the console's own answer, so a feature that is off stays off, and every file rule stays the viewer's own rather than a copy that can drift. Each loopback read has a 12 s deadline and reads a local answer the console already bounds (a file is at most the viewer's 1 MB). A read that throws is reported and becomes status 0, which every page shows as "can't read this". The routes are read-only; a write never reaches them.

Headlines and group counts are taken over every row before any cap, and rows are ordered so what needs attention comes first (caps of 40 queues and 300 features, above today's 8 and 255). If attention rows ever exceed a cap, the totals still count them; each capped list carries a flag and the screen says so. Paging waits for a real need. A queue with no measured rate is listed and never called healthy. Maturation names machines whose sources failed. Every field derived from a failed Development source is null. Development's tone speaks for shipping only: attention when something is held or failing, unknown when shipping could not be fully read; feedback has its own section.

The four summary pages use `singleFlight` for 15 s (the file routes read each time), so repeated opens cost one read and the pool routes' own rate limits are not reached by a refresh. Each answer is built field by field; setting ids, evidence, decisions, owner facts, commit ids, check names, machine ids and error text are never copied.

Development leaves out two console reads on purpose: `/throughput/series` took 13.5 s and answered 503 here, and `/release-readiness` took 4.6 s. A part that cannot be read shows as unknown, never zero.

### 3.1 Files

One step past the console for the phone only: a name that says it holds a secret is left out of a folder and refused without a read, because the console lists `.instar/keys`, `codex-auth-backup-*` and `credential-locations.json`. Names are folded first (case, compatibility forms, accents, invisible marks), split at camelCase, and matched both inside words (`apikey`, `authToken`, `.netrc`, `id_ecdsa`) and as delimited words (`auth`, `key`). `keyboard`, `tokenizer` and `author` stay visible.

Each path is judged where it really points. The route resolves it, refuses a target that is missing, outside the project or hidden, drops such links from a folder, and hands the viewer the resolved path, so what is read is what was judged. A hard link can't be told from its target and is judged by its own name.

A file is read 2,048 characters past each limit, scrubbed, then cut to 65,536 string characters and 2,000 a line, so a secret crossing a cut is scrubbed whole unless it is longer than the margin. File scrubbing adds key shapes `scrubSecrets` lacks (`sk-ant-`, `sk-proj-`, `github_pat_`, `AIza`), bearer values, labelled values including quoted and `/+` values, whole private key blocks and a value on the line after its label. It runs per line and gives the server a turn every four lines. `editable` is never sent.

### 3.2 Cost

Learned from `/mobile/inside`, which froze the server for 11 s: a scrub pattern is quadratic on long text, so text is cut before it is scrubbed, and a page does no work per key. Measured on the Studio with live data, trimming took 1.1 ms (ideas), 0.6 ms (pace), 6.3 ms (maturation, 255 features), 1.9 ms (development), 2.2 ms (folder). A unit test feeds 600,000 characters on one line and 100 lines of 2,000 and requires under 5 s; before cutting first, 480,000 characters took 378 s. The console reads took 0.02 s to 1.6 s, and health checks beside them matched the machine's baseline (median 0.02 s, worst 1.3 s with nothing of ours running).

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Device allowlist admits the six GET paths for active owner devices | invariant | Route-level authentication by exact path, the existing deterministic device model. |
| `ownerOrBearer`: bearer or owner-role device only | invariant | Authorization from the authenticated principal's resolved role; fails closed for unresolved people. |
| The loopback read uses this server's own token for an already authorized owner | invariant | A fixed set of GET paths built in code. The phone supplies only a file path, which is encoded as one query value and judged by the viewer. |
| `secretShaped` hides or refuses a path | invariant | A deterministic extra refusal on top of the viewer's rules. It can only show less; it grants nothing and blocks no action, so a brittle check is safe here. |
| Field lists, verdict and tone words | invariant | Display classification copied from the console's rules; gates nothing. |

## Verify the state, not its symbol

| Symbol | Claimed state | Corroboration | Unmeasurable |
|---|---|---|---|
| A console route's status 503 or 404 | The feature is off here | The e2e compares each page's state with its console route | Any other failure is "can't read", never "off" |
| `reviewDate` on the board | The review's age | Shown as a date, labelled as a model's assessment | Absent: no line is shown |
| Headline "Nothing is falling behind" | Queues measured as healthy | Queues waiting on a person are named in the headline; unmeasured ones are counted; machines that did not answer scope the words | No queues: says nothing is moving |
| Development counts | Queue and failure counts | Null when the source could not be read; tone is unknown then | Null renders as absent, not zero |

## Maturation plan

No flag, by design: read-only subsets of what the owner reads in the console; a revert is the whole rollback.

- **test-agent-live:** the unit, integration and e2e tests in §6 on a real server boot, and the seeded simulator screens.
- **dev-agent-live:** after release, Echo times each route on its own server with a health check beside it and records the numbers; a route that stalls health is fixed before anyone is told it is safe.
- **fleet:** the routes ride `mobilePairing.enabled`; the bearer path works regardless.
- **graduation criterion:** one week after release, the `mobile-console-pages` degradation count is zero or matches console read failures in the same window, and the dev-agent-live record passes.
- **dark-window:** none: the routes are live on release.
- **ladder:** mobilePairing

## Open questions

None.

## Frontloaded Decisions

- Read-only. Deciding on an idea, retrying a project, approving a pull request and editing a file stay in the console: cheap to change after, because the app states it and adds nothing durable.
- Files shows this machine only: see §5.
- Development is summary only; the console keeps the action cards.

## 4. Security

- Owner phone or bearer on every route. MSP, demoted, revoked, unsigned and tampered requests are refused before any read; a refused request causes no read (tested).
- The bearer is used only on loopback to fixed paths; it is never in a response. A phone file path cannot change the route: it is one encoded query value, and path traversal, absolute paths and never-served paths are refused by `validatePath`.
- Text from outside is untrusted: idea claims pass `freeText`, file text is scrubbed. File text can still hold an ordinary password no pattern knows, as it can in the console, to the same owner; the file viewer is already bearer-readable on this agent.
- A POST is refused by the device check.

## 5. Multi-machine posture

- Ideas: **machine-local read of a single agent ledger**, as the console's own note says: one ledger per agent, read from the holder. Default `unified` holds through that ledger; no new state.
- Pace and Maturation: **proxied-on-read** through the console routes' `scope=pool`, naming who did not answer.
- Development: this machine's shipping state. `machine-local-justification: hardware-bound-resource`: the verify queue and auto-merge watcher run on one machine's checkout.
- Files: this machine's disk. `machine-local-justification: hardware-bound-resource`: a file on one machine's disk. The screen says "on this machine".
- No new durable state, notices or generated URLs.

## 6. Tests

- **Unit** (`tests/unit/mobile-native-console-pages.test.ts`): each summarizer on both sides, off against failed, secret names, cut before scrub with a stall bound; `-claudemd` for migration; the allowlist set in `mobile-session-terminal`.
- **Integration** (`tests/integration/mobile-native-console-pages.test.ts`): full auth pipeline, refusals cause no read, cache, thrown reads.
- **E2E** (`tests/e2e/mobile-native-console-pages-alive.test.ts`): a booted, listening AgentServer, a phone paired for real, a file on disk read through the loopback, blocked and secret files refused, page state matched to the console route, raw routes closed.

## 7. Agent awareness and migration parity

`MOBILE_CONSOLE_PAGES_LINE` in the Mobile app routes block, inserted after the Passwords & keys bullet on update, once; a `CapabilityIndex` entry. No config change.

## 8. Rollback

Revert the commit. The app shows "update the agent" for these screens. Nothing durable is written.
