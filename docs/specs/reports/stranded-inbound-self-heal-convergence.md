# Convergence Report — Stranded-inbound detector

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex-cli, gpt-5.5) ran in every round (R1–R4). Gemini-cli was available but timed out on R1 (degraded); per the aggregate rule, one successful external family is the clean RAN flag. The external reviewer returned MINOR ISSUES each round (no material/architectural blocker), and its minors were folded in (predicate three-valued correctness, dedup-window identity, blind-spot guard, latency-bound honesty, "servable peer" wording).

## ELI10 Overview

When I run on more than one machine, each conversation is "owned" by one machine that receives and answers it. On 2026-06-24 a conversation got stuck owned by a machine that was *switched on but unable to serve* — the Mac Mini was sending heartbeats but its AI account was rate-limited, so your Telegram messages routed to it and silently vanished while my replies still went out from the healthy Laptop. 17 of 25 conversations were stuck this way, and every automated test passed the whole time — only you noticing missing messages caught it.

This spec adds a small read-only watcher that, each minute, finds any conversation owned by an online-but-unable machine and raises ONE alert. It changes nothing on its own — it just makes the invisible wedge loud within ~a minute or two instead of waiting hours for a human to notice.

The headline tradeoff, surfaced by review: the *obvious* fix (auto-hand-off to a healthy machine) is unsafe to build today, because the signals we'd use are self-reported, briefly-wrong, and we can't yet tell if a live answer is mid-flight on the stuck machine — getting it wrong would yank a live conversation mid-reply, which is worse than the bug. So v1 is detection-only and the auto-failover is deferred with its prerequisites written down.

## Original vs Converged

**Originally**, this was a self-HEALING reconciler: detect the stranded topic AND automatically CAS-reassign its ownership to a healthy machine (with a pin repoint). The review process fundamentally reshaped it:

- **Round 1** (security + adversarial + lessons-aware) proved the auto-failover could not be made safe with today's primitives: there is no per-topic remote-liveness signal (only a scalar `activeSessionCount`), the reachability signal is the would-be-victim's own self-report (up to `failoverThresholdMs` stale), there is no temporal hysteresis (a 5-second blip would seize a live topic), and the 2-machine quorum (the actual incident topology) is a trivial pass. The unanimous conclusion: **a wrong failover is strictly worse than the bug** (it drops a live conversation).
- **The converged design retreats to a pure-signal DETECTOR**: it raises one aggregated, staleness-disclosed attention item and mutates nothing. The auto-failover is deferred to a v2 whose seven prerequisites are each named and tracked (`CMT-1786`). This is the textbook *Signal vs Authority* and *Bounded Blast Radius* move: ship the safe half that catches the class, build the dangerous half only once the primitives exist.
- **Rounds 2–3** hardened the detector itself: the predicate was restructured into a channel-independent quota arm (which carries the real incident with zero scope resolution) plus a fail-closed best-effort adapter arm; the three-valued `machineServesChannel` enum was used correctly (the original `!fn(...)` idiom would have made the detector never fire); `strandedSince` got per-tick reconciliation; the attention item discloses signal staleness; and a separate "can't-assess" guard makes a schema-regression blind-spot itself visible.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes | Conformance Gate |
|-----------|-----------------------|-------------------|--------------|------------------|
| 1 | security, adversarial, integration, scalability, decision-completeness, lessons-aware, codex | several (failover unsafe — no remote liveness, stale self-report, no hysteresis, inert quorum) | Narrowed v1 to a pure-signal DETECTOR; deferred failover to v2 with named prerequisites; folded all detector-side findings (persistence, freshness, dedup, reuse helpers, GuardRegistry, single-machine no-op, lease-holder-only) | ran (0 flags) |
| 2 | adversarial (1 material), codex (minor), lessons-aware (minor), decision-completeness (clean) | 1 (predicate needs ChannelScope; no `topic→scope` resolver named) | Restructured predicate: channel-independent quota arm + fail-closed best-effort adapter arm; three-valued enum fix; `strandedSince` reconciliation; latency bound; dedup-window identity; can't-assess guard; staleness disclosure | ran (0 flags) |
| 3 | adversarial (CONVERGED), decision-completeness (CONVERGED), codex (minor) | 0 material / 0 convergence-blocking | Folded reviewers' non-blocking accuracy recommendations: corrected the `TopicBinding` misnaming (no topic→scope registry exists; quota arm carries Telegram, adapter arm is Slack-only in practice), "servable peer" wording, latency-bound cadence honesty | ran (0 flags) |
| 4 | codex (final body re-pass, delta-gated) | 0 material | none (verification pass on final body) | — |

## Full Findings Catalog

### Round 1 (on the original mutating design)
- **[CRITICAL, adversarial+integration] No remote per-topic liveness primitive** — heartbeats carry only scalar `activeSessionCount`; the failover could seize a live/recovering conversation. → Resolved by descope; named as a v2 prerequisite (heartbeat extension).
- **[CRITICAL, adversarial] No hysteresis** — a transient quota blip would force-claim a healthy mid-conversation topic. → Descoped; v2 prerequisite (≥N blocked beats + dwell).
- **[MATERIAL, security] Stranding signal is the victim's own self-report** — seizing FROM a machine on its own (possibly stale/sparse) beat. → Descoped; detector now uses it only as advisory input with ≥2-rich-beat persistence + staleness disclosure.
- **[MATERIAL, security] No staleness floor beyond the global `online` window** → detector requires a genuine rich beat within a freshness bound; missing field ⇒ SKIP.
- **[MATERIAL, adversarial] Flap loop / two-writer overlap / target-goes-dark-between-select-and-CAS / no-valid-target churn / nonce collision** → all are mutation hazards; deferred to v2 with named fixes (cooldown, re-assert-at-claim, disjointness, reason-stamped nonce).
- **[MATERIAL, integration] `isTopicBusy` ≠ remote-session presence; must register in GuardRegistry; unpinned overlaps Case D** → detector reads `activeSessionCount`/in-memory caches only; GuardRegistry registration added (D6).
- **[MINOR, security] 2-machine pool has no quorum floor** → documented; v2 uses temporal corroboration there.
- **[scalability] Per-topic cooldown / tick interval / dedup key / no-synchronous-probe** → folded (≥30s tick, in-memory once-per-tick, no peer probe, dedup key, LLM-free no-spawn-slot invariant).
- **[lessons-aware] Constitutionally aligns after descope; foundation `online`=heartbeat-fresh is acceptable for a DETECTOR though not for a mutation** → the spec draws that mutation-vs-detection line explicitly.
- **[codex] Mutation atomicity, actor-vs-target, missing-`servesChannels`=uncertainty, debounce, glossary** → folded (glossary added; missing-field⇒skip; atomicity deferred to v2).

### Round 2 (on the narrowed detector)
- **[MATERIAL, adversarial] Predicate needs a `ChannelScope` but ownership records are keyed by bare `sessionKey`; no resolver named** → restructured into quota arm (no scope) + best-effort adapter arm (fail-closed).
- **[MINOR, adversarial] `machineServesChannel` three-valued; `!fn(...)` always false** → predicate now `=== 'no'`, `'unknown'⇒skip`.
- **[MINOR, adversarial] `strandedSince` needs per-tick reconciliation** → added.
- **[MINOR, lessons-aware] Item should disclose signal staleness** → added last-rich-beat age to item text.
- **[MINOR, codex] Latency overstated; dedup-window underspecified; fail-closed blinds on schema regression; cache freshness; route-time alternative** → all folded (latency bound + cadence caveat; window identity; can't-assess guard; D5 cache readiness; route-time rationale).
- **[decision-completeness] v1 DECISION-COMPLETE** (pin-atomicity + Slack-granularity findings live only on the deferred mutation path).

### Round 3 (convergence check)
- **adversarial: CONVERGED — no material findings.** R2 fixes verified resolved; non-blocking note: `TopicBinding` carries platform not chatId → adapter arm skips more (degrades to fail-closed floor, never a false strand).
- **decision-completeness: CONVERGED — decision-complete.** Non-blocking: same `TopicBinding` accuracy note → corrected in the spec text.
- **codex: MINOR ISSUES** (D2 predicate-copy footgun, item-lifecycle clarity, "healthy server" wording, latency cadence) → folded.

## Convergence verdict

**Converged at iteration 3** (verification re-pass at iteration 4). Both internal convergence reviewers (adversarial, decision-completeness) returned an explicit CONVERGED verdict with zero material / zero convergence-blocking findings; the external (codex) returned minor-only every round; the Standards-Conformance Gate ran every round with 0 at-risk flags. `## Open questions` is `(none)`. The design is a pure-signal, dark-gated, fail-closed detector with the dangerous auto-failover deferred behind named, tracked prerequisites. Ready for approval and build.
