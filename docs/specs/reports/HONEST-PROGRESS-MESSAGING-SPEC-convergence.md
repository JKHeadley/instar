# Convergence Report — Honest progress messaging

## Cross-model review: gemini-cli:gemini-2.5-flash

A real external (non-Claude) review ran. Round 1's gemini pass degraded (a transient gemini-cli classifier error returning invalid JSON — not a spec issue); round 2's gemini-2.5-flash pass succeeded on the updated spec and returned verdict **converged-ready** with only minor findings (a duplicate header and an extend-fail-closed suggestion), both since fixed. codex-cli was unavailable on this machine (not installed) — gemini-cli is the genuine external opinion of record. Per the round-aggregation rule, one successful external pass earns the clean RAN flag.

## ELI10 Overview

Two of the agent's background systems message you inside topics, and both were lying without meaning to. The "silent-freeze watchdog" pinged you ("X went quiet — want me to dig in?") whenever a session's terminal screen stopped repainting for 15 minutes — but a session running a long build or sub-task shows a frozen-looking screen *while genuinely working*, so it cried wolf constantly. The "promise beacon" (the ⌛ messages) pinged you every ten minutes while a promise was open — "still on it, no new output" — which carried no real information and kept firing for tasks you'd long forgotten.

This change makes both quiet and truthful. The watchdog now checks whether the session is *actually* still working (a live "working / press-to-interrupt" indicator, or a running sub-task) before it says anything; if it's genuinely busy it stays silent. It only speaks when the evidence really points to a hang — and even then it says so honestly ("may be stuck, or on a long task I can't see into"). The promise beacon goes silent whenever nothing real changed, speaking only on genuine progress, a deadline, a rare hourly "still alive" check on long tasks, or to close out a finished promise. In normal use you'll mostly stop seeing both — they now earn the right to speak.

The main tradeoff: a genuinely hung session that keeps a frozen "working" indicator on screen surfaces 90 minutes later instead of 15. That's deliberate — the old 15-minute alerts were almost always false, so waiting for stronger evidence is the honest trade. Everything ships to every agent in the fleet on update, and the old behavior is recoverable with an explicit config switch.

## Original vs Converged

The original spec had the right *intent* (corroborate before alerting; go silent when nothing changed) but left critical decisions and safety gaps open. Review hardened it on six fronts:

- **It would have created a permanent blind spot.** Suppressing every alert when a "working" indicator is present means a session that *hangs while frozen mid-tool* would never surface. Added **A5**: a 90-minute frozen-byte-identical-frame backstop that escalates with an extra-hedged message. The false negative is now bounded, not infinite.
- **It would have gone fully dark on long tasks.** "Silent when unchanged" meant a three-hour quiet task produced zero signal. Added **B1b** (a sparse, once-per-hour "still watching" line) and **B1a** (a deadline-pressure exception that breaks silence when a hard deadline is near).
- **Three decisions would have stopped the build to ask.** The "N consecutive checks" before closing a promise, what counts as a "live sub-agent," and which "stuck signatures" to enumerate were all unresolved. Now frontloaded: **N=3**, "live = any sub-agent with no stop record," and the vague signature path was **deleted** in favor of one conservative all-conditions-must-hold rule.
- **It could have leaked or been spoofed.** The messages quote session names and promise text (LLM/user-originated) without sanitization. Now all quoted dynamic text runs through the existing output guard before embedding.
- **It would have failed silently at wiring time.** The sub-agent tracker the new check depends on was constructed *after* the watchdog in server startup. The fix reorders construction, and the whole escalation path now fails *closed* (stay silent on any error) rather than risking a false "it's stuck."
- **It had no way to prove it worked.** Added observability counters for every suppression and every fire, so the false-positive-rate drop is measurable instead of assumed.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware; gemini (degraded) | ~14 material (3 decision blockers, 6 integration blockers, 2 adversarial false-neg/invisibility, security sanitization, observability gap, foundation note) | A2 rewritten (single conservative condition; fail-closed; capture-once), added A5, B1a, B1b, B5; expanded D (5 config keys + existence-checked migration + wiring-order + O(1) getter); added E (observability), Frontloaded Decisions FD-1…FD-8, Known limitations; rewrote Testing with the bug-reproduction case |
| 2 | gemini (ran: 3 minor — dup header, extend-fail-closed, migrator-drift) + internal convergence-check (decision-completeness, integration, adversarial) | 0 material | Removed duplicate C header; extended fail-closed to the frame-recapture/looksActivelyWorking step |
| — | (converged) | 0 | none |

Standards-Conformance Gate: ran each round (degraded: server returned an error on the standards pass; registry canary OK, 22 articles). Advisory/signal-only — did not block. Parent-principle realigned to "Signal vs. Authority" (a registry standard) after the gate flagged the original prose parent did not resolve.

## Full Findings Catalog

**Iteration 1 — material findings and resolutions:**

- *Decision-completeness (BLOCKERS):* (1) B2 "N consecutive checks" unspecified → **FD-1: N=3**. (2) "live sub-agent" ambiguous → **FD-4: any entry with no `stoppedAt`**. (3) "known stuck/error signature" unenumerated → **FD-3: path removed**; single conservative all-of-(a–d) condition is the sole trigger.
- *Integration (BLOCKERS):* SubagentTracker constructed after sentinel wiring → **D: reorder**. Five config defaults absent from ConfigDefaults → **D: added as SSOT**. `suppressUnchangedHeartbeats` missing + no migration → **B1 + D: flag + existence-checked migration preserving operator overrides**. CLAUDE.md template/migrate uncovered → **C: generateClaudeMd + content-sniffed migrateClaudeMd**. corroborateWedge unimplemented → **A2 contract specified + D: O(1) `hasActiveSubagents` getter**. Multi-machine posture unstated → **FD-8: machine-local by design**.
- *Adversarial:* A1 frozen-indicator false negative → **A5 (90m backstop)**. B1 long-task invisibility → **B1b (sparse liveness) + B1a (deadline exception)**. Oscillation evasion → **Known limitations (accepted)**. B2 premature close-out → **FD-1 (N=3)**.
- *Security:* promise excerpt + session name embedded unsanitized → **B5 + FD-7: route through `guardProxyOutput()` on every surface; neutral placeholder on unsafe**.
- *Scalability:* `escalate()` must be async → **FD-5**. Fail-open on corroborate error → **FD-6 (fail closed)**. JSONL read on hot path → **D: O(1) getter**. Double tmux capture → **A2: capture once**.
- *Lessons-aware:* observability gap → **E (full-funnel counters)**. Foundation audit (frame-hash proxy) → **Non-goals: proxy retained but made honest; structured turn-state noted as future work**. Bug-Fix Evidence Bar → **Testing: reproduce the exact reported false positive**.

**Iteration 2 — minor findings and resolutions:**

- *gemini:* duplicate "C — Docs alignment" header → removed. Fail-closed not explicit for the frame-recapture/`looksActivelyWorking` step → extended FD-6 + A2 to cover the whole path. Migrator config-drift process risk → already covered by the Migration Parity Standard + planned migration test; non-material.
- *Internal convergence-check (decision-completeness, integration, adversarial):* all prior blockers verified resolved; two non-blocking build-time notes (sync the monitors' hardcoded class defaults with ConfigDefaults; confirm async `escalate()` is non-breaking through the fire-and-forget path) recorded as implementation reminders; one design-judgment note that A5's 90m is a real latency cost — already operator-tunable via `activeWorkMaxFrozenIndicatorMs` and acknowledged in Known limitations.

## Convergence verdict

Converged at iteration 2. No material findings in the new round (gemini external: converged-ready; all three internal convergence-check reviewers: CONVERGED). Zero unresolved entries in `## Open questions` (all resolved into Frontloaded Decisions). Spec is ready for user review and approval.
