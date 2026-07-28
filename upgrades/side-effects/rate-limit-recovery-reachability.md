# Side-Effects Review — RateLimitSentinel recovery reachability

**Version / slug:** `rate-limit-recovery-reachability`
**Date:** `2026-05-24`
**Author:** `echo`
**Second-pass reviewer:** `internal-adversarial` (external /crossreview tooling not wired on this host)

## Summary of the change

The RateLimitSentinel detects Anthropic's server-side throttle correctly and
schedules its backoff correctly, but its two recovery closures in `server.ts`
(`rateLimitResume`, `rateLimitNotify`) both began with
`const topicId = telegram?.getTopicForSession(sessionName); if (topicId == null) return`.
For a session not bound to any Telegram topic — e.g. a developer's interactive
Claude Code window — both paths silently no-opped. Detection + backoff ran, then
the resume nudge and the user notice dropped on the floor. From the user's seat
this is indistinguishable from no sentinel existing (the v1.2.33 ship that
"recovered" in tests but never in Justin's real dev window).

This PR makes recovery reachable under **all** session conditions:

- **Resume** — topic-bound sessions get the topic-tagged nudge through the
  provenance-checked `injectMessage` path (unchanged). Non-topic-bound sessions
  get a new `SessionManager.injectInternalMessage` path that bypasses the
  topic-prefix InputGuard requirement (trusted in-process caller, logged with
  `source: 'sentinel-recovery'`).
- **Notify** — session topic → lifeline (system) topic → a loud
  `recovery-unreachable` audit event. Never a silent return.
- **Audit** — every recovery attempt records `recovery-reached` /
  `recovery-unreachable` to `logs/sentinel-events.jsonl`; an unreachable event
  also appends to `.instar/sentinel-alerts.json` (rolling 200) so the dashboard
  surfaces it even when Telegram is unavailable.

The reachability branching was extracted from the inline closures into
`sentinelWiring.buildRateLimitRecoveryDeps()` so it is unit-testable — the exact
gap that let the bug ship past green tests (the logic was inline + untestable).

**Files touched:**
- `src/core/SessionManager.ts` (+`injectInternalMessage`, internal-only, NOT HTTP-exposed).
- `src/monitoring/sentinelWiring.ts` (+`buildRateLimitRecoveryDeps`, `RATE_LIMIT_RESUME_NUDGE`, types).
- `src/commands/server.ts` (rewired the two closures through the factory + a `recordRecovery` audit writer).
- `tests/unit/rate-limit-recovery-reachability.test.ts` (new, 9 cases — both sides of every reachability boundary).
- `tests/unit/rate-limit-recovery-wiring.test.ts` (new, 6 cases — T5 wiring integrity + T7 InputGuard boundary).
- `upgrades/NEXT.md`, `package.json` bump.

## Decision-point inventory

- **Topic vs. non-topic resume path** — *modify*. Pure presence check on
  `getTopicForSession`; topic path is byte-for-byte the old behavior, non-topic
  path is the new internal injection. No judgment.
- **Notify fallback order** — *new*. session-topic → lifeline → audit. Each step
  is a null check; deterministic, no LLM.
- **InputGuard bypass (`injectInternalMessage`)** — *new security-relevant path*.
  Covered in §Security boundary below.
- **Audit sink** — *new*. Append-only, best-effort, wrapped in try/catch so a
  logging failure can never break a recovery nudge.

## Over-block / under-block analysis

- **Under-block (the bug):** recovery reaching nothing for non-topic-bound
  sessions. Closed — every path now terminates in a delivery or a recorded
  unreachable event.
- **Over-block:** none introduced. The topic-bound path is unchanged. The new
  internal injection only fires when there is genuinely no topic, and only from
  the in-process sentinel.

## Security boundary (InputGuard)

`injectInternalMessage` bypasses the topic-prefix provenance check, so it is a
trust boundary. Mitigations:
- It is a method on `SessionManager` only — **not** wired to any HTTP route
  (asserted by test T7: `routes.ts` must not contain `injectInternalMessage`).
- All HTTP injection continues through `injectMessage`, which enforces
  provenance / prefix.
- Every internal injection logs an `internal-recovery-injection` security event
  with the `source` label, so the audit log distinguishes trusted recovery
  nudges from user/topic traffic.

## Signal vs. authority

No new blocking authority. The sentinel is a bounded recovery primitive; the new
code only adds *delivery channels* and an *audit trail*. Nothing gates user
actions or other sessions.

## Interactions

- **CompactionSentinel / other sentinels** — unchanged. The zombie-veto
  composition and bidirectional defer logic are untouched.
- **SentinelNotifier (socket/silence trio)** — untouched. Their default-off
  `sentinelTelegramEscalation` is deliberately preserved (the post-2026-05-22
  anti-flood design). This PR does **not** flip that default — the original
  spec's Part A3 is intentionally dropped as superseded.
- **InputGuard** — only adds a new logged event type; existing provenance flow
  is unchanged.

## Migration parity

No agent-installed files change. This is server-side binary code
(`SessionManager`, `sentinelWiring`, `server.ts`) shipped via npm update — every
existing agent picks it up automatically on update with no migration entry. No
new config default (the RateLimitSentinel is already default-on), no hook, no
skill, no CLAUDE.md template capability. (Worktree clone-isolation and the
socket/silence default already shipped separately via #334/#340/#351 and are out
of scope here.)

## Rollback

Single, independent, trivially reversible: `git revert` restores the two inline
closures (reintroducing the silent no-op). The new `injectInternalMessage` and
factory become dead code on revert; no state migration to undo.

## Out of scope

- Flipping `sentinelTelegramEscalation` to default-on (superseded by anti-flood).
- Socket-disconnect / active-silence sentinel reachability (default-off by design).
- Worktree clone isolation (already shipped via #334).
