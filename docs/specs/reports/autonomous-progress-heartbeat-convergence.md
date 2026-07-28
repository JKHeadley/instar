# Convergence Report — Autonomous-Session Progress Heartbeat

## Cross-model review: codex-cli:gpt-5.5

A real external (non-Claude) pass RAN. Both GPT-5.5 (codex) and Gemini-2.5-pro (gemini) reviewed the converged spec; both returned "MINOR ISSUES" only, and every minor item was folded. (This is the clean RAN state — no ⚠.)

## ELI10 Overview

When the agent runs a long autonomous job, it sometimes goes heads-down for a long stretch doing real work but never messages the operator. An hour of silence looks exactly like a crash — which is precisely what happened on 2026-06-16, when the operator had to ask "did you stall?" The agent is *told* to report every ~30 minutes, but that's just an instruction it forgets when absorbed. This feature is the structural backstop: a small background watcher that, only when the agent has genuinely gone quiet on the operator for a long while *and* the terminal shows fresh output (real work, not a frozen spinner), posts ONE short, honest, hedged line — "I haven't posted here in a while — last observed activity was «…»; message me if you need me." It ships off for the whole fleet and starts in dry-run even on a development agent.

The single most important thing the review changed: the first design was a simple timer that posted "Still working — N min since my last update." Six internal reviewers and two external models all caught that this would **re-create the exact low-information filler that an earlier approved piece of work (HONEST-PROGRESS-MESSAGING) had deliberately deleted** — a periodic "still working" line trains the operator to ignore the channel. So the design was pivoted from a chatty timer into a rare, honest safety net: it fires on real silence + real output movement (not a clock), the wording is purely observational (it never claims progress), and it's hard-capped at ~6 lines per run.

The tradeoffs, plainly: it watches by reading the terminal screen (brittle and a minor performance cost — accepted because it reuses an existing watcher's screen snapshot and matches the established pattern; structured liveness events over IPC are the better long-term path, noted as future work). And across multiple machines, its one-voice lock is local-only, so a coordinated handoff uses file markers + a warmup timer that aren't perfectly airtight — a rare duplicate line is possible, which is low-harm because the feature only ever ADDS a hedged line. Both are written down as accepted residual risks, not hidden.

## Original vs Converged

- **Originally**, the feature was a cadenced timer that asserted "Still working — N min since my last update" and leaned on the existing 15-minute duplicate-suppressor for flood safety. **After review**, it was rebuilt as a hedged, change-gated, sparse backstop: the duplicate-suppressor was proven inert here (the text varies every time, so it never matches) and replaced with three real throttles (a long user-silence gate, a per-conversation cooldown, and a widening per-run backoff with a hard ~6-line cap).
- **Originally**, it fired off an instantaneous "is a spinner on screen" check — which a frozen, wedged session also shows. **After review**, it requires the terminal's scrollback to have genuinely *changed* recently (renamed `recentOutputChange` to make clear it proves output moved, not that work is progressing), so it can't falsely claim a wedged session is alive.
- **Originally**, the focus text was sent to the operator verbatim. **After review**, it is scrubbed for secrets/paths, length-capped, escaped, and framed as quoted untrusted context — closing a leak + injection vector on what is otherwise the least-reviewed outbound path.
- **Originally**, it claimed "machine-local by design, no defect." **After review**, that overclaim was corrected: the one-voice lock is local-only, so cross-machine handoffs are guarded with a mid-move marker + a destination warmup grace, and the residual race is documented as accepted low-harm.
- **Originally**, dry-run would have flooded the logs every tick (no send → silence clock never reset). **After review**, dry-run exercises the same local cooldown so it's a faithful, quiet preview.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration/multi-machine, decision-completeness, lessons-aware | 11 (2 CRITICAL, 5 HIGH, 4 MED) | Full redesign: hedged backstop, real throttles, scrub, movement-gate, cross-machine guards, predicate ordering, migration-no-enabled, Frontloaded Decisions |
| 2 | lessons-aware, adversarial + cross-model (gpt-5.5, gemini-2.5-pro) | 0 material (3 LOW + 2 external MINOR) | Wording purely observational; `outputMovement`→`recentOutputChange`; shared-snapshot (drop maxCapturesPerTick); per-run-cap safety note; multi-machine + tmux-scrape residual-risk acknowledgments |
| 3 | (converged) | 0 | none |

Standards-Conformance Gate: unavailable (server timeout, fail-open) — recorded honestly; not authoritative this run.

## Full Findings Catalog

**Round 1 (material, all resolved):**
- [CRITICAL · lessons-aware] Re-creates the suppressed §B1 "still working" filler → redesigned as hedged, change-gated, per-run-bounded backstop with explicit reconciliation table.
- [CRITICAL · adversarial/lessons] `OutboundContentDedup` is inert (varying text never fingerprint-matches) → removed from the safety argument; replaced with silence-gate + per-topic cooldown + per-run backoff/cap.
- [HIGH · security] Unscrubbed LLM-derived `focus` leaks secrets/paths + injection on the tone-gate-skipped path → deterministic credential/path scrub + length-clamp + escape + untrusted framing, applied before message AND status route.
- [HIGH · adversarial/lessons] `looksGeneratingNow` false-positives on a frozen spinner → gate on `recentOutputChange` (scrollback hash advanced), spinner-immune.
- [HIGH · adversarial] Silence-clock self-reset undocumented; dry-run floods every tick → explicit reset on ANY outbound; dry-run gates on local cooldown.
- [HIGH · integration] Cross-machine double-voice (lease is local-only) → `moved_to`-marker skip + destination warmup grace; corrected the "no defect" overclaim.
- [MED · scalability] Predicate order, event-loop-blocking capture, unbounded `lastEmits`, re-entrancy → cheap-first ordering, shared snapshot, ring-buffer, ticking guard.
- [MED · adversarial/integration] Lease leak permanently silences a topic → acquire/release in try/finally within one tick.
- [MED · integration] Migration writing `enabled` pins dev agents dark → backfill omits `enabled` (dev-gate decides).
- [MED · decision-completeness] Graduation criterion + cadence unstated → `## Frontloaded Decisions` (threshold 25, tick 60s, message shape, graduation gate, focus cap).
- [MED · lessons] Per-topic per-run message-volume unbounded → widening backoff + hard cap.

**Round 2 (LOW/MINOR, all folded):**
- [LOW · adversarial] `maxCapturesPerTick` unenforceable → read sentinel's shared snapshot (zero extra capture cost); knob removed.
- [LOW · adversarial] Per-run-cap-then-stall seam → noted stall is owned by ActiveWorkSilenceSentinel (disjoint trigger).
- [LOW · adversarial] Handoff double-silence gap → noted as accepted under-fire (continuity is the resume path's job).
- [MINOR · gpt-5.5] "Still going" still asserts → purely observational wording. "output movement" implies progress → renamed `recentOutputChange`. Handoff not airtight → residual risk stated.
- [MINOR · gemini-2.5-pro] tmux screen-scrape is brittle; local-only lock → architectural-tradeoff/future-work note (IPC liveness events long-term), accepted for dark-shipped v1.

## Convergence verdict

Converged at iteration 3. No material findings in the final round; both internal re-reviewers and both external models confirmed the round-1 criticals resolved with no new material issues. Zero unresolved user-decisions (all resolved into Frontloaded Decisions). Spec is ready for user review and approval.
