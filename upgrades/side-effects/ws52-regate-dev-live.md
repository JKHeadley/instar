# Side-Effects Review — WS5.2 re-gate: credential re-pointing live-on-dev (dry-run), dark fleet

**Version / slug:** `ws52-regate-dev-live`
**Date:** 2026-06-13
**Author:** echo
**Second-pass reviewer:** independent reviewer subagent — CONCUR (changes a credential-WRITE feature's gate posture → Phase 5 required)

## Summary of the change

Per the operator directive (2026-06-13, topic 20905: "NONE of this should be dark for development agents"), live credential re-pointing is re-gated from `DARK_GATE_EXCLUSIONS` (off+dry-run for everyone) to the **developmentAgent gate**: `enabled` is OMITTED in `ConfigDefaults` so `resolveDevAgentGate` resolves it LIVE on a dev agent + DARK on the fleet. The destructive credential WRITE stays gated by the SEPARATE `dryRun:true` default (the dry-run canary): on a dev agent the `/credentials/*` levers return real data and the balancer runs its full decision loop, but the `CredentialSwapExecutor` returns outcome `dry-run` with ZERO writes before any keychain step. Real writes still require a deliberate `dryRun:false` (gated behind the §5 livetest). Touches: devGatedFeatures.ts (entry moved to DEV_GATED_FEATURES, removed from DARK_GATE_EXCLUSIONS), ConfigDefaults.ts (enabled omitted, dryRun:true kept), the 6 runtime `enabled` read sites (server.ts ×3, routes.ts ×2, CapabilityIndex.ts ×1 → resolveDevAgentGate), PostUpdateMigrator.ts (a strip migration + a CLAUDE.md re-word), templates.ts (awareness wording), the spec §2.8 amendment, and the affected tests.

## Decision-point inventory

- `subscriptionPool.credentialRepointing.enabled` gate resolution — MODIFY — from "explicit false for everyone (DARK_GATE_EXCLUSIONS)" to "developmentAgent-gated (live-on-dev, dark-fleet)". The destructive authority (the WRITE) is unchanged: still gated by the separate `dryRun` flag, which the executor enforces. The change moves the feature from dark to alive-in-dry-run on dev — it does NOT grant any new write authority.

---

## 1. Over-block
No block/allow message surface. The conservative invariant is preserved structurally: the fleet stays dark (`resolveDevAgentGate(undefined, {developmentAgent:false}) === false`), and even on a dev agent the dry-run canary blocks every credential write.

## 2. Under-block
The honest exposure this change ADDS on a dev agent: the `/credentials/*` levers now return real ledger data + run the decision loop (previously 503). This is the intended dogfooding. It does NOT add write exposure — `dryRun:true` keeps writes off until a deliberate `dryRun:false`. The reviewer confirmed there is no path where a dev agent writes a credential without that explicit flip, and no path where the fleet goes live.

## 3. Level-of-abstraction fit
Correct: this uses the established dev-agent dry-run-canary gate pattern (topicProfiles / threadline.singleNegotiator — write-capable features that ship live-on-dev in dry-run). The R2 spec decision that put it in DARK_GATE_EXCLUSIONS conflated `enabled` with `dryRun`; the amendment (§2.8) corrects that: `enabled` controls aliveness, `dryRun` controls writes, and they are independent flags.

## 4. Signal vs authority compliance
- [x] No new authority — the destructive write authority is UNCHANGED (still `dryRun`-gated + oracle-verified + reversible). Only the aliveness gate moved. (Ref: docs/signal-vs-authority.md; §2.8 amendment.)

## 5. Interactions
- **Two-flag independence:** `enabled` (dev-gate-resolved) and `dryRun` (default true) are read at separate sites; the executor's `dryRun` read is unchanged (`!== false`). The reviewer verified all 6 `enabled` sites route through `resolveDevAgentGate` and the lone `dryRun` site is untouched.
- **Migration:** `migrateConfigCredentialRepointingDevGate` strips ONLY a default-shaped `enabled:false` (preserves an explicit operator `true`); idempotent; mutates only that one key. The CLAUDE.md re-word replaces the stale "Ships DARK" sentence in agents that already have the section.
- **Env-token gate (Step 8) still ANDs in:** on a dev agent with an env-token fleet, the location gate still refuses (the §2.10 gate is unchanged) — re-gating `enabled` does not bypass it.

## 6. External surfaces
- On a **dev agent**, the `/credentials/*` routes now return 200 (were 503) and the balancer status surface is live — observable, but performing zero writes (dry-run). On the **fleet**, byte-for-byte unchanged (still 503/dark). The CLAUDE.md awareness text is updated (new + existing agents) so the agent describes the feature accurately (live-on-dev dry-run, not "ships dark").

## 7. Multi-machine posture (Cross-Machine Coherence)
- **Machine-local BY DESIGN.** The gate resolves per-machine from that machine's `developmentAgent` flag; each dev machine runs its own dry-run loop over its own keychain. No cross-machine coordination. A dev agent on multiple machines runs the dry-run canary independently on each.

## 8. Rollback cost
Low + ordered. Revert the commit → the feature returns to DARK_GATE_EXCLUSIONS dark-for-everyone (the migration's strip is idempotent and an agent with `enabled` already stripped simply resolves via the gate; re-adding `enabled:false` to ConfigDefaults darks it again). No credential was ever written (dry-run), so there is no credential state to repair. The ordered-rollback discipline of §2.8 (restore-enrollment before dark) is unaffected — it applies only once real writes have happened, which dry-run never does.
