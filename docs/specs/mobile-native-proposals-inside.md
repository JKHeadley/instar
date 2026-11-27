---
title: "Native Proposals and How I'm doing inside screens for the Instar iPhone app"
slug: "mobile-native-proposals-inside"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "mobile-native-proposals-inside.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under Justin's request (Telegram topic 134088, 2026-11-03 22:01 and 22:55 PST: the app should do every feature natively; the plan of record names Proposals and How I'm doing inside); applies because both routes are read-only subsets of what the owner already reads, with no constitution change"
review-convergence: "2026-11-04T23:51:11.219Z"
review-iterations: 6
review-completed-at: "2026-11-04T23:51:11.219Z"
review-report: "docs/specs/reports/mobile-native-proposals-inside-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

## 1. Problem

Operator request (Justin, Telegram topic 134088, 2026-11-03 22:01 and 22:55 PST): the Instar iPhone app should do every feature natively instead of opening dashboard pages. The plan of record (`.instar/lanes/app-native-coverage-plan.md`) still shows two read pages as web views:

- **Proposals**: the fixes the agent's novel-failure reviewer proposes (legacy `dashboard/proposals.html`).
- **How I'm doing inside**: the console page that shows recent records, repeating problems, checks on the agent's own claims and correction reviews (`dashboard/console/inside.js`).

A paired phone signs each request with its device key, and `deviceAuthenticator` admits only paths in `DEVICE_ALLOWLIST` (`src/server/mobilePairingRoutes.ts`). The raw routes are bearer-only.

## 2. What exists (instar main 41bda81c0)

- `GET /remediation/proposals` needs `X-Instar-Request: 1` and the bearer; it answers visible (first 3 outstanding), queued, dismissed and promoted proposals, redacted below collaborative trust. Files live under `.instar/remediation/proposals-<machineId>/`. Dismiss is a separate collaborative-trust POST.
- The Inside page reads `/shared-state/recent`, `/failures/insights`, `/failures/analysis`, `/completion-claim/audit`, `/class-reviews` and others, and turns them into words in `dashboard/console/inside-model.js`.
- The merged mobile read pattern (PRs #2706, #2712, #2725, #2728): purpose-built trimmed routes, `ownerOrBearer`, `cleanText`, `rowKey`, `singleFlight` (15 s), `DegradationReporter` on read failure, owner-only allowlist entries with their own bucket, peers read through `peerSummaries` with `?scope=local`.

## 3. Design

### 3.1 Two new read routes

New module `src/server/mobileProposalsInsideRoutes.ts`, mounted inside `createRoutes` beside the phones-messages routes.

| Route | Reads | Answers |
|---|---|---|
| `GET /mobile/proposals` | `loadAllProposals(stateDir)` (exported from the existing route module) + each online peer's `?scope=local` | `{ schemaVersion, generatedAt, state, selfState, headline, outstanding, rows, truncated, dismissed, promoted, unread, offline, peersUnknown }` |
| `GET /mobile/inside` | `sharedStateLedger.recent` (40), `failureLedger.listInsights` (1000, its ceiling, so `repeating` is a real count up to that ceiling) and `analyze` (7 days), `completionClaimVerifier.readAudit` (20), `classReviewStore.list` (20) + `countOpen`, + each online peer's `?scope=local` | `{ schemaVersion, generatedAt, headline, tone, self, peers, unread, offline, peersUnknown }` |

`?scope=local` answers this machine's summary only and never reads peers; any other value is ignored. Its shape is the machine's part alone: for proposals `{ selfState, outstanding, allKeys, rows, truncated, dismissed, promoted }`, for inside the `self` object's fields at the top level.

`outstanding` is the true count across machines that answered, independent of the row cap; the headline uses it. A proposal read with the wrong shape, or a failed one, is `selfState: unavailable`; when no machine answered, `outstanding`, `dismissed` and `promoted` are `null`, never 0. `loadAllProposals` reads every `proposals-*` directory, so a proposal file present on two machines has the same one-way key on both and counts once: each `?scope=local` answer lists `allKeys` (max 500) and the merged count is the size of the union; past 500 on a machine it is a floor, `atLeast: true`, and the headline says "At least". A list whose every element is malformed reads `unavailable`, not empty (every source alike). A peer whose keys do not account for its count is `unread`. `dismissed` and `promoted` are per-machine sums and the app words them that way; a proposal copied to two machines can have a different status on each, and each machine's status is shown as that machine holds it. `peersUnknown: true` means the machine list or the fan-out itself failed, so the headline is scoped to the machines that answered.

**Proposal row.** `key` (one-way hash), `summary`, `hypothesis`, `code`, `occurrences`, `restarts`, `generatedAt`, `queued` (past the machine's first 3 outstanding, as the console shows), `machine` (null for this machine). Only outstanding proposals are rows; dismissed and promoted are counts. Never returned: proposal id, cluster signature, agent id or signature, sample events, forensic fields, source directory.

**Inside sections** (`self`, and each entry of `peers`, which adds `machine`): `headline`, `tone`, `sub`, then:

- `activity`: `state`, `line`, `truncated`, `rows` (max 30 of the 40 read): `key`, `kindWords`, `subject`, `withWords`, `statusWords`, `overdue`, `at`, `tone`. A commitment's status is never "open" from its stored value: a non-open stored status or a later record in the window decides, otherwise "Status unknown" (the console's rule).
- `problems`: `state`, `line`, `weekTotal`, `repeating`, `cameBack`, `rows` (max 10, repeats that came back first): `key`, `summary`, `statusWords`, `changes`, `since`, `tone`.
- `claims`: `state`, `line`, `contradicted`, `checked`, `rows` (max 20): `key`, `sentence`, `verdictWords`, `at`, `tone`. The sentence is fixed words from the record's predicate or action kind; claim text, targets and reasons never leave.
- `reviews`: `state`, `open`, `rows` (max 10): `key`, `words`, `lifecycleWords`, `seen`, `why`, `at`, `tone`.

`cameBack` counts only problems still active; a settled problem never reads as having come back (stricter than the console). `checked` counts only observations the evidence settled, so "couldn't verify" is never a pass; a verdict word this version doesn't know reads as unverified. An unknown review lifecycle reads "Status not recorded".

Each section's `state` is `ok | off | unavailable`. `off` means the feature is absent on that machine (the raw route would answer 503). `unavailable` means the read threw or had the wrong shape; its counts are `null`, never 0.

The headline copies the console's order: contradicted claims, a problem that came back, repeating problems, then "nothing repeating". When parts cannot be read (including reviews and the week's total) it says which. Tone `ok` needs something actually measured and nothing unread; with every check off it reads "None of these checks are on for this machine.", tone `unknown`. In the merged answer a peer leads only when it is worse than this machine and at least `attn`, and its headline names the machine. An overdue commitment or a failed review does not change the headline, matching the console: those rows carry their own attention dot. Any unread or offline machine, or `peersUnknown`, scopes the headline to the machines that answered and holds the tone at no better than `unknown`.

Not included, deliberately: session bindings and their revoke, the memory-source lookup, the all-time analysis, older-page browsing, and the individual failure list. These stay in the console and the app says so in one line.

**Text.** Free text passes `freeText`: `cleanText` (normalized, control and bidi characters removed, `scrubSecrets`, whitespace folded, capped) and then absolute, home and `file://` paths replaced by "[a file]". This is best effort: it covers the host's paths, and repo-relative names such as `src/a.ts` stay. Proposal summaries are model output over failure data and are labelled as such in the app. All text is display-only data, never instructions.

**Peers.** A peer is the agent's own machine, holding the same token, so this is not a defence against a hostile machine: rebuilding the answer protects against version skew, corrupted state and a compromised peer's text reaching the owner's screen. The existing `peerSummaries` helper: online peers, at most 16, 5 s timeout, 500,000-byte read cap, one token. A peer's rows are rebuilt field by field: free text re-cleaned, fixed-word fields checked against this server's own word sets and replaced if unknown, unknown fields dropped, states and tones validated. A peer's sentences are not shown: each section's line and the machine's headline and tone are rebuilt here from validated counts and rows. A peer's claim tones and counts are recomputed from its validated verdict words. Numbers that disagree with the rows read `unavailable`, and a peer on another `schemaVersion` is `unread`, so version skew can't read as clean. A section that says `ok` without its counts (reviews included) reads `unavailable`, locally too. A peer with no answer, or missing any of the four sections, is listed in `unread`, never treated as clean. A peer section that reads `unavailable` scopes the merged headline too.

**Observability.** A source that throws, or answers in the wrong shape, or each peer whose answer is rejected, records one `MobileProposalsInside.read` degradation per failing source per answer build (route and error class only; builds happen at most once per 15 s per route and scope). A peer that simply does not answer is network state, named in `unread`, not a degradation of this feature and its part reads `unavailable`; the answer stays 200. Only a failure building the answer itself answers `500` with a fixed code (`proposals-unavailable`, `inside-unavailable`).

**Cost.** No LLM call on any path. Ledger, audit and review reads are limited at the source. The proposals read loads all proposal files, as the console does; the reviewer caps what it writes and this runs at most once per 15 s (single-flight cache) behind one 20-per-minute device bucket.

### 3.2 Who may read them

Two entries are added to `DEVICE_ALLOWLIST`: `GET /mobile/proposals` and `GET /mobile/inside`, each `statuses: active`, `body: 'none'`, `ownerOnly: true`, sharing the bucket `proposals-inside-reads` (20 per minute). Inside each route, `ownerOrBearer` re-checks. An MSP phone gets 403 `owner-phone-required`. The raw routes stay off the allowlist.

The bearer may read both: it already reads every source route. `/mobile/proposals` skips the `X-Instar-Request` attestation because that header guards the raw records (and dismissal); this answer is a trimmed read, and redacted fields (`reason.full`, `rawResponse`) are never in it at any trust level.

### 3.3 The app

Two SwiftUI screens in `apps/instar-ios`, in new files `ProposalsInsideData.swift` (parsing, unit-tested) and `ProposalsInsideViews.swift`, opened from a new section on the agent's detail screen.

- **Proposals**: headline; each row's summary (labelled "Written by AI"), likely cause, how often, code, time and machine; queued rows under their own heading; dismissed and promoted counts; a note when machines did not answer or the list was capped; one line saying dismissing is done in the console.
- **How I'm doing inside**: headline, then one group per machine with its sections; off sections are one line; an unreadable section says "can't tell"; one line saying session bindings and the memory lookup are in the console.

Pull to refresh, no polling. `403 device-not-allowed` or `404` shows the existing "update the agent" line.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Device allowlist admits the two GET paths for active owner devices | invariant | Route-level authentication by exact path, the existing deterministic device model; no competing signals. |
| `ownerOrBearer`: bearer or owner-role device only | invariant | Authorization from the authenticated principal's resolved role (Know Your Principal); fails closed for unresolved people. |
| `/mobile/proposals` does not require the `X-Instar-Request` attestation the raw route needs | invariant | A fixed field allowlist that excludes every redacted field at every trust level; the attestation guards raw records, and no write is reachable here. |
| Field allowlist in each summarizer, path replacement, peer re-cleaning | invariant | A fixed redaction contract: only listed fields leave the server. |
| Headline order, verdict and status words | invariant | Display classification copied from the console's documented rules; gates nothing. |

## Verify the state, not its symbol

No detector, gate on agent behaviour or LLM judgment is added. The display states:

- Proposal count: symbol = persisted proposal files with status `outstanding`. State claimed = fixes waiting for review. Corroboration: the same files the console lists. Unmeasurable: a failed read is `unavailable` ("Can't read proposals right now"), never "none waiting"; a machine that did not answer scopes the headline to the machines that answered.
- Repeating problems: symbol = insight records not confirmed fixed or set aside. Unmeasurable: `repeating: null`, "Can't tell".
- Claims: symbol = audit verdict records, labelled advisory in the app. Unmeasurable: `contradicted: null`; no checked claims reads "No claims checked yet", never as a pass.
- Commitment status: symbol = the stored status plus later records in the window. Unmeasurable: "Status unknown", never "Open".
- Peer sections: symbol = the peer's own summary. Unmeasurable: `unread`.

## Maturation plan

No flag, by design: read-only subsets of what the owner reads in the console; a revert is the whole rollback.

- **test-agent-live:** the unit, integration and e2e tests in §6 on a real server boot, and the seeded simulator screens.
- **dev-agent-live:** after release, Echo drives both screens in the simulator app paired to Echo's own server (a device of Echo's, not the operator's phone) and records PASS/FAIL per screen.
- **fleet:** the routes ride `mobilePairing.enabled`; the bearer path works regardless.
- **graduation criterion:** one week after release, the `MobileProposalsInside.read` degradation count is zero or matches console read failures in the same window, and the dev-agent-live record passes.
- **dark-window:** none: the routes are live on release.
- **ladder:** mobilePairing

## Open questions

*(none)*

## Frontloaded Decisions

1. Purpose-built trimmed routes instead of allowlisting raw routes (same as #2706, #2712, #2725, #2728).
2. Both screens are read-only. Dismissing a proposal stays in the console behind its collaborative-trust check; revoking session bindings stays there too.
3. Owner phones only.
4. The bearer may read both summaries (§3.2).
5. Proxied-on-read across peers, each machine named. The console's Inside page shows this machine only; the phone shows more because the phone may not be talking to the machine with the problem.
6. Row caps as in §3.1; the app states when a list was cut.
7. Failure-by-failure history, all-time analysis and the memory lookup stay in the console; the app says so.
8. Absolute, home and `file://` paths in free text are replaced by "[a file]", stricter than the console; this is best effort, not a guarantee about repo-relative names.

## 4. Security

- Widened device-key access: two read-only GET paths for owner phones, each a subset of what the owner reads in the console. A stolen owner phone that passes the device check can read these summaries, as it can the other owner reads.
- No structured id, fingerprint, signature, raw model answer, payload or raw error is returned. Free text is scrubbed, capped and has host paths replaced (best effort).
- Raw routes stay off the allowlist (tests on both sides). MSP, demoted, revoked, unsigned, tampered and notify-token requests are refused; a POST to the read paths is refused by the device check.
- Fan-out: at most 16 peers, at most once per 15 s, behind the shared 20-per-minute bucket; a peer's `?scope=local` answer never reads further peers.
- Peer answers are untrusted: rebuilt field by field, never passed through.

## 5. Multi-machine posture

- Proposals: **proxied-on-read**: this machine's files plus each online peer's `GET /mobile/proposals?scope=local`, each row naming its machine.
- Inside: **proxied-on-read**: this machine's summary plus each online peer's `GET /mobile/inside?scope=local`, one group per machine.
- No new durable state, no user-facing notices, no generated URLs.

## 6. Tests

- **Unit** (`tests/unit/mobile-native-proposals-inside.test.ts`): each summarizer on both sides of each rule, path replacement, peer re-cleaning, merge and headline order, wrong-shape peers.
- **Integration** (`tests/integration/mobile-native-proposals-inside.test.ts`, production `authMiddleware` + `deviceAuthenticator`): owner served and trimmed (planted ids and a credential never appear), bearer served, `?scope=local`, a local answer fed through as a peer, partial failures, fixed error codes; MSP, demoted, revoked, unsigned, tampered, notify-token and POST refused.
- **E2E** (`tests/e2e/mobile-native-proposals-inside-alive.test.ts`): production boot, phone paired through redeem/confirm, both routes 200, a proposal file on disk reaches the phone without its id, each section's state agrees with its raw route, raw routes 403 for the phone.
- **Parity** (unit): the kind, insight-status and verdict tables equal the console's exported tables in `inside-model.js`.
- The named owner-only set test lists both paths. App: parsing unit tests and seeded simulator screens.

## 7. Agent awareness and migration parity

- `generateClaudeMd()` gains one bullet in the Mobile app routes block after the permissions bullet.
- `migrateClaudeMd()` inserts it under a content-sniff guard on `GET /mobile/proposals` (idempotent); a block without the permissions bullet gets the line appended.
- `CapabilityIndex` gets a `mobileProposalsInsideScreens` entry (no new prefix).
- No config defaults, hooks or skills change.

## 8. Rollback

Revert the commit. The routes disappear and the app shows "update the agent". No data is written by these reads.
