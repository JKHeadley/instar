# Side-Effects Review — fleet-l0-default-on

**Change:** the L0 age-guard arm gate in AgentServer flips from `enabled === true` (default dark)
to `enabled !== false` (default ON). One expression + comment; one new wiring test pinning the
semantics.

1. **Over-block:** none identified at the gate level. Downstream, the guard can now retire stale
   rows on installs that never opted in. The retirement policy itself is unchanged and soaked
   (24h bar ≈ 100x retry horizon; test-rung retired only a genuine 35-day row; zero false
   retirements across both soak installs). Residual risk: an install with a legitimately paused
   >24h delivery backlog would see those rows retired with named reasons — judged acceptable
   and intended (that backlog IS the zombie-replay hazard).
2. **Under-block:** unchanged — the guard still covers only queues named in the shipped policy
   file (delivery-recovery at 24h). Other queues remain future policy additions.
3. **Level-of-abstraction fit:** correct — the arm decision stays at the single construction
   site that already owns policy resolution; no new layer.
4. **Signal vs authority:** the guard holds narrow, deterministic authority (retire-at-dequeue
   by age) that was deliberately granted via the converged UX-first spec and now fleet-approved
   by the operator. Not a brittle heuristic; behavior fails SAFE (resolution failure ⇒ dark).
5. **Interactions:** none new — DeliveryFailureSentinel behavior is untouched except rows it
   would have replayed past the age bar; the stale-digest coalescer already handles notice flow.
6. **External surfaces:** fleet-wide behavior change (the point). Users stop receiving stale
   replays; operators see dead-letter records with named reasons instead. Announced via the
   release note's user-facing sections.
7. **Multi-machine posture:** machine-local BY DESIGN — each install's guard governs its own
   delivery queue; no replication needed; a topic moving machines meets the destination's guard,
   which enforces the same shipped policy.
8. **Rollback cost:** two instant levers, no release needed — per-install `enabled: false`, or
   per-queue `maxAgeHours: 0` in the policy file. Full revert is this one-line gate flip back.

**Conclusion:** minimal-surface flip of an already-soaked guard, operator-approved for fleet.

**Second-pass review (independent reviewer subagent, 2026-07-24):** Concur with the review —
verified in code: a resolution failure leaves `l0AgeGuard` undefined and the sentinel's
constructor default (`enabled: false`) keeps the guard dark; a missing/zero/negative/NaN
`maxAgeHours` degrades to strict pass-through (fails toward under-block, never over-block);
the flag has exactly one reader and the guard one callsite at dequeue (no double-fire or
shadowing); the retire-by-age policy is deterministic transport-layer mechanics with
named-reason audit, consistent with signal-vs-authority's deterministic-policy carve-out.
