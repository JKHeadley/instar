# Convergence Report — Calm Transient-Episode Alerting

## Cross-model review: codex-cli:gpt-5.5

RAN — a real GPT-tier external pass ran through the agent's codex CLI in **every round** (rounds 1–4, all `status: ok`, verdicts MINOR ISSUES each round; findings folded into each round's synthesis). gemini-cli unavailable (service retired June 2026 — recorded in the durable activation history). The Anthropic clean-door reviewer was not run (config-gated; not required — the cross-model mandate is satisfied by the codex family passes).

## ELI10 Overview

Your machines watch each other for "drift" — one running a different version or different settings than the other — and a prober watches the network links between them. Both watchers work fine. The problem was how they talked to you: during a completely routine software update, you'd get high-priority alarms about drift that the system was already fixing by itself, followed minutes later by "never mind, fixed." On July 11 that produced a burst of alarms, doubled text, and confusing notices — all about non-problems.

This spec makes the narration match reality. Routine self-healing episodes make **no sound at all** (they're still visible in the alerts topic and dashboard if you look — they just don't buzz your phone). You get buzzed only when something genuinely needs you: a machine that's actually STUCK (no progress past a hard time ceiling), a problem that keeps coming back, a real capability split between machines, or an unusual pile-up of little episodes in one day. When an alarm does fire and the problem later heals itself, everything gets cleaned up and you get one clear "stand down" note.

The biggest surprise of the review: the "3-hour worst-case alarm" that makes the whole quiet-by-default approach safe **did not actually work in the current design** — its timer silently reset every time the stuck machine inched forward, blinked offline, or the watcher restarted (which is exactly what happens during updates). A large part of the converged spec is making those timers wipe-proof: they move into durable storage, keyed so nothing about the churn can reset them. The trade you're accepting: a genuinely stuck machine that used to (in theory) alarm at ~45 minutes now alarms at the 3-hour ceiling — in exchange for zero buzzes on every routine update, alarms you can actually trust, and alerts that clean up after themselves.

## Original vs Converged

**Originally**, the draft proposed: extend the existing 45-minute grace period when the lagging machine shows update progress, downgrade routine-drift alarms from HIGH to NORMAL priority, send the "restored" note silently, and move informational network-link chatter to a daily digest.

**The review found the draft's foundation was broken.** The clocks it planned to extend live in a data structure that is *keyed on the version numbers themselves* — so every version change wipes them. The proposed "progress extension" was literally dead code (a clock that survives 45 minutes has, by definition, seen no progress); the 3-hour stall ceiling could never fire for the exact "crawling laggard" it was designed to catch; and the "keeps recurring" counter could never count. Three more reset vectors (watcher restarts, machines blipping offline, the raiser role moving between machines) made the loud backstops decorative precisely during update waves. Separately: the priority downgrade turned out to be cosmetically irrelevant in the default alert topic (NORMAL and HIGH buzz identically), the escalation path had no working mechanism (duplicate alerts are silently swallowed), the "operator interacted" signal was derived from a field that gets auto-created before any human touches it and deleted after, a cycling condition could spam unbounded silent messages, oscillating network links could still post ~24 alarms a day, and the digest the rope chatter was being demoted to *doesn't run at all* on the machine that was producing the noise — and has no category for that content anyway.

**After four rounds**, the converged design: durable, churn-proof "anchors" (onset time, active-skew accumulator with computable suspension, per-machine progress, flap history, escalation latches) persisted in an existing durable file and computed independently on every machine; routine episodes fully silent with a cross-key wave backstop so a pile-up still surfaces; escalation via new, dedicated, cap-exempt alert items with a complete lifecycle (they resolve when the episode heals, with an adaptive stand-down note, even across machine handoffs); a genuine operator-interaction signal set only by authenticated actions; network-link chatter demoted only where the digest provably runs and actually covers that content — with a fallback to the alert topic everywhere else — plus per-link dedupe with honest "Nth episode today" counters; a fail-loud invariant so a failure of the escalation path itself can never be silent; and every behavior individually rollback-able, shipped dark behind the dev-agent gate with the operator's before/after buzz report as the graduation checkpoint.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, adversarial, scalability, integration, decision-completeness, lessons-aware, codex, conformance-gate (2 flags) | 14 | Complete redesign of state anchoring (M-P0: durable identity-independent anchors); explicit escalation mechanics (derived ids, cap-exempt); bounded resolve notes; durable operatorInteracted; typed rope class + deliverability check; dev-agate rollout + ratification (FD6); priority honesty (buzz-inert); wiring-integrity test tier; doc-parity obligations |
| 2 | security+adversarial, scalability+integration, decision-completeness, lessons-aware, codex, conformance-gate (2 flags) | 8 (all round-1 resolutions verified genuine) | Silent calm raises (standard-mandated) + wave backstop + calmRaiseNotify lever; participant-aware anchor clear; anchor input path (raw rows to the manager); activeSkewMs accumulator clock model; delivery-true digest predicate + digest content class; complete derived-item lifecycle incl. per-key 24h latches; flap-cycle definition pinned; both-class rope dedupe with count appends; full gated-set enumeration; two named CLAUDE.md migrations |
| 3 | verification panels A+B, codex, conformance-gate (3 flags) | 2 (all round-2 resolutions verified genuine) | Orphan self-closeout (status resolution decoupled from speaks(), every close reason, episode-scoped); digest conjunct = live local scheduler-handle check (promoted-standby hole); item-holder-voice for escalated close notes; accumulator credit predicate + clamps; ≥24h sustained-absence latch retirement + M6 suspension; wave backstop scoping; semantic-boundary + Test-as-Self obligations; self-heal declaration block |
| 4 | final verifier, codex, conformance-gate (1 phrasing flag) | 0 | Batched minors only: at-least-once/bounded-duplicate correctness contract named; fail-loud escalation invariant (`escalationRaiseFailed`); direction+observer labels on rope rows; wave-backstop boolean lever; reason-adaptive close copy; migration phrasing disambiguated |

Standards-Conformance Gate: ran every round (r1: 2 flags — signal-vs-authority on the prefix filter, wiring tests; r2: 2 flags — near-silent notifications, migration parity; r3: 3 flags — testing tiers, no-manual-work, no-deferrals; r4: 1 flag — phrasing collision, disambiguated). Every flag engaged and resolved in the following synthesis.

Per-round model disclosure: internal reviewers ran as Claude subagents on the authoring session's model (Opus 4.8 / claude-fable-5 session; six perspectives in six agents round 1, consolidated into four agents rounds 2–3 and one final verifier round 4 — all six perspectives ran every round). External: codex-cli/gpt-5.5, all four rounds, all successful.

## Full Findings Catalog

### Round 1 (14 material)
1. **Stall ceiling resettable via row-identity churn** (security F1 / scalability 1 / adversarial 1 — independently found 3×): row identity embeds version values; every advance mints a new row + fresh clock; the ceiling's own target (crawling laggard) never confirms. → M-P0 identity-independent durable anchors.
2. **Extension arm dead code** (scalability 1a): a row surviving grace has by construction seen no advance. → progress read from per-machine advance state, not row age.
3. **Flap brake cannot count / cap-swallowed / dedupe-swallowed / raiser-churn amnesia** (adversarial 2–3, scalability 3): → durable flap history, cap-exempt derived raises, per-key latches.
4. **No NORMAL→HIGH escalation mechanism** (scalability 2): createAttentionItem no-ops on dup ids. → derived item ids.
5. **Unbounded silent resolve notes** (adversarial 4): → one per reopenWindowMs; latched-flapping closes to jsonl.
6. **operatorInteracted mis-derived both directions** (adversarial 5, security F6): → durable boolean, authenticated setters only.
7. **Rope exhaustion re-arms per episode** (adversarial 6): → sink dedupe window.
8. **Priority buzz-inert in hub mode** (adversarial 7, integration 8): → honesty: semantic-only; buzz reduction via silence.
9. **Reopen raises silently swallowed** (adversarial 8): → reopen becomes a visible append.
10. **M-P3 digest surface doesn't exist for the incident's own shape** (integration 1): non-lease-holder + default config = black hole. → deliverability predicate + fallback.
11. **No M-P1 rollback lever** (integration 2): → explicit booleans.
12. **Flap brake vs reopen latch contradiction** (integration 3): → complementary mechanisms, defined.
13. **Rollout/ratification unnamed for user-visible semantics** (decision-completeness): → FD6 dev-agate + graduation checkpoint.
14. **Sink prefix-parse holds suppression authority** (conformance gate + codex 4 + lessons 1 — independently found 3×): → typed class declared at source.

### Round 2 (8 material; all round-1 resolutions verified)
1. **N≥3 participant departure clears the anchor** (sec+adv M-1): blinking laggard resets ceiling. → participant-aware clear.
2. **Deliverability predicate passes where nothing delivers** (sec+adv M-2 + scal F3): non-lease-holder; digest lacks the content class. → live conjunction + digest class added.
3. **Anchor input path missing** (scal F1): manager sees only confirmed rows. → EpisodeReconcileInput extended.
4. **Suspension uncomputable** (scal F2): → activeSkewMs accumulator.
5. **Derived items never resolved** (scal F4 + DC N1 + lessons F2 — independently found 3×): permanent stale HIGH. → durable derivedItemIds + close lifecycle.
6. **Silent calm raises mandated** (lessons F1, conformance gate): the standard's litmus. → FD7 silent default + wave backstop + fail-loud conditions.
7. **Migration entries cannot deliver** (lessons F3): both sniff markers fleet-present. → two named content-update migrations.
8. **:recurring latch mechanism unnamed** (DC N4): → durable per-key fire timestamps.

### Round 3 (2 material; all round-2 resolutions verified)
1. **Lease-proxy seam in the digest conjunct** (panel A New-1): promoted standby holds the lease with no scheduler. → live local handle check.
2. **Escalated-close note lost/doubled across handoff** (panel A New-2): → item-holder voice, disclosed ≤2× residual.
(Plus conformance-gate No-Manual-Work/No-Deferrals on the orphan residual → orphan self-closeout, in scope.)

### Round 4 (0 material)
Batched minors: correctness contract naming, fail-loud escalation invariant, direction labels, boolean wave lever, adaptive close copy, phrasing disambiguation. Two LOWs from the final verifier resolved inline; codex minors folded or satisfied (glossary already present; state-machine table judged covered by the now-explicit transition predicates — noted as a builder aid, not a spec gap).

## Convergence verdict

Converged at iteration 4. No material findings in the final round; `## Open questions` is empty; all nine Frontloaded Decisions cover the operator-visible semantics; the decision-points table classifies five invariant rows, contested and upheld. Spec is ready for user review and approval (`approved: true`), with graduation beyond the dev agent additionally gated on the FD6 live-pair buzz report.
