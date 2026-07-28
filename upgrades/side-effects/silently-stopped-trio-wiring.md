# Side-Effects Review — Silently-stopped trio: server wiring

**Version / slug:** `silently-stopped-trio-wiring`
**Date:** 2026-05-23
**Author:** echo
**Second-pass reviewer:** [pending — high-risk: sentinels + server startup]
**Spec:** [docs/specs/silently-stopped-trio.md](../../docs/specs/silently-stopped-trio.md)
**ELI16:** [docs/specs/silently-stopped-trio.eli16.md](../../docs/specs/silently-stopped-trio.eli16.md)

## Summary of the change

PR #334 merged `SocketDisconnectSentinel` and `ActiveWorkSilenceSentinel` as
standalone, unit-tested detectors — but never instantiated them in the running
server. A grep proved it: `RateLimitSentinel` (the pattern they claimed to
mirror) is referenced from six files; both new sentinels were referenced from
zero outside their own definition + test files. The merged release notes and
side-effects artifact both stated "wired into server startup". That was false:
on every agent, after the auto-update, the sentinels would still never run.

This change is the missing wire-up. No detector logic changes; the detectors
were correct. What was missing was construction + lifecycle.

- **`src/monitoring/sentinelWiring.ts`** (new) — testable dependency builders:
  `makeAttentionPoster` (posts escalations to the tone-gated `/attention`
  route, returns true only on 201), `buildSocketDisconnectDeps`,
  `buildActiveWorkSilenceDeps`, `OutputActivityTracker` (per-session
  output-change timing), and `looksActivelyWorking` (active-vs-idle detector
  built on the existing `frameworkActivitySignals`).
- **`src/monitoring/SocketDisconnectSentinel.ts`** — added an optional
  `listSessionNames` dep plus `start()` / `stop()` / `tick()` so the sentinel
  self-drives a 15s scan loop (mirrors `ActiveWorkSilenceSentinel`'s shape).
  Existing event-driven API (`report` / `scanSession`) is unchanged.
- **`src/commands/server.ts`** — instantiates both sentinels from a
  SessionManager surface + config, and starts them. Guarded by config
  kill-switches, default-on.
- **`src/core/types.ts` + `src/config/ConfigDefaults.ts`** — config types +
  default-on entries. Migration parity is automatic: `migrateConfig` applies
  all `ConfigDefaults` via `applyDefaults`, so existing agents receive the
  config keys on update.

## Decision-point inventory

- `looksActivelyWorking` — **add** — structural detector (regex on captured
  frame via `frameworkActivitySignals`). No judgment, no authority.
- `OutputActivityTracker.snapshot` — **add** — deterministic change-detection
  (FNV-1a hash compare) + active/idle classification. Marks idle-at-prompt
  sessions `paused` so the silence sentinel skips them.
- `makeAttentionPoster` — **pass-through** — delegates the actual block/allow
  decision to the existing `/attention` tone gate (B12-B14). Returns true only
  on 201; a 422 block is the gate doing its job, not an error.
- `SocketDisconnectSentinel.start/tick` — **add** — bounded scan loop.

## 1. Over-block

- **Active-vs-idle false negative → no escalation.** If a frozen session's last
  frame does NOT contain an active-work signature (spinner / "esc to interrupt"
  / tool-call / "(running)"), `OutputActivityTracker` marks it `paused` and the
  silence sentinel skips it. This is deliberate: the alternative (flag every
  static frame) would fire on every idle-at-prompt session waiting for the
  user. Cost of this choice: a session that froze at a non-active-looking frame
  is missed by sentinel C — but SocketDisconnectSentinel, SessionWatchdog, and
  SessionMonitor still cover their shapes. The integration test asserts an
  idle-prompt session is NOT escalated.
- **Socket regex over-broad** (unchanged from PR #334) — false-positive cost is
  one bare Enter + a first-notice that the tone gate (B14) suppresses anyway.

## 2. Under-block

- **`looksActivelyWorking` pattern coverage.** The frame is classified using
  the session's resolved framework (via `SessionManager.frameworkForSession`,
  added in this PR — second-pass review caught that the prior draft read a
  non-existent `sess.framework` field and silently fell back to claude-code for
  every session, mis-classifying Codex). Coverage is now correct for both
  claude-code and codex-cli. A framework outside that map (none exist today)
  still defaults to claude-code patterns; the same `frameworkActivitySignals`
  module backs StallTriageNurse, so adding a framework improves all consumers
  centrally.
- **First-notice delivery.** The "lost its connection, trying to recover"
  notice has no CTA, so the tone gate (B14) blocks it (422 → poster returns
  false). This is intended — only the escalation (which carries a yes/no CTA)
  reaches the user. The recovery loop runs regardless of whether any notice
  lands.

## 3. Level-of-abstraction fit

- Wiring lives in `server.ts` alongside the RateLimitSentinel/CompactionSentinel
  wire-up — the same layer, the same idiom (`await import` + construct + start).
- Dependency construction is extracted to `sentinelWiring.ts` specifically so it
  is unit-testable in isolation (the bug this PR fixes was an *untested wiring
  gap*; the fix ships the wiring-integrity tests the standard requires).
- `OutputActivityTracker` is the right owner of per-session output timing for
  the topic-independent case — SessionMonitor's equivalent snapshots are keyed
  by topicId and therefore blind to non-topic-bound sessions (the exact gap).

## 4. Signal vs authority compliance

**Reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No new blocking authority.** Every user-facing escalation is a signal
  posted to the existing `/attention` tone gate, which holds the authority.
- `looksActivelyWorking` and `OutputActivityTracker` are detectors.
- `makeAttentionPoster` returns the gate's verdict (201 → delivered, 422 →
  blocked); it never overrides the gate.
- The recovery primitives (bare Enter via `sendKey`) are bounded and
  alive-gated.

## 5. Interactions

- **Double-fire with the live socket sentinel + silence sentinel.** A socket
  drop (15s scan) fires far sooner than the 15-min silence threshold, and each
  uses a distinct `/attention` id (`socket-disconnect:` vs `active-silence:`),
  so they don't collide. Idempotency-by-id on `/attention` upserts rather than
  duplicating.
- **Recovery nudge vs other injectors.** The bare Enter is alive-gated and does
  not interrupt work (unlike Ctrl+C). It does not register with the
  zombie-kill veto used by RateLimit/Compaction sentinels — these sentinels do
  not kill sessions, so the veto is not relevant.
- **Tracker memory.** `OutputActivityTracker` prunes ended sessions every
  snapshot, so the map cannot grow unbounded.

## 6. External surfaces

- **Telegram:** one new attention-item class per incident, tone-gated. Quiet by
  default (first-notice suppressed; only CTA escalations surface).
- **Config:** two new `monitoring.*Sentinel` keys, default-on, applied to
  existing agents via the standard `applyDefaults` migration path.
- **Persistent state:** none — both sentinels keep in-memory state only.
- **Timing:** socket scan 15s, silence walk 60s; each captures ~40 lines of
  tmux output per running session per tick. Same order of cost as the existing
  SessionMonitor poll.

## 7. Rollback cost

- Per-sentinel config kill-switch:
  `monitoring.socketDisconnectSentinel.enabled=false` /
  `monitoring.activeWorkSilenceSentinel.enabled=false` — no release needed.
- Code rollback: revert the `server.ts` wire-up block + `sentinelWiring.ts` +
  the `SocketDisconnectSentinel` start/stop additions. No persistent state to
  clean up.

## Conclusion

Makes the silently-stopped trio actually run, which the prior PR claimed but did
not do. Adds the wiring-integrity + semantic tests the Testing Integrity
Standard requires for dependency-injected components, plus an integration test
that drives both sentinels end-to-end through the tone-gated `/attention` path.
No new blocking authority; default-on with per-sentinel kill switches.

Clear to ship pending second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent review subagent, 2026-05-23

**Verdict: Concur with the review**, with one substantive correctness finding
that has been fixed in this PR.

- Confirmed both sentinels are constructed AND `.start()`-ed, guarded by
  default-on kill switches matching the RateLimitSentinel idiom. Not dead code.
- Signal-vs-authority holds: escalations route through `/attention`; the
  detectors hold no blocking authority. The `=== 201` success check is correct.
- Intervals are unref'd; `OutputActivityTracker` prunes ended sessions (no Map
  leak). Bare-Enter recovery is alive-gated and the right choice over Ctrl+C.
- **Finding (FIXED): framework was never populated.** The draft read a
  non-existent `sess.framework` field, so `looksActivelyWorking` always used
  claude-code patterns — a Codex session's spinner would be classed idle and
  skipped. Resolution: added `SessionManager.frameworkForSession` (public
  accessor over the existing per-session framework cache) and plumbed it into
  the session surface; removed the `as`-cast. Codex coverage now works.
- Over-fire risk assessed low and acceptable: a slow-but-alive tool call
  re-renders its spinner/token count → hash changes → `lastOutputAt` resets, so
  it won't trip; idle-at-prompt is `paused`; a frozen non-active frame is
  skipped by design and covered by the other watchdogs.

---

## Evidence pointers

- Tests: `tests/unit/monitoring/sentinelWiring.test.ts` (24),
  `tests/unit/monitoring/SocketDisconnectSentinel.test.ts` (+3 loop tests),
  `tests/integration/silently-stopped-trio-wiring.test.ts` (3).
- The gap: `grep -rln SocketDisconnectSentinel src | grep -v 'SocketDisconnectSentinel.ts'`
  returned nothing before this change.
