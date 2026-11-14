# NCB slice 3e — status

**Slice:** native-conversation-any-machine-access §3e, "The dashboard never loses a reply quietly (F5)".
**Branch:** `echo/ncb-3e-input-durability` (fresh off `origin/main` 3ae8208a6; the spec, its ELI16 and its convergence report are copied in unchanged from `echo/native-conversation-base-spec`, PR #3086). Slice 3b's files (PR #3092) are untouched.
**PR:** https://github.com/JKHeadley/instar/pull/3106
**Local Verify:** requested on the Studio (`POST /local-verify {"pr":3106}`, 100.124.55.70:4042) at 23:48 PST 2026-11-11; it answered `queue-full`. Retried from this session after this note was pushed (see the PR for the outcome). This note is pushed first so the head Local Verify runs on is final.
**Merged:** no (by instruction).

## What is built

- Serving side (`WebSocketManager` + new `InputIdLedger`): `input_caps` first on every subscribe (`inputAck: 2`; `remoteInput` = `allowRemoteInput` for a peer link, true for a local browser). `clientInputId` validated (`/^[A-Za-z0-9_-]{16,64}$/`, malformed → `invalid-input-id`, never typed), echoed on the ack and on every refusal. `(session, id)` recorded before the write; a repeat gets the original ack on its own connection without a write (also mid-write, also from another connection); an unknown flagged retry → `input-retry-unknown`, not typed. 256 ids per session in memory; counters per session and total.
- Relay side (`PeerStreamProxy` + `WebSocketManager`): caps cached per session for the current link, cleared on every link or subscription change, replayed to a late tab; `inputAck: 1` synthesised when an older machine answers `subscribed` without caps; an id-carrying answer goes only to the tab that sent it (outstanding-send count, cleared on answer, tab close, unsubscribe, link drop); `peer-stream-lost` with the id when the relay did not send.
- Console (`dashboard/console/input-model.js`, `sessions.js`, `console.css`): waits for caps; read-only with the refusal sentence when remote input is off; clears a draft only on its own id-carrying ack, however late; "Not confirmed yet" card after 8 s with Send again only under `inputAck: 2`; the fixed `[dashboard]` line once per draft (waits for the next caps if the link is down); older machine → no ids, unresolved at once, id-less acks clear nothing; keys carry an id and only report. Only the spec's fixed sentences; none asks the person to check anything.
- `GET /sessions/dashboard-input-status` (bearer): `inputIdsEvicted`, `inputRetryUnknown`, `inputIdsRepeated`, per session and total — the 2026-11-25 graduation evidence.
- CLAUDE.md paragraph "Dashboard reply box:" for new agents (template) and existing agents (content-sniffed migration + framework shadow).
- Maturation-plan row for 3e is in the side-effects artifact and the PR body (ladder: not applicable; no flag; rolls back by version).

## Tests (Mac Studio, TMPDIR=/Users/dabombstudio/echo-test-tmp, umask 022)

- Unit, new and changed: console-input-model 20, WebSocketManager 60, PeerStreamProxy 19, console-sessions 35, dashboard-input-awareness-migration 3 — all pass.
- Neighbour unit lane (git-diff selection + every migrate*/PostUpdateMigrator test + generateClaudeMd tests, `--maxWorkers=2`): 267 files, 1909 of 1910 passed. The one failure was `no-silent-fallbacks` (two new catch blocks that report to the sender); fixed by markers in the second commit, then that test plus the WebSocketManager and PeerStreamProxy files re-run green.
- Integration: `tests/integration/dashboard-input-durability.test.ts` 8/8 (first run found a real relay bug, two in-flight sends of one id lost the second answer; fixed with an outstanding-send count and a unit test).
- E2E: `dashboard-input-durability-alive` 4/4; with neighbours `pool-stream-roundtrip-alive` and `pool-stream-serving-alive`, 3 files / 11 tests pass.
- `npm run lint:parallel`: 52/52 steps pass.

## Second-pass review

Independent subagent. First read raised four concerns, all fixed: (1) `success: false` returned the text to the box although `rawInject` can fail after a partial paste, so it now stays unresolved and the session is asked; (2) frames could reach a same-named session's composer on another machine, now routed by machine; (3) the relay's pending answers were not cleared on a link drop, now they are; (4) an in-flight sentence outside FD-15, now removed. Re-check: "Concur with the review."

## Open problems

1. **Spec text vs build (for the spec owner).** Two refinements, recorded in the artifact: the relay synthesises `inputAck: 1` on an older machine's `subscribed` rather than on "any other first frame" (a straggling `output` on a live link would otherwise mislabel a current machine); and a first send that certainly typed nothing (gate refusal, unknown session, never relayed) returns the text to the box with its sentence instead of a card. `success: false` is not in that set.
2. **"Could not confirm that either" shows a moment early.** While the session line is in flight (normally under a second) the card already reads the second unresolved sentence, the cost of keeping to FD-15's fixed sentences. If wanted, FD-15 could add an in-flight sentence.
3. **`success: false` uses the spec's "Not sent: …" sentence** although part of the text may have been typed; the draft is kept and the session asked, so nothing is lost, but the wording is the spec's and slightly overstates.
4. **Commits used the logged orphan-deferral override.** The lint flags 8 lines in the approved spec (copied unchanged from #3086), whose deferrals name their registered CMT ids inline but not in `<!-- tracked: -->` form. The spec owner should add the markers on #3086.
5. **Rollback note.** The CLAUDE.md paragraph stays in existing agents after a version rollback; a rollback should also remove it (one content-sniffed removal).
6. **Live proofs not run.** The spec's 3e live proof (real dashboard at 1280x728 and 390x844, a throwaway pair with remote input on only there, a serving machine on the previous release) belongs to the test-agent-live rung before the release and dev-agent-live on release day.
