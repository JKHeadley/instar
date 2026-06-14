# Side-Effects Review — Honest progress messaging (silent-freeze watchdog + promise-beacon truthfulness)

**Version / slug:** `honest-progress-messaging`
**Date:** 2026-06-13
**Author:** echo
**Second-pass reviewer:** required (touches sentinel/watchdog + outbound-messaging decisions) — see below

## Summary of the change

Two background notifiers were posting frequent, falsely-confident noise into whatever Telegram topic the user was in, because both judged "work" by whether the tmux *screen* repainted — a busy long-task session looks byte-identical to a frozen one. This change makes both honest without changing their authority (both remain pure signals — they decide whether to *notify*, never to block or gate).

- **ActiveWorkSilenceSentinel** (`src/monitoring/ActiveWorkSilenceSentinel.ts`): before claiming a session is stuck, it now re-captures the *live* frame and corroborates — if the frame still shows an active-work indicator (strict "generating now": spinner / "esc to interrupt" / running), or a sub-agent is live, or it's a clean idle prompt, it suppresses instead of crying wolf. The whole corroboration path **fails closed** (any error → suppress, never a false "it's stuck"). Threshold raised 15m→30m. A 90-minute frozen-byte-identical-frame backstop (A5) keeps a genuine mid-tool hang from being permanently invisible. Wording is now evidence-with-uncertainty ("hasn't changed in N min and a nudge didn't wake it — it may be stuck, or on a long task I can't see into. Want me to check?"), never an asserted "it's stuck."
- **PromiseBeacon** (`src/monitoring/PromiseBeacon.ts`): the "still on it, no new output" filler is suppressed by default (it carried zero information). The beacon now speaks only on genuine new output (LLM-summarized), deadline pressure (B1a), a sparse once-per-60m liveness line (B1b, so long tasks aren't fully dark), or a one-shot turn-finished close-out (B2/FD-1: after N=3 idle-frame checks, "that work's session has wrapped — pick it back up, or close this out?" then auto-pause). Base cadence relaxed 10m→20m. `heartbeatCount` now counts only messages actually sent.
- **SubagentTracker** (`src/monitoring/SubagentTracker.ts`): adds an O(1) `hasActiveSubagents(sessionId)` index read so the sentinel's per-tick corroboration stays cheap.
- **Wiring** (`src/monitoring/sentinelWiring.ts`, `src/commands/server.ts`): new `looksGeneratingNow()` strict detector; SubagentTracker construction moved *before* the silently-stopped trio block so the sentinel can read sub-agent liveness; quoted dynamic text routed through `guardProxyOutput()`/`friendlyName()` sanitization; observability funnel events mapped onto the existing `sentinel-events.jsonl` notifier.

This PR ships the full converged scope (A, B, C, D, E):
- **C (docs alignment):** `generateClaudeMd()` (`src/scaffold/templates.ts`) gains an "Honest progress messaging" subsection; a content-sniffed `migrateClaudeMd` entry appends it to existing agents; `docs/specs/silently-stopped-trio.md` gets a correcting note.
- **D (config surface + migration parity):** the five operator-tunable / rollback keys are added to `ConfigDefaults.ts` as SSOT (at the paths the runtime actually reads — `monitoring.activeWorkSilenceSentinel.*` and TOP-LEVEL `promiseBeacon.*`, NOT the `monitoring.promiseBeacon.*` the spec prose stated — corrected against the real read site), and a `PostUpdateMigrator` step `honest-progress-messaging-defaults` backfills them existence-checked + idempotent + audited (`migrateHonestProgressMessagingDefaults`). New unit test `tests/unit/PostUpdateMigrator-honestProgressMessaging.test.ts` covers the SSOT presence, fresh backfill, override preservation (incl. the `suppressUnchangedHeartbeats:false` rollback), idempotency, no-config/corrupt-config paths, and the CLAUDE.md append.

Spec: `docs/specs/HONEST-PROGRESS-MESSAGING-SPEC.md` (review-convergence 2026-06-13, approved by Justin via topic 25120).

## Decision-point inventory

- `ActiveWorkSilenceSentinel.escalate()` — **modify** — was "threshold + failed-nudge → escalate"; now "threshold + failed-nudge + live-frame corroboration → escalate, else suppress." Still a signal (it asks the user a question); no blocking authority added or removed.
- `ActiveWorkSilenceSentinel` A5 frozen-indicator backstop — **add** — new escalation path bounded by `activeWorkMaxFrozenIndicatorMs` (90m default) so A1 suppression can't hide an infinite hang.
- `PromiseBeacon.checkOne()` send decision — **modify** — was "send a templated line every tick"; now "send only when there is something true to say." Still a signal; the user-facing surface is a notification, never a gate.
- `PromiseBeacon` turn-finished close-out (B2) — **add** — one-shot close-out + auto-pause; non-terminal (status stays `pending`, resume re-arms).
- `SubagentTracker.hasActiveSubagents()` — **add** — pure read, no decision surface of its own; feeds the sentinel.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — these are notifiers, not gates; "over-block" maps to "wrongly stays silent (false negative)." The deliberate trade is fewer false alarms at the cost of some added latency on a real freeze:

- A session that genuinely freezes *mid-tool with the active-work indicator still painted on screen* is suppressed by A1 until the 90-minute A5 backstop fires. This is the accepted, bounded false-negative (convergence finding; tunable via `activeWorkMaxFrozenIndicatorMs`). Before this change it would have surfaced at ~15m; now a genuine hang of this specific shape surfaces at ≤90m, clearly hedged.
- The promise beacon will stay silent on a long task that produces no new terminal output for up to 60m between sparse-liveness lines. A user who *wanted* a 10-minute "still working" ping no longer gets it (that was the noise they asked to remove; rollback via `suppressUnchangedHeartbeats:false`).

---

## 2. Under-block

**What failure modes does this still miss?**

Mapped to "still fires when it shouldn't" / "still misses a real wedge":

- The "generating now" detector is regex over the live frame. A framework whose spinner/interrupt markers aren't in `getActivitySignal()` would read as "not generating," so a long task on that framework could still draw a (now-hedged, 30m, corroborated-by-absence-of-sub-agent) escalation. The wording is honest about the uncertainty, so this is a softened false positive, not a confident one.
- A2(b) clean-idle-prompt detection (`isCleanIdlePrompt`) is **not wired** in server.ts — the indeterminate branch instead relies on "no active-work indicator + no live sub-agent." A finished turn sitting at a clean prompt is normally caught earlier by the tracker's `paused` flag; if it isn't, it falls to the honest hedged ask rather than a false "stuck." Acceptable degradation (spec-declared).
- The frozen-frame hash (FNV-1a) detects byte changes only; a session repainting an identical-looking but byte-different frame (e.g. a moving clock) resets the A5 timer, extending the backstop. Accepted — A5 is a backstop, not the primary path.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Correct layer. Both components are existing low-level *detectors that surface signals to the user* — they do not gate agent behavior, so the smart-gate-authority pattern doesn't apply (there is no downstream authority to feed; the "consumer" is the human). The change keeps them as detectors and makes the detector honest: it adds *more* corroborating signals (live-frame generating-now, sub-agent liveness, idle-prompt) before the detector speaks, and lowers its confidence in the wording. The strict `looksGeneratingNow()` is correctly separated from the broad `looksActivelyWorking()` (which matches scrollback-persistent tool names) — using the broad one here would re-introduce the false-positive (a frozen pane full of past `Read(`/`Bash(` is not "generating now"). The O(1) `hasActiveSubagents` read is the right primitive to add to SubagentTracker rather than re-deriving liveness in the sentinel.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface. Both ActiveWorkSilenceSentinel and PromiseBeacon are signal producers: their output is a user-facing notification (a question / a status line), never a 4xx block, a message filter, or an action gate. The new brittle detectors (`looksGeneratingNow`, frame hashing, `hasActiveSubagents`, idle-prompt) are used *to suppress the signal* (reduce false alarms) and to *hedge the wording* — the strictly safe direction. They never acquire authority to block anything an agent or user does. This is exactly the principle's intended shape: brittle detectors feeding a low-stakes notification decision, with the conservative default being silence.

The parent-principle frontmatter on the spec is "Signal vs. Authority" with the note that both systems stay signal-only while the signal itself becomes honest. Confirmed against the code: no new throw/block path; every corroboration error routes to suppression.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** The corroboration runs *inside* `escalate()`, after the existing nudge/verify ladder, so it doesn't shadow the auto-recovery path (which still runs first when `autoRecover` is on, in `proceedEscalation`). A `suppressed-active` session is re-evaluated each tick (it is not cleared while still past threshold), so suppression cannot permanently mask the auto-recovery ladder either — A5 eventually routes back through `proceedEscalation`.
- **Double-fire:** The sentinel's `suppressed-active` state is held in `states` so a suppressed session does not re-`report()` every tick (the `existing` guard). The map is cleared when the session drops below threshold (frame changed) or ends, preventing a leak. PromiseBeacon advances `lastHeartbeatAt` on every check whether or not a message was sent, so a suppressed tick can't tight-loop on a stale cadence anchor.
- **Races:** SubagentTracker construction order moved earlier in `startServer`; verified no consumer between the old and new construction site references `subagentTracker` (it was previously built *after* the trio block and only used downstream). The `hasActiveSubagents` read is against an in-memory index — no file race.
- **Feedback loops:** None. The observability `recordEvent` writes to `sentinel-events.jsonl` via the notifier; it does not feed back into the escalation decision. `recordEvent` is best-effort and never throws into the sentinel.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other users (install base):** Yes — this is a fleet change. Every instar agent's two noisiest notifiers go quiet-by-default. This is the intended, operator-approved behavior change. The new strings are user-visible; they were signed off verbatim in topic 25120.
- **Telegram:** message *volume drops*; message *shape* changes (hedged wording, close-out prompt). No new topic creation — all sends route through the existing per-topic / lifeline paths, so the topic-flood guards are unaffected.
- **Persistent state:** PromiseBeacon hot-state gains `lastLivenessAt` and `consecutiveTurnFinished` (additive, optional fields — old hot-state files load fine). Commitment `beaconPausedReason: 'turn-finished'` is a new reason string (additive). `sentinel-events.jsonl` gains new funnel detail strings (additive). No migration needed for these; the **config** additions (`suppressUnchangedHeartbeats`, `beaconLivenessIntervalMs`, `turnFinishedCloseoutChecks`, `activeWorkMaxFrozenIndicatorMs`, `silenceThresholdMs` default change) are read with `??` fallbacks so absent config preserves the new defaults — the spec's D-section migration adds them existence-checked so operator overrides survive.
- **Operator surface (Mobile-Complete Operator Actions):** No new operator-facing action. The only levers are config keys (opt-out / tuning), which the operator already edits via the Files dashboard tab or conversationally. No PIN-gated route added.
- **Timing/runtime:** The corroboration depends on live tmux capture, which can transiently fail — handled by fail-closed suppression. A5's 90m and B1b's 60m are wall-clock windows; both are operator-tunable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: machine-local BY DESIGN.**

Both notifiers observe *local* tmux sessions on the machine they run on — a session's liveness, its sub-agents, and its frozen-frame timer are inherently machine-local truths (the session exists on exactly one machine's tmux server). There is nothing to replicate or proxy: machine B has no business judging machine A's session liveness, and the one-awake-machine lease already ensures only the serving machine drives user-facing notifications for a given topic. The corroboration reads (`captureFrame`, `hasActiveSubagents`) are against this machine's session surface and in-memory tracker by construction.

- **User-facing notices / one-voice:** Both route through the existing serving-machine notification paths (the lease holder owns the topic's voice), so the existing one-voice gating applies unchanged — this change *reduces* the number of notices, it doesn't add a new emitter that could double-fire across machines.
- **Durable state on topic transfer:** PromiseBeacon hot-state and commitments already ride the existing commitment/working-set carriers on transfer; the additive fields (`lastLivenessAt`, `consecutiveTurnFinished`) are non-critical and self-heal (worst case: one extra liveness line or close-out check after a move). No new stranding risk.
- **Generated URLs:** None generated.

---

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change with config-flag rollbacks — cheap and fast:

- **Promise beacon:** set `promiseBeacon.suppressUnchangedHeartbeats: false` to restore the legacy every-tick templated heartbeat immediately, no deploy needed (read live at next beacon construction; restart sessions to apply).
- **Watchdog:** raise `silenceThresholdMs` back to `900000` and/or rely on the legacy no-capture path. If the corroboration itself is suspect, the legacy behavior is reachable by not wiring `captureFrame` — but the cleaner back-out is a code revert.
- **Full revert:** revert the commit and ship as a patch. No persistent-state migration to unwind (all state additions are additive/optional and ignored by old code). No agent-state repair. No user-visible regression during the rollback window beyond returning to the old (noisier) behavior.

---

## Conclusion

The review produced no design changes — the convergence pass (iteration 2, zero material findings) had already closed the substantive gaps this review re-checks: the permanent-blind-spot (A5 backstop), long-task-invisibility (B1a/B1b), sanitization (FD-7), wiring order, fail-closed corroboration (FD-6), and observability. The implementation matches the converged spec: both components stay strictly signal-only, every error path fails toward silence (the safe direction for a notifier), and the only persistent-state changes are additive and backward-compatible. The change is clear to ship pending the required second-pass review below.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (audited the five diffs against `docs/signal-vs-authority.md` and the framework activity-signal regex defs)
**Independent read of the artifact: CONCUR**

The reviewer independently verified the artifact's core claims against the real source:

- **Signal vs authority — pure-signal confirmed.** No new path acquires blocking authority. `escalate()` ends only in `notify()` or suppression — no throw / 4xx / message-drop. PromiseBeacon's `text != null` send-gate only decides notify-vs-silent. All new brittle detectors are used to suppress/hedge (the safe direction).
- **Fail-closed — confirmed.** Every corroboration error path (capture-throw, empty-frame, `looksActivelyWorking`-throw, `hasActiveSubagents`-throw) routes to `markSuppressedActive(state, undefined)`, which explicitly does NOT arm A5 ("don't arm A5 on bad evidence") — so no error path can escalate on bad evidence. The observability funnel is log-only, never Telegram.
- **No state leak / no double-fire; A5 not permanently maskable.** A `suppressed-active` session is re-evaluated every tick so A5's 90m backstop can't be hidden by A1; A5 fires once then `escalated` short-circuits re-fire; the cleanup loop clears suppressed states that drop below threshold. A5's primary target (a STATIC `esc to interrupt`/`(running)` indicator) keeps a byte-stable frame so the timer accumulates correctly.
- **PromiseBeacon cadence + close-out correct.** `lastHeartbeatAt` advances on every check (sent or suppressed) so a suppressed tick cannot tight-loop on a stale anchor; `heartbeatCount` increments only on real sends; `closeOutTurnFinished` auto-pauses without re-arm.
- **Wiring correct.** Both components are wired to the STRICT `looksGeneratingNow`; the broad scrollback-matching `looksActivelyWorking` is never passed to either — confirmed against the regex defs, so the original false positive is not reintroduced.

Two minor non-blocking notes (no action required, recorded as accepted): (1) `isCleanIdlePrompt` is intentionally unwired and degrades safely to the hedged ask (declared in §2); (2) the `resumed` handler resets `consecutiveUnchanged` but not `consecutiveTurnFinished`, so a resume on a still-finished session may emit its close-out on the first post-resume check rather than after N more — harmless (it just re-pauses, no loop). Verdict: clear to ship.

---

## Evidence pointers

- Build: `pnpm build` clean in worktree `~/.instar/agents/echo/.worktrees/honest-progress-messaging`.
- Targeted unit tests (18 passing): `tests/unit/ActiveWorkSilenceSentinel-honest.test.ts` (7), `tests/unit/PromiseBeacon.test.ts` (5, incl. B1 suppress + B1 rollback), `tests/unit/PromiseBeacon-ux-fixes.test.ts` (6).
- Convergence report: `docs/specs/reports/HONEST-PROGRESS-MESSAGING-SPEC-convergence.md`.
