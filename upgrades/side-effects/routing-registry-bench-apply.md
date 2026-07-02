# Side-effects review — LLM Routing Registry (bench-derived v2) + wave-2 coverage flips

**Change:** (1) first canonical shipment of docs/LLM-ROUTING-REGISTRY.md,
updated to v2 with the INSTAR-Bench-derived routing defaults: 7 hard rules
(each citing its run stamp), tiered subsidized-non-Claude-first chains per
task nature, and the record of the 4 shipped / 2 held prompt fixes;
(2) src/data/llmBenchCoverage.ts wave-2 flips — 24 pending entries graduate
to 19 covered (18 task ids; SlackAdapter shares TelegramAdapter's) + 5 argued
exemptions; (3) the ratchet test's pinned baselines updated to match (pending
shrinks to wave-3 only; exemptions grow by the 5 argued ones — the visible,
reviewed act the ratchet requires).

**Principle check (Phase 1):** no decision point touched. The registry doc is
documentation; llmBenchCoverage.ts is a CI-time data map consumed only by the
ratchet test; no runtime code path changes.

1. **Over-block** — n/a (no runtime gate).
2. **Under-block** — n/a.
3. **Level-of-abstraction fit** — right layer: the intentional-defaults doc
   lives beside the code it governs; coverage decisions live in the pinned map.
4. **Signal vs authority** — n/a (docs + CI data).
5. **Interactions** — the ratchet test is the only consumer; run green (6/6).
   Exemption additions are deliberately pinned-visible per the ratchet design.
6. **External surfaces** — none. The doc's run-stamp citations reference the
   benching agent's research tree (not shipped) — documented as such.
7. **Multi-machine posture** — machine-local BY DESIGN (repo docs + CI data).
8. **Rollback cost** — trivial: revert the commit. No runtime behavior changes.

**Evidence:** run stamps crit-cli / crit-metered / wave2 / ab-* in the bench
research tree; CRITICAL-SET-DIGEST.md; 570 forensic verdicts; 6 A/B verdict
JSONs. Second-pass: not-required (no gate/lifecycle/messaging decision logic
touched — documentation + CI-time data only).
