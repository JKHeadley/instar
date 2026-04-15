# Side-Effects Review — Retrospective: pre-respawn drain + post-mistake principle

**Version / slug:** `retrospective-drain-and-principle`
**Date:** `2026-04-15`
**Author:** Echo (autonomous, forward-plan Track 2 — T2.6 + T2.7)
**Second-pass reviewer:** not required (lifecycle helper + scaffold-only template change; neither introduces block/allow surface)

## Summary of the change

This is a **retrospective** side-effects review, covering two changes that shipped in commit `903233b` (the original 0.28.43 rework commit) before the `/instar-dev` skill existed. Neither change is being modified by this artifact — the artifact exists solely to document the side-effects review, bringing these commits into compliance with the new process retroactively.

The two changes under review:

1. **Pre-respawn drain in `src/monitoring/SessionRecovery.ts`** — when context exhaustion is detected and the dying session is killed, the new code polls topic history for up to 7 seconds watching for an in-flight reply that lands AFTER detection. If captured, the reply text is embedded in the fresh session's bootstrap prompt with explicit "do NOT repeat any of it" instruction.

2. **Post-mistake principle in `src/scaffold/templates.ts`** — adds a principle to the agent scaffold template: "default response to a caught mistake is root-cause + concrete fix, never an apology alone." This is a documentation-level change to the template that new scaffolded agents inherit.

## Decision-point inventory

**Change 1 — pre-respawn drain:**
- No decision points added, removed, or modified in the signal/authority sense.
- The drain is a lifecycle helper that **produces context** (the in-flight reply text) for downstream prompt assembly. It has no block/allow authority.

**Change 2 — post-mistake principle in template:**
- No decision points. Documentation-only scaffold change. Effect is that new agents include this principle in their initial AGENT.md.

---

## 1. Over-block

**Change 1 (drain):** no block surface — drain cannot over-block anything. It either captures a reply or doesn't; failure to capture falls back to the pre-existing recovery prompt. Worst case, the fresh session sees no `<previous_reply>` context and duplicates the reply — identical to pre-drain behavior.

**Change 2 (principle):** no block surface.

## 2. Under-block

**Change 1 (drain):** the drain cannot catch a reply that lands AFTER the 7-second grace window. Empirically, in-flight replies observed during the 2026-04-15 incident landed within 2–6 seconds of kill; 7s covers the common case. A reply that takes longer than 7s to land would escape the drain and the fresh session would duplicate — same as pre-drain behavior. Documented as a known trade-off; no regression.

**Change 2 (principle):** a principle in the template doesn't guarantee behavior compliance. It's guidance, not enforcement. The structural enforcement for post-mistake behavior is elsewhere (or not yet) — out of scope for this change.

---

## 3. Level-of-abstraction fit

**Change 1 (drain):** the right layer. `SessionRecovery.recoverFromContextExhaustion` owns the post-kill/pre-respawn window. The drain is a helper private to that flow. Generalization to other recovery paths would be premature — different recovery types (crash, stall, error-loop) have different windows and signals.

**Change 2 (principle):** scaffold templates are the right place to seed new-agent behavior. No alternative layer is more appropriate.

---

## 4. Signal vs authority compliance

**Reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Change 1 (drain):**
- [x] No — this change has no block/allow surface. The drain is a context-producing helper that informs a downstream prompt (fresh session's bootstrap), not a judgment gate.

**Change 2 (principle):**
- [x] No — pure documentation.

Both changes are compliant. Neither introduces the pattern the principle was written to prevent.

---

## 5. Interactions

**Change 1 (drain):**
- **Coupling:** introduces a new optional dep `getRecentTopicMessages` on `SessionRecoveryDeps`. Wired from server startup. If the dep is absent, the drain falls back to the legacy 3-second static delay — behavior identical to pre-drain code.
- **Race with cleanup:** the drain holds the fresh-session spawn for up to 7 seconds. During that window, any code that cleans up based on "session is dead" (stale-session cleanup, injection tracker expiry, etc.) must not race with the drain. The drain is synchronous with respect to `recoverFromContextExhaustion`; nothing else is operating on the same session ID in that window by construction.
- **27 unit tests** in `tests/unit/context-exhaustion-recovery.test.ts` exercise drain timing, empty-window fallback, in-flight capture, recovery-prompt assembly with the captured reply, and respawn-fresh vs legacy respawn paths. All pass.

**Change 2 (principle):**
- Purely a template edit. New agents get the principle in their AGENT.md at scaffold time. Existing agents are unaffected.

---

## 6. External surfaces

**Change 1 (drain):**
- **Agents:** improves recovery quality — fewer duplicate replies post-compaction. User-visible: the new bootstrap message explicitly acknowledges the prior reply, so the agent's first post-compaction response can reference what was already said rather than reconstruct it.
- **External systems:** none.
- **Persistent state:** none new. Reads existing topic history.
- **Timing:** adds up to 7 seconds to the post-kill pre-spawn window.

**Change 2 (principle):** zero external impact until a new agent is scaffolded.

---

## 7. Rollback cost

**Change 1 (drain):** low. Revert the `SessionRecovery.ts` diff; the legacy 3-second static delay restores pre-drain behavior exactly. No data migration.

**Change 2 (principle):** low. Revert the `templates.ts` diff. Existing agents scaffolded with the new template keep the principle in their AGENT.md until someone edits it; that's cosmetic, not functional.

---

## Conclusion

Both changes are principle-compliant and ride through this retrospective review cleanly. No decision-point violations, no over-block risks, no under-block regressions vs pre-change behavior. The drain's 7-second window is a known trade-off documented in the code. The post-mistake principle is documentation-level and cannot introduce any runtime regression.

**Status:** already committed in `903233b` (pre-skill). This artifact completes the review record retroactively so future audits can trace the rationale.

Live end-to-end verification of the drain still requires a natural context-exhaustion event to produce the full positive-path trace — the gap honestly documented in the original upgrade-guide draft. The pre-commit + pre-push gates will require this artifact for any FUTURE change to these files.

## Second-pass review

**Not required.** Per `/instar-dev` skill Phase 5 criteria, second-pass is triggered for block/allow decisions on messaging/dispatch/session lifecycle gates. The drain is not a gate — it's a context-producing helper within an existing lifecycle flow. The principle is a template doc edit. Neither qualifies.

## Evidence pointers

- `tests/unit/context-exhaustion-recovery.test.ts` — 27 unit tests covering the drain helper's behavior under varied conditions. All pass as of commit `c204b68`.
- Original commit `903233b` — contains the full code change.
- Live verification is pending a natural context-exhaustion event; the CompactionSentinel's structured log will produce the first real trace when it fires.
