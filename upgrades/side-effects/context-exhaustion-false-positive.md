# Side-effects review — context-exhaustion false-positive fix

**Change:** `detectContextExhaustion` (QuotaExhaustionDetector) now requires the
real CLI error framing ("press esc twice" or "error during compaction") for the
bare "conversation (is) too long" phrase. The bare phrase as content no longer
matches.

**Signal vs authority (Phase 1):** This IS a decision point — the detector's verdict
gates a destructive action (SessionMonitor kills + respawns the session and notifies
the user). It is a SIGNAL feeding the SessionMonitor authority; this change makes the
signal correct, it does not add or move authority. The fix narrows a brittle
substring match that was producing false positives with blocking-equivalent
consequences (forced respawns + user notices) — exactly the "brittle check with
real-world authority" failure `docs/signal-vs-authority.md` warns about.

1. **Over-block (false positive — the bug):** FIXED. Before, the bare phrase as
   content (a session discussing the failure mode, a quoted error, or the recovery
   notice itself) was flagged as live exhaustion → spurious respawn + user notice,
   self-amplifying into a flood (RUN-2 2026-06-06, topic 13435, ~27 notices on a
   healthy session). Now the bare phrase without CLI framing is not matched.

2. **Under-block (could a REAL error now be missed?):** No real loss. Every
   realistic exhaustion fixture in the unit tests carries the CLI framing ("press
   esc twice" and/or "error during compaction") — that is how Claude Code actually
   renders the error. The guard only removes matches that lack any framing, which
   are content, not live errors. Residual: if a future Claude Code version renders
   the error WITHOUT the esc hint or compaction line, it would be missed — the frame
   list is a one-line extension and is documented as the tuning point.

3. **Level-of-abstraction fit:** Correct layer. The fix is in the detector (the pure
   function that decides), not in SessionMonitor (the actor). One change fixes every
   consumer (SessionMonitor, PresenceProxy standby). The soft, non-phrase patterns
   (context limit, token limit) are deliberately left unchanged — they are not the
   observed bug and gating them risks under-detection; scoped to the live bug, not
   a hypothetical.

4. **Signal vs authority compliance:** Compliant. Detector stays a signal; the fix
   reduces its false-positive rate without changing where authority lives.

5. **Interactions:** The same `detectContextExhaustion` feeds SessionMonitor's
   proactive check and PresenceProxy. Both now benefit. The self-amplification path
   (recovery notice → pane → re-detect) is closed because the notice lacks CLI
   framing. classifySessionDeath (the POST-death classifier) shares the bare-phrase
   pattern but runs on a dead session's final output where the flood/respawn harm
   does not apply; left as-is to keep this fix scoped to the live false-positive
   (noted as a known sibling, not a deferral of THIS bug).

6. **External surfaces:** Reduces user-facing noise (fewer false "conversation too
   long" notices). No API/schema change. Behavior depends on tmux pane content,
   which is what it already read; no new timing/runtime dependence.

7. **Rollback cost:** Trivial — revert the commit. Pure-function change, no data
   migration, no state. Worst case on revert is the original false-positive returns.

**Tier:** 1 (a guard added to one pure function + realistic test fixtures; no route,
no migration, no persistent state). No CLAUDE.md template change: this is an internal
detector hardening, not a new agent-invocable capability.

**No deferrals:** the fix is complete — detector guard + both-sides unit coverage
(real-error-detected, bare-phrase-rejected, recovery-notice-rejected, narration-
rejected, mixed-pane-still-detected) + updated realistic fixtures. classifySessionDeath
is a distinct surface (post-death), not a withheld part of this fix.
