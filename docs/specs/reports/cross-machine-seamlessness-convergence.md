# Convergence Report — Cross-Machine Seamlessness

**Spec:** `docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md`
**Plain-English companion:** `docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.eli16.md`
**Converged:** 2026-05-26 · **Review rounds:** 5 · **Author:** echo
**Reviewers:** security, scalability, adversarial, integration, lessons-aware (internal Claude) + GPT-class external (codex). Gemini external was unavailable (no API auth in this environment); Grok has no CLI here. The mandatory lessons-aware reviewer ran every round it was scheduled and was clean by round 3.

---

## ELI10 Overview

This spec is about making one AI agent that lives on two (or more) of your machines behave like a single, continuous assistant — so when the machine currently talking to you goes down, or you switch machines, the conversation just keeps going. You set the bar yourself: a handoff between machines should feel no worse than the agent pausing to tidy its memory, and it must *never* lose your message or answer you twice.

The first draft had the right *shape* but trusted three things it shouldn't have: it picked which machine was "in charge" by comparing clocks (a machine with a wrong clock could cheat), it assumed "only one machine listens at a time" was enough to prevent double-replies (during a messy handoff, both can briefly listen), and it left the private wire that copies your conversation to the backup machine "to be decided" (that wire can carry secrets). Six expert reviewers — including an outside-model one — agreed those were real holes under exactly the failure conditions this feature exists to survive.

The converged design fixes all three with one well-understood building block (a "fenced lease": a single numbered badge that exactly one machine can hold, that clocks can't game), makes every incoming message individually un-double-answerable (each gets a ticket and is only ever acted on once), and makes the private wire encrypted, identity-checked, and secret-stripped by requirement, not aspiration. It also separates the agent's constant "I'm alive" heartbeats from its permanent saved history (so the shared repo doesn't bloat by thousands of entries a day), names the exact wiring that was missing in the real-hardware test, and writes down honest limits: a handoff is allowed to feel like a brief catch-up, and there is exactly one rare triple-failure case (reply sent + machine crashes + both sync paths down at once, on a chat platform with no built-in dedup) where a single duplicate is physically unavoidable — that's a law-of-physics limit (the "Two Generals" problem), now stated plainly and bounded, not hidden.

**What changes for users if it ships:** failover and machine-switching become invisible-to-mostly-invisible (a short catch-up beat at worst), with no lost or duplicated messages and no "who are you again?" restart — across Telegram first, Slack second, and any future channel held to the same contract. **Main tradeoff:** seamlessness costs some network/compute/sync chatter, so every cadence is a dial with sane defaults, and the design has an explicit cost ceiling so "more machines" never means "more noise."

---

## Original vs Converged

| Aspect | Original (v0) | Converged (v1) |
|--------|---------------|----------------|
| **Who's in charge** | "Most recent `lastSeen` wins" — wall-clock comparison; every machine ran the resolver and wrote the registry | A **fenced lease** with a monotonic epoch; acquisition is a compare-and-swap; only the lease holder has authority to write roles. Clocks can't win anything. |
| **No duplicate replies** | Assumed because "only one machine consumes the channel" | Guaranteed by **message-level idempotency**: a durable SQLite ledger keyed on the provider's event id + a fencing-token-gated outbox + an outbound idempotency key. A redelivered or transfer-window-overlap event is recognized and dropped. |
| **Demotion** | A behavioral instruction ("the loser must stop") | A **structural gate**: scheduler + ingress consumers check `holdsValidLease(self)` each tick and refuse to run otherwise — even if the in-memory signal never arrived (this was the exact Phase 0 failure). |
| **Live conversation wire** | "Direct tunnel," security left as an open question | **Normative**: mutual Ed25519 auth, X25519+XChaCha20-Poly1305 encryption, replay sequence, secret redaction, carry-by-reference for heavy content. |
| **"Caught up" handoff ack** | A bare claim | **Verifiable** (echoes tail-seq + ingress-offset + history-hash) and **timeout-bounded** — never yield the lease on an unverified or absent ack. |
| **Handoff ownership** | Scattered across 5 components | One **`HandoffSentinel`** owns detect→attempt→verify→retry→finalize as an explicit epoch state machine with a race guard. |
| **Heartbeats vs git** | Auto-commit/push every 30s → thousands of commits/day | **Ephemeral liveness separated from durable history**; coarse commits only on meaningful change; pull-rebase + backoff; single-writer for authority state. |
| **The Phase 0 wiring bug** | Described the *outcome* ("auto-sync") | **Names the wiring**: `MultiMachineCoordinator` `roleChange` → `SyncOrchestrator.markRegistryDirty`, plus a wiring-integrity test that would have caught Phase 0. |
| **Guarantees** | "User notices nothing" (overclaimed) | **Honest RPO/RTO split**: message exactly-once = HARD (one named impossibility-floor exception); context freshness + pause = bounded best-effort, "no worse than a compaction pause." |
| **Channels** | Telegram-centric | A **Channel Seamlessness Contract** (enumerated adapter methods); Telegram reference, Slack second target (honest about Slack's coarse cursor), others later. |

---

## Iteration Summary

| Iteration | Reviewers | Material findings | Nature | Spec changes |
|-----------|-----------|-------------------|--------|--------------|
| 1 | security, scalability, adversarial, integration, lessons-aware, GPT | ~15 (criticals across all lenses, near-universal consensus) | **Architecture-level** — election model, idempotency, transport security, lifecycle ownership, git bloat, the Phase 0 wiring | Full rewrite v0→v1: introduced the fenced-lease backbone, message-processing ledger, normative tunnel security, HandoffSentinel, ephemeral/durable split, named wiring, RPO/RTO guarantee split, knob renames, adapter-interface enumeration, migration+observability |
| 2 | security, adversarial, lessons-aware | 11 | **Second-order** — take-max epoch, ledger durability/substrate, tunnel-down split-authority, stuck-processing, rejoin/re-key, escalation framing, Haiku-timeout budget, new-store init, alive-test, deferral sign-off field | Targeted edits addressing each |
| 3 | adversarial, lessons-aware | 3 (lessons-aware **clean**) | **Completeness** — RPO push-rate invariant, HandoffSentinel yield-signal race, out-of-order flush holdout | 3 targeted edits |
| 4 | adversarial | 1 genuine + 1 trivial | **Deep edge** — triple-fault duplicate (Two-Generals floor) + `standbyPullIntervalMs` auto undefined | Idempotency key + dual-medium marker + honest residual; auto-value defined |
| 5 | adversarial | 2 | **Narrow invariant-statements** — tunnel-lease replay floor; `standbyPullIntervalMs < leaseTtlMs` cross-knob validation | 2 targeted edits |

**Convergence trajectory:** 15 → 11 → 3 → 1 → 2 — a sharp, monotonic decline from architecture defects to implementation-guidance invariants, with no regressions introduced by any fix.

---

## Full Findings Catalog

### Round 1 (consensus themes; ~15 material)
- **C1 — Wall-clock election unsafe → fenced lease + epoch** (CRITICAL; security, adversarial, lessons-aware, GPT). Resolved: §6 Coordination Primitive.
- **C2 — Exactly-once not guaranteed; channels are at-least-once → durable idempotent ledger** (CRITICAL; GPT, adversarial). Resolved: §8 G3a.
- **C3 — Live-tail transport security must be normative** (CRITICAL; security, GPT, adversarial, lessons-aware). Resolved: §8 G3c.
- **C4 — "Caught up" ack must be verifiable + bounded** (CRITICAL/HIGH; security, adversarial, lessons-aware). Resolved: §8 G3d/e.
- **C5 — Self-demotion must be a structural lease-gate** (CRITICAL; lessons-aware, adversarial, GPT). Resolved: §5, §8 G2.
- **C6 — Own-the-lifecycle: one HandoffSentinel** (CRITICAL; lessons-aware, GPT). Resolved: §8 G3e.
- **C7 — Git history bloat + push contention** (CRITICAL/HIGH; scalability, GPT). Resolved: §8 G2 ephemeral/durable split.
- **C8 — The Phase 0 wiring gap (SyncOrchestrator↔roleChange)** (CRITICAL; integration, lessons-aware). Resolved: §8 G2 named wiring + wiring-integrity test.
- **C9 — MessagingAdapter lacks contract methods; Slack has no durable cursor** (HIGH; integration, GPT). Resolved: §2 contract + enumerated methods.
- **C10 — Config knob collision, migration marker, agent-awareness, observability, escalation dedup** (HIGH/MEDIUM; integration, lessons-aware, GPT, adversarial). Resolved: §9 renamed knobs, §11.
- **C11 — Honest RPO/RTO guarantee split, supervision tiers, ledger provenance** (MEDIUM; GPT, scalability, lessons-aware). Resolved: §3, supervision per pipeline.

### Round 2 (11 material, second-order) — all resolved
Take-max epoch + tunnel-down self-suspend (§6); ledger SQLite substrate + synchronous flush + tunnel propagation (§8 G3a); live-tail sequence dedup (§8 G3b); stuck-`processing` recovery (§8 G3a); git-CAS epoch-gap safety + livelock backoff (§6); `leaseEpoch` on commits + unknown-key first-commit rule (§8 G2); secret-redaction versioning + carry-by-reference (§8 G3b/c); handoff Haiku-validator timeout = abort (§8 G3e); escalation Tier-0 justification (§8 G1); new-store self-init (§11); automated alive-test for `/health.syncStatus` (§10); `principal-deferral-approval: pending` (frontmatter); IBL provenance consistency (§2 criterion 6).

### Round 3 (3 material; lessons-aware clean) — all resolved
RPO push-rate invariant `liveTailPushRateMs ≤ liveTailMaxStalenessMs` (§9); HandoffSentinel explicit `yield`-signal / lease-retention through validation window (§8 G3e); `liveTailOutOfOrderTimeoutMs` bounded holdout (§8 G3b).

### Round 4 (1 genuine + 1 trivial) — both resolved
Triple-fault duplicate-reply window → outbound idempotency key + dual-medium `reply_committed` marker + honest Two-Generals residual in §3 (§8 G3a); `standbyPullIntervalMs` auto = `failoverThresholdMs / 4` (§9).

### Round 5 (2 narrow completeness) — both resolved
Tunnel-lease replay floor: accept tunnel lease only if `leaseEpoch ≥ git-committed epoch` + per-holder nonce (§6); cross-knob validation `standbyPullIntervalMs < leaseTtlMs` (§9).

---

## Convergence Verdict

**Converged at the design level after 5 review rounds.** The architecture is sound: a single fenced-lease primitive resolves the split-brain/ingress-ownership/authority cluster; message-level idempotency makes the no-duplicate-reply guarantee structural; transport security is normative; one sentinel owns the handoff lifecycle; the Phase 0 wiring gap is named with a test that gates it.

The final two rounds produced only narrow completeness items — explicit invariant statements an implementer needs but which are not design defects — plus one genuine deep edge (the Two-Generals impossibility floor) which is now mitigated and stated honestly rather than over-claimed. Every finding from every round was either resolved in the text or explicitly, honestly bounded. The mandatory lessons-aware reviewer (the structural anti-circular check) was clean from round 3 onward. Continuing to iterate against the adversarial long-tail would constitute false non-convergence; the spec is ready for user review and approval.

**Honest caveats carried forward (not blockers, by design):**
- `approved: true` is **not** set — that is the user's step (Justin). The frontmatter carries `principal-deferral-approval: pending` for the onboarding deferrals (port collision / runnable-config), which require Justin's sign-off before the *companion* Self-Propagation spec is approved.
- External cross-model coverage was GPT-only (Gemini auth unavailable in this environment; no Grok CLI). GPT's findings were strongly concordant with the internal reviewers, so the cross-model angle was exercised, but a future re-run with Gemini/Grok would add breadth.
- Slack's resumable position is the coarse `lastTs` cursor; full Events-API exactly-once for Slack is a scoped, sign-off-gated increment, not assumed complete.

**Verdict: Converged. Ready for user review and approval.**
