# Side-Effects Review — recommended services, step 1: saved choices

**Tier 2.** Spec: `docs/specs/recommended-services.md`, approved by the operator on 2026-11-03. About 25 files. Spec review used all 6 rounds and did not converge by the round rule. The operator chose to proceed, with the last fixes reviewed during the build. The second-pass reviewer below covers that for this step.

## Summary

Adds the signed choice ledger, its replicated store, read and no routes, legacy decline import, and retirement of the two old offers. Sends no offers. This is part of rollout step 1, not all of it. Still to come in step 1: the ACT-115 owner-check fix, the migration-complete flag, moving door and Tailscale steps out of the CLI, and the delivered-first-result trigger. The yes route, catalog, recipes and offers follow in later steps. All are tracked by commitment CMT-031.

## 1. Over-block

The evaluator and `/features/:id/surface` now refuse `cloudflare-tunnel` and `git-backup`. Until offers go live, nothing suggests those two features. Both are default on, so few agents ever saw these suggestions. A no without the PIN is refused, which leaves an owner with no PIN configured unable to record one; `checkMandatePin` answers 503 there.

## 2. Under-block

The agent can read the PIN, so a deliberately hostile agent could record a no. The operator accepted this limit until owner proof ships. A local file edit could also alter the ledger; signatures are checked only for peer rows.

## 3. Level-of-abstraction fit

A separate ledger, for reasons in the spec: `FeatureRegistry` state is local, erasable, and overwritten by bootstrap. It reuses the established replicated-store shape and machine signatures.

## 4. Signal vs authority

No brittle check gains blocking authority over messages or actions. The fold decides nothing yet except what the route reports. Refusing retired offers is an exact id match. See `docs/signal-vs-authority.md`.

## 5. Interactions

The store is enabled only where the coherence journal is live, so it never advertises a capability with no applier, and an explicit `enabled: false` is honoured. Old peers don't register the kind and ignore it.

## 6. External surfaces

Two new routes. A new CLAUDE.md section via template and migration. No outbound messages. No operator-facing action is added beyond the PIN route, which has no dashboard surface until step 2; no flow sends anyone to it before then.

## 7. Multi-machine posture

Replicated through the `recommendedServices` store, registered in the coherence registry, `rotateKeep: 0`. **It depends on the coherence journal, which is dev-gated, so on the fleet today choices stay on one machine.** Journal replication must also be enabled, which is explicit-only. `GET /recommended-services` reports `replicating` from those real states, not from a hook being attached. Own rows are re-sent at boot, so nothing written while it was off is lost. Offers must not go live on a multi-machine agent while this is false; the spec's rollout now states that. Rows verify under the writing machine's identity key. An unverifiable row is not accepted now and is re-read at next boot. Single machine: in backup `includeFiles`.

## 8. Rollback cost

Revert the release. The ledger file and journal rows stay inert, and return to use on re-upgrade. Older code offers the two legacy features again through their triggers, as the spec states.

## Second-pass review

**Concern raised, then fixed.** The independent reviewer found that replication wouldn't work on the fleet while the text claimed it would, that a failed legacy import could stop boot, that the store overrode an explicit off switch, and that this artifact understated what step 1 still needs. All four are addressed above. A re-check found `replicating` could read true with nothing replicating; it now reads the store and replication switches. The reviewer checked wiring order, signing, the merge fold, backup paths and journal kind lists and found them clean. Live replication between two real machines has not been run.
