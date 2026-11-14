# NCB slice 3d — status

**Slice:** native-conversation-any-machine-access §3d, "Signed transcript and history reads (F4)".
**Branch:** `echo/ncb-3d-transcript-reads` (fresh off `origin/main` 3ae8208a6, v1.3.1739; the spec, its ELI16 and its convergence report are copied in from `echo/native-conversation-base-spec`, PR #3086). Slice 3b's files (PR #3092) are not touched.
**PR:** https://github.com/JKHeadley/instar/pull/3100
**Local Verify:** requested on the Studio (`POST /local-verify {"pr":3100}`, port 4042) right after this note was pushed, so Local Verify runs on the final head. The Studio's answer is reported in the build session's final report (not here, so the head Local Verify runs on stays final).
**Merged:** no (by instruction).

## What is built

- `session-transcript-pull` mesh verb, read/observe RBAC class, registered on the production dispatcher (`server.ts` `_servePoolReads`). Modes `transcript` (one page of a session recorded on the serving machine, never a path; every answer carries `conversations`) and `list` (the machine's own session list, its plain `/sessions` read over loopback).
- `topic-history-pull` `shape: 'pool'`: `before`, `beforeMessageId`, `limit` up to 100, whole rows with `messageId`, `eventId`, `provenance` and the origin join (the machine's own plain History read over loopback), 512 KiB cap, `truncated` + `oldest`, the `shape` echo. Default shape unchanged.
- Oversized-row rule for both verbs (`oversizedRow.ts`): newest-first pages; a row alone over the cap comes cut on a UTF-8 boundary with `rowTruncated: { row, totalBytes, from, to }`; continuation by `row` + `byteFrom`; redaction before the cut; the page cursor always moves past the row. Bound-checked continuations (`bad-byte-range`, `row-gone`).
- Reader: `index` per entry, `clipped: true` on every cut entry, `full` lifts the 4,000-character cut, offset+index cursor (`beforeIndex` / `nextBeforeIndex`).
- Routes: transcript (`?machineId=`), pool History fan-out, `/sessions?scope=pool` try the signed verb first. Bearer fallback only on `no-handler`, `claim-unauthorized` with an absent/older version advert, or a missing `shape` echo; never after a timeout; remembered per machine, kind and version. Answers name `via`; unanswering machines are listed in `asleepOrUnreachable` (id, name, last seen). A machine that answered and refused is reported as a refusal, not as asleep. `GET /pool/signed-reads` → `signedCapable`, `bearerFallbackNeededBy`, counts. Pool History continuation over HTTP (`machine` + `row` + `byteFrom`), the cut row marked on the row, and merged paging that cannot skip rows a capped machine still holds.
- Audience (`transcriptAudience.ts`): owner only (allowlist: no device principal of any kind), most restrictive over the session's conversations, resolved at read time from the confined list and signed team record; currency refusal on a team-log gap or a refusing puller; `unreadable` fails closed; missing `conversations` field served on a never-team agent, refused with a team. Applied on the serving machine's local route and on the asking machine. App-conversation sessions name their conversation through the channel alias. No device route added.
- Redaction: the serving machine's token and PIN are removed before any clip or cut; the bearer hop to an older machine always asks `redact=device`.
- Dashboard History carries `beforeIndex`; the owner's phone shows the fixed refusal sentence. CLAUDE.md section for new and existing agents (marker-guarded, framework shadow included).

## Maturation-plan row (spec §Maturation plan, 3d)

Live, every agent, no switch; rollback by version (the bearer hop is still in the code). The kill criteria are observable: `GET /pool/signed-reads` → `counts.bearerReads`, `counts.failuresNotDowngraded` (each a timeout or transport error reported without sending the token; the downgrade itself is excluded by construction), and `bearerFallbackNeededBy` for the 2026-11-25 CMT-051 check.

## Tests

Run on the Studio (Mac), `TMPDIR=/Users/dabombstudio/echo-test-tmp/ncb3d` (outside /tmp, no dots), umask 022. Machine load stayed under 1 per core, so vitest ran with its defaults (targeted runs are clamped to 4 workers).

- New tests: `tests/unit/sessionTranscriptPull.test.ts` (19), `tests/unit/topicHistoryPull.test.ts` (16, 4 new), `tests/unit/signedPoolReads-awareness-migration.test.ts` (5), `tests/integration/pool-reads-signed.test.ts` (12), `tests/e2e/session-transcript-pull-alive.test.ts` (2). All pass.
- Unit neighbours, selected by the diff (modules touched, the console and mobile History callers, every `generateClaudeMd` test) plus every `migrate*` and `PostUpdateMigrator*` test: 464 files, 5,959 tests, 0 failures. One failure found along the way and fixed: the new CLAUDE.md text contained the literal `sessions?scope=pool`, the content marker of another migration (`PostUpdateMigrator-poolSessionsVisibility`), so that migration thought its line was present; the text was reworded and that file re-run (9 of 9).
- Integration neighbours (16 files: the new file plus the transcript, pool History, session list, team-access, mobile History and topic-history neighbours): 193 of 194 on the first run; the one failure was a setup error in the new test (a stub that answered `no-handler` where the case needed `claim-unauthorized`). Fixed, re-run 12 of 12.
- E2E neighbours (11 files): 66 of 67; the one failure was the new test expecting 401 where the real auth middleware answers 403 for a wrong token. Fixed, re-run 2 of 2.
- `npm run lint:parallel`: all 52 steps pass. `tsc --noEmit`: clean.
- The pre-push smoke tier skipped itself (`affected-set-indeterminate`, listing timed out); the runs above are the neighbour coverage.

## Second-pass review

Independent subagent. First read: "concern", eight findings, none a token sent after a timeout or a transcript shown to a member or guest. Seven were fixed in this PR (pool History continuation over HTTP, the cut row marked on the row, merged paging that cannot skip a capped machine's rows; app sessions naming their conversation through the channel alias; `redact=device` on every bearer hop to an older machine; answered refusals not listed as asleep; the principal check as an allowlist; consistent byte ranges for an oversized entry; the phone showing the fixed refusal sentence). The eighth is Open problem 1. Re-check by the same reviewer: "concur (after the builder's fixes, re-checked)"; its one further non-blocking note (an all-digit event id as a continuation row) was fixed. Details in `upgrades/side-effects/ncb-3d-transcript-reads.md`.

## Open problems

1. **`SIGNED_POOL_READS_MIN_VERSION = '1.3.1740'`** (`src/core/poolSignedReads.ts`) must equal the release that actually ships this PR. If main has released past 1.3.1740 before merge, bump it to the release that carries it. If it is too low, a peer between the two answers `claim-unauthorized` and is reported as refusing instead of being read by bearer: a lost read, never a sent token.
2. **The copied spec trips the orphan-deferral lint** (same as 3b): the commit used the logged override (`INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS=1`); the spec owner should add `<!-- tracked: -->` markers on #3086. This PR does not edit the approved spec text. The override log line is committed with this note.
3. **Live proofs not run.** The real-pool proof (Mama PC reading an M5 Pro and a Studio transcript and topic 141868's pool history, each `signed`; one machine asleep named) and the throwaway-agent audience proof (member and guest refused) belong to the test-agent-live and dev-agent-live rungs before and on the release day.
4. **"Conversations a session served" is the session record's** (topic, Slack channel, memory place, app channel alias). A session that served no recorded conversation is the owner's, as the spec decides for jobs and hand-started sessions (spec Left behind 11).
5. **Found along the way:** the 4,000-character clip can split a UTF-16 surrogate pair (predates this change). Triage: not blocking, filed to the feedback queue (`fb-8bc080b9-b49`).
