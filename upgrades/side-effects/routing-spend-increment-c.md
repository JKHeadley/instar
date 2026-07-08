# Side-Effects Review — Routing Control Room Increment C (alerts)

**Spec:** `docs/specs/routing-control-room-spend-alerts.md` (review-convergence r7, approved, parent-principle: Token-Audit Completeness)
**Worktree:** `echo/money-increment-c` off `JKHeadley/main` @ `220ebeb0b` (v1.3.783 — contains the merged Increment B) — remotes + version verified per Phase 2.
**Scope of this PR:** Increment C — the channel-abstracted alert layer: `SpendAlertDispatcher` (lane-scoped dedup + coalescing BEFORE any channel send, edge latch on CONFIRMED delivery, dryRun-first, scrubbed jsonl audit), `TelegramSpendTopicChannel` (message-INTO the ONE dedicated topic; durable-relay path for money-critical kinds; lifeline fallback on ANY failure; audible repoint), the emitter set (cap-approach 50/80% on BOTH caps, cap-hit, door-dark with P19 brakes, fallback-spike rate detection, recon-drift surface, holder-dead surviving-voice), the router-signal fan-out (I-9, observer isolation), the gate event hook, and the POOL-PUBLISHED rung-2 topic record on the machine registry (FD-6). Layer 1c reconciliation (which feeds recon-drift) and the operator additions are the NEXT PRs (tracked: CMT-1929).

## Phase 1 — Principle check (signal-vs-authority)

**Does this change involve a decision point?** The alert layer decides WHETHER TO NOTIFY, never whether to act: it blocks no call, gates no money, and constrains no agent behavior. The only authority-shaped logic is the dispatcher's dedup/coalescing (bounded-notification-surface protection) — deterministic counters and latches whose worst failure is a suppressed or extra NOTIFICATION, never a suppressed action. The gate hook is signal-only (throw-swallowed; the gate's admit/refuse path is unchanged — unit-pinned). Compliant: signals feeding a notification surface, no brittle logic holding blocking authority.

## Phase 2 — Plan

- **Decision points touched:** none with blocking authority. The dispatcher's lanes (money-critical vs informational) govern coalescing only — both lanes land in the SAME dedicated topic (Amendment 2).
- **Existing detectors/authorities interacted with:** `SpendAlertResolver` (extended with the pool-published rung-2 read/publish — creation stays serving-lease-fenced); `MeteredSpendGate` (gains an OPTIONAL `onGateEvent` observer — throw-swallowed, never on the refusal path); `onNatureRoutePlan` (single callback → small fan-out preserving observer isolation, I-9); `PendingRelayStore` (money-critical alerts ride the existing durable relay via injected enqueue); `MachineIdentity` registry (a content-free numeric `routingSpendAlertTopicId` field riding the SAME authenticated registry-sync path as `lastKnownUrl`/`endpoints`).
- **Rollout (FD-16):** Increment C ships **dryRun-first live-on-dev** — `routingSpend.alerts.enabled` rides `resolveDevAgentGate` (dark on the fleet), and `alerts.dryRun` defaults TRUE even on dev (would-send lines to the scrubbed jsonl, nothing delivered) until a deliberate flip.
- **Rollback path:** additive + dev-gated; disabling `alerts.enabled` (or leaving dryRun) reverts to Increment-B behavior byte-for-byte (the B stale-price cadence keeps its direct resolver path when the dispatcher is absent). No state migration; the registry field is inert data.

## Phase 4 — Side-effects review

1. **Over-block:** N/A for actions. For notifications: the per-kind edge latch + coalescing can suppress a repeat alert while a condition persists — by design (Bounded Notification Surface / Near-Silent Notifications); money-critical kinds ride a DISTINCT dedupe lane so a flapping door's volume can never coalesce a cap-hit into a digest (S-F8).
2. **Under-block (missed notifications):** a transient send failure does NOT latch (stays eligible); money-critical kinds additionally fall back to the lifeline on ANY failure and ride the durable relay when wired — the failure mode is a DELAYED alert, never a silent drop. dryRun is the deliberate exception: it delivers nothing and says so in the jsonl (the FD-16 soak posture).
3. **Level-of-abstraction fit:** dispatcher/channel/emitters live beside the B modules in `src/core/`; the fan-out lives at the single existing `onNatureRoutePlan` wiring point; NO new routes (the read surface is the jsonl + existing /guards posture). The `/attention` queue is deliberately NOT used (Amendment 2 — topic-per-item is the flood the operator forbids).
4. **Signal vs authority:** compliant (Phase 1) — everything here is a signal consumer/notifier.
5. **Interactions:** the dispatcher subsumes B's resolver-direct emission for stale-price/observed-drift (single voice — no double-fire: the cadence now emits THROUGH the dispatcher when present); the fan-out preserves the env-gated console breadcrumb; the gate hook never fires on the ledger path (only post-verdict); holder-dead is the ONE named exception to holder-single-voice (A2-2) and is keyed `spend-holder-dead:<keyEpoch>` pool-wide so two survivors dedupe.
6. **External surfaces:** Telegram messages into the ONE dedicated topic (or lifeline). The registry field is content-free (a topic id number). No other egress.
7. **Multi-machine posture:** topic identity becomes genuinely pool-durable this increment (FD-6 rung 2): the auto-created id is persisted machine-locally AND published as a content-free field on the replicated machine registry, so a future serving-lease holder INHERITS the id instead of re-creating; creation stays serving-lease-holder-only + single-flight + fenced. holder-dead emission is explicitly a surviving-machine act (single-machine: strict no-op). Emitter state (latches, backoff, spike baselines) is machine-local BY DESIGN — each machine notifies for its own observations; the dedupe keys carry machineId where cross-machine duplication is possible (door-dark), and pool-wide keys where it is not acceptable (holder-dead).
8. **Rollback cost:** config-flag revert; no data migration; the jsonl and registry field are inert at rest.

## Phase 5 — Second-pass review

Required (touches messaging decisions — the dispatcher decides notification delivery). Cross-model independent audit; verdict appended below.

**Reviewer verdict:** `VERDICT: Concur with the review. The provided artifact and code demonstrate robust mechanisms against blocking actions, silent drops of money-critical alerts, and notification floods, while adhering to signal-vs-authority principles.` (gemini cross-model, 2026-07-08 — scope: this artifact + SpendAlertDispatcher + TelegramSpendTopicChannel in full; questions: blocking-vs-notify, silent-drop of money-critical, flood protection, signal-vs-authority)

## Self-action convergence (unbounded-self-action — closure: guard)

New self-triggered notifiers are registered as convergence models in `src/testing/selfActionRegistry.ts` and proven to settle by `tests/unit/self-action-convergence.test.ts` (enforcement: ratchet):
- **door-dark episode brakes** (`spend-door-dark-brakes`): max-attempts = chain length per episode bucket, widening backoff, flapping breaker → converges to the breaker bound under a permanently-dark chain.
- **fallback-spike digest** (`spend-fallback-spike`): steady-state fallback churn is jsonl-only; a digest line fires only on a rate-spike edge with a per-window latch → ≤1 digest per window under sustained churn (eternal-sentinel rate floor).
- **cap-approach thresholds** (`spend-cap-approach`): edge-triggered per (capKind, threshold, window) — at most 4 emissions per key per window (2 kinds × 2 thresholds), re-armed only by the window rolling.

## No-deferrals accounting

Layer 1c reconciliation (feeds recon-drift), the amortized-subscription display, and the web-research price checks are the next PRs of this increment train, tracked under CMT-1929 <!-- tracked: CMT-1929 --> and enumerated in `.instar/plans/money-increment-b-brief.md`; nothing in THIS PR's claimed scope is partial.
