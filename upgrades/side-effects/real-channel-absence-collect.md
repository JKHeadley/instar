# Side-Effects Review — Real-channel collectMessages (absence proof over a live channel)

**Version / slug:** `real-channel-absence-collect`
**Date:** `2026-06-24`
**Author:** Echo (autonomous, 8-hour run)
**Spec:** `docs/specs/real-channel-absence-collect.md` (review-convergence + approved)
**Second-pass reviewer:** REQUIRED (touches the LiveTestHarness verdict path) — verdict appended below.

## Summary of the change

The `LiveTestHarness` absence assertion (PR #1262) could only run against a fake driver,
because the production `RealChannelDriver` had no `collectMessages`. This adds it, so the
"no spurious background message" proof runs over a REAL Telegram/Slack channel. The whole
risk of an absence proof is a silent **false PASS** (reporting "no spurious message" over
an incomplete read), so every under-collection path is forced to BLOCK, never PASS.

Files modified:
- `src/core/LiveTestHarness.ts` — new `AbsenceUnverifiableError` (a sender's
  read-incompleteness signal) + the absence-path catch now maps BOTH it and
  `DriverCapabilityError` to **BLOCKED**; a plain `Error` stays a FAIL. The §5.3
  pre-flight now treats any `absenceWindowMs != null` scenario as demo-only regardless of
  its `safe` tag (a whole-history read must never touch a live channel).
- `src/core/RealChannelDriver.ts` — new `collectMessages(surface, channelId, opts)`
  delegating to the surface sender; raises `DriverCapabilityError` for a surface whose
  sender has no collector; new optional `SurfaceSender.collectMessages`.
- `src/core/TelegramLiveSender.ts` — `collectMessages`: polls `getHistory` across the
  window, keeps ALL text versions per messageId (anti edit-laundering), skips non-finite
  ids, clamps the window to 300s, and BLOCKS (AbsenceUnverifiableError) on a
  marker-bounded full-page truncation (full page whose oldest entry is still after the
  marker — so a reused demo topic is not wrongly blocked).
- `src/core/SlackLiveSender.ts` — `collectMessages` (mirror): `oldest`-bounded read,
  BLOCKS on `ok:false` (failed read) or `next_cursor`/full-page (truncation); new
  `isAgentAuthored` helper matches `user` OR an injected `agentBotId` (a background nudge
  may carry only `bot_id`) — applied to `collectMessages` AND `awaitReply` for parity;
  optional `agentBotId` dep.

Files added:
- `tests/unit/realchannel-collect-messages.test.ts` — 22 unit tests: collect semantics,
  late-nudge polling, anti-laundering, truncation→BLOCK (marker-bounded), reused-topic
  no-mis-fire, Slack bot_id / ok:false / next_cursor, §5.3 absence-demo guard, and the
  end-to-end harness PASS/FAIL/BLOCKED over a RealChannelDriver.
- `docs/specs/real-channel-absence-collect.md` (+ `.eli16.md`, convergence report).

## Blast radius

- **Production runtime:** none. `collectMessages` is reachable ONLY via
  `LiveTestHarness.run` → `RealChannelDriver`, constructed per-request in the live-test
  route and the `instar dev` runner. No sentinel, gate, scheduler, or request path calls
  it (verified by the scalability + integration reviewers).
- **Existing callers:** unchanged. `RealChannelDriver`'s constructor signature is
  untouched; `collectMessages` is a new instance method. The harness's `!driver.collectMessages`
  BLOCKED path still fires for FAKE drivers (RealChannelDriver now routes per-surface
  "unsupported" through the typed error instead). `awaitReply`'s new `bot_id` matching is
  additive — unset `agentBotId` → byte-identical prior behavior (existing tests green).
- **Multi-machine:** machine-local-by-design — a live channel read happens on the serving
  machine against that channel's live history; no replicated/proxied state.

## Rollback

Fully additive and revertible: drop the three `collectMessages` method bodies, the
`AbsenceUnverifiableError` class + its catch clause, the §5.3 `absenceWindowMs` predicate,
and the `agentBotId` dep. No config defaults, hooks, CLAUDE.md template, migration, or
dashboard surface touched, so no Migration Parity obligation. Reverting the commit is
sufficient; nothing ships dark or irreversible.

## Second-pass reviewer verdict

Multi-angle spec-converge (6 internal lenses + codex-cli:gpt-5.5 + gemini-2.5-pro across
3 rounds) converged with zero material findings in the final round. Round 1 surfaced 5
material false-PASS holes (truncation, edit-laundering, Slack `bot_id`, Slack `ok:false`,
§5.3 safe-bypass) — all fixed + tested. Round 2 surfaced 1 material (Telegram full-page
guard mis-firing on a reused demo topic) — fixed marker-bounded + tested. Round 3
verified resolution. Standards-Conformance Gate: 0 flags all rounds. Verdict: APPROVED.
