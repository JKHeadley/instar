# Side-Effects Review — Credential location ledger boot-seed (B3a)

**Version / slug:** `credential-ledger-boot-seed`
**Date:** `2026-06-15`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `(see Phase 5 below)`

## Summary of the change

Wires the missing runtime trigger for `CredentialLocationLedger.seedFromOracle()`. The live-credential-repointing build (spec §52) shipped the seeding *capability* but never called it at runtime, so on every agent the ledger stayed permanently NEVER-SEEDED: `getAssignments()` returns `[]`, `GET /credentials/locations` shows `assignments: []`, and the use-it-or-lose-it `CredentialRebalancer` (B3b) sees only the default slot — it can *decide* but can never *actuate* a drain (no other slots to move between). This change adds a boot-seed in `src/commands/server.ts` immediately before the B3b rebalancer timer, guarded by a new pure helper `shouldBootSeedCredentialLedger(enabled, isSeeded)` in `src/core/CredentialLocationLedger.ts`. Files: `src/commands/server.ts` (the boot-seed callsite + import), `src/core/CredentialLocationLedger.ts` (the exported guard), `tests/unit/credential-ledger-boot-seed-guard.test.ts` (guard truth-table), `tests/e2e/credential-ledger-boot-seed.test.ts` (boot-seed → `/credentials/locations` data-flow).

## Decision-point inventory

- `shouldBootSeedCredentialLedger(enabled, isSeeded)` (src/core/CredentialLocationLedger.ts) — **add** — pure boolean: seed only when the re-pointing dev-gate is on AND the ledger is not already seeded. This is NOT a runtime authority over agent behavior; it only decides whether to run a one-time, non-destructive data-population at boot.
- The boot-seed callsite (src/commands/server.ts, before the B3b timer) — **add** — fire-and-forget `seedFromOracle()` when the guard returns true. Reuses the existing `resolveDevAgentGate(...credentialRepointing.enabled)` gate that the location gate, executor, and rebalancer already share.
- `seedFromOracle()` itself — **pass-through** — unchanged; already converged + unit-tested (oracle-unavailable→quarantine, ambiguous/unknown-email→refuse+attention, one-home invariant).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. The change populates a ledger; it rejects no input and gates no message or action. The seed never *moves* a credential (that authority stays behind the executor's `dryRun` gate + the write funnel + the one-home invariant), so there is no "blocked legitimate swap" failure mode introduced here.

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable. Adjacent residuals worth naming honestly: (a) the boot-seed is a *one-shot* at startup — if accounts are enrolled/removed mid-run the ledger is not re-seeded until the next restart (acceptable: the rebalancer reads `getAssignments()` live, and a never-seeded→seeded transition is the load-bearing fix; periodic re-seed is a tracked follow-up `<!-- tracked: CMT-1564 -->`, not part of this change). (b) A slot whose oracle probe is unavailable/ambiguous is recorded quarantined (excluded from balancing) with a HIGH attention item — surfaced, never silently dropped.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The seed lives at server boot (`commands/server.ts`), the same layer that already constructs the ledger, gate, executor, and rebalancer timer — it sits directly beside the B3b timer it feeds. The decision logic is extracted into a pure helper on the ledger module (the owner of seed state) rather than left inline, so it is unit-testable without booting the server. It does NOT re-implement seeding — it *uses* the existing `seedFromOracle()` primitive. No higher-level gate exists that should own "populate the ledger at boot"; boot wiring is the correct home (the spec's named "boot recovery" path).

---

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic, or produce a signal that feeds a smart gate?**

Compliant (`docs/signal-vs-authority.md`). The change adds NO blocking authority. `shouldBootSeedCredentialLedger` is a pure idempotency/enablement predicate, not a runtime gate over agent behavior. The actual authority — moving a credential between slots — remains entirely with the existing `CredentialSwapExecutor` (its own `enabled`/`dryRun` gate) and the `credentialWriteFunnel`. Seeding only writes the local slot→account *map* (an observation of which account already tenants which home), derived from the identity oracle — it asserts nothing it cannot verify and moves nothing.

---

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, or race?**

- Shares the exact `resolveDevAgentGate(...credentialRepointing.enabled)` gate as the location gate, executor, and rebalancer — so it is on/off in lockstep with them (no divergent gating).
- Idempotent across restarts: `isSeeded()` is false only for never-seeded OR unknown(corrupt) mode, so a re-run skips an already-seeded ledger and the same call doubles as the spec's named recovery path. No double-fire.
- Runs once before the B3b timer is created; the timer's first tick fires `passIntervalMs` (≥60s) later, so the fire-and-forget seed's oracle probes have time to complete before the rebalancer reads assignments. A still-in-flight seed at first tick simply means the rebalancer sees the default slot for that one tick (its prior behavior) — never a crash or a wrong move.
- The seed write goes through the ledger's own `save()`; it does not race the swap executor (no swaps occur while dark/dry-run, and a real swap is serialized through the funnel).

---

## 6. External surfaces

**Does it change anything visible to other agents, users, or systems?**

On a dev agent (gate on): `GET /credentials/locations` now returns populated `assignments` + `mode: 'active'` instead of `[]`/`mode: 'dark'`, and the dashboard/rebalancer surfaces reflect real slots. It performs per-slot identity-oracle probes (network calls to the OAuth profile endpoint) once at boot — transient, no token persisted. On the fleet (gate off / dark): strict no-op, no probe, byte-for-byte today's behavior. No agent-to-agent surface. Depends on the subscription pool being populated (it derives slots from `pool.list().filter(isClaudeCodeAccount)`); an empty pool seeds zero slots (harmless).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The credential location ledger is the machine-local source of truth for "which account's credential sits in which config-home on THIS machine" — config homes and keychain blobs are inherently per-machine, so the seed (and the ledger it populates) is correctly machine-local and must NOT replicate. Each machine boot-seeds its own ledger from its own pool + its own oracle probes. There is no cross-machine read to merge and no durable state that should survive a topic transfer (a credential's physical location does not move with a conversation). This matches the rest of the credential-repointing feature's machine-local posture. No one-voice/notice surface is added (the only user-facing emissions are the existing seed-refusal attention items, which are per-machine and already deduped by id).

---

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Cheap and safe. (1) The feature is dev-gated + dark on the fleet, so a fleet agent is unaffected regardless. (2) On a dev agent, set `subscriptionPool.credentialRepointing.enabled` off (or revert this commit) — the guard returns false and no seed runs; the ledger falls back to never-seeded and consumers fall back to enrollment-home behavior (today's behavior). (3) The seed writes only the local `credential-locations` ledger file; deleting it returns to never-seeded. No credential is moved by this change, so there is no credential state to repair and no data migration. No hot-fix release is forced — the dev-gate + config flip is the immediate back-out.

---

## Phase 5 — Second-pass review

**Reviewer:** independent reviewer subagent (read the artifact + the diff + the seed implementation + the boot callsite independently).

**Verdict: CONCUR.** Evidence checked:
- **(a) Dev-gated, dark-on-fleet** — callsite passes `resolveDevAgentGate(config.subscriptionPool?.credentialRepointing?.enabled, config)`; `credentialRepointing` is a DARK_GATE_EXCLUSIONS entry with `enabled` omitted, so the gate resolves `false` on the fleet → no seed, no oracle probe. E2E dev-gate-OFF confirms `assignments: []`, `mode: 'dark'`.
- **(b) Non-destructive** — `seedFromOracle` only mutates `this.store` + `save()` + raises attention; never references the swap executor, keychain `writeService`, or the credential write funnel. Moves zero credentials.
- **(c) First-tick safety (two layers)** — the timer fires ≥60s after boot; `listSlots()` reads `getAssignments()` live each tick, so a momentarily-empty `[]` yields only the synthesized default slot → `decidePass` cannot form a swap (no source+target). Backstop: the executor's own `enabled:false`+`dryRun:true` gate suppresses every real write regardless. No wrong move is reachable from a partial seed.
- **(d) No race/crash** — fire-and-forget with `.catch`; a throwing/unavailable oracle is caught per-slot and quarantined (+ HIGH attention), never thrown out of boot.
- **(e) Guard logic matches the artifact** — `shouldBootSeedCredentialLedger = enabled && !isSeeded`; `isSeeded()` false for never-seeded AND unknown/corrupt mode, matching the "doubles as recovery path" + "idempotent" claims. Unit truth-table + e2e data-flow pass; tsc clean.
- **Disclosed limitation (not a defect):** one-shot at boot; a transiently-down slot stays quarantined until next restart / manual re-probe. Named in §2 as tracked follow-up CMT-1564; the rebalancer reads assignments live so a later re-seed flows through.
