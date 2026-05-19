# Upgrade Guide — v1.0.10

<!-- bump: patch -->

## What Changed

Wires the FrameworkParitySentinel's documented mirror-trust remediation policy to the AdaptiveTrust system, and ships the matching PostUpdateMigrator entry so existing agents keep remediating parity drift after the wiring lands.

Before this release: the sentinel declared remediationPolicy = mirror-trust as the gate that decides whether drift gets auto-remediated, but the actual implementation was a binary remediationEnabled boolean that never consulted AdaptiveTrust. The string mirror-trust was a label without behavior — exactly the signal-vs-authority inversion the Instar standards warn against.

After this release: the sentinel calls AdaptiveTrust.getTrustLevel for the parity-sentinel service on modify operations, maps the trust level through trustToAutonomy, and only remediates when the autonomy is proceed (autonomous) or log. Approve-always, approve-first, and blocked downgrade to flag-only. Operators get a single trust-system surface to manage all auto-mutation policies instead of a sentinel-specific flag.

The PostUpdateMigrator companion entry seeds a parity-sentinel service entry in state/trust-profile.json at level log on update. Without this seed, AdaptiveTrust's DEFAULT_TRUST for modify is approve-always, which would silently turn every mirror-trust rule into flag-only on the next update for every deployed agent. Seeding at log preserves the v0.1 remediate-by-default behavior while routing every remediation through the audit channel. The migration is idempotent via the _instar_migrations marker AND a content-sniff (existing operator-set entries are preserved, never overwritten).

## Evidence

Reproduction prior to this release: spin up an agent with trust-profile.json having parity-sentinel set to approve-always. Run a parity scan with a mismatched rendering. The sentinel auto-remediates anyway, ignoring the trust level. The mirror-trust policy is a no-op.

Observed after this release: same setup, sentinel checks AdaptiveTrust, sees approve-always, downgrades to flag-only. The user-edit-overwritten event still fires for alwaysOverwrite rules (those bypass the trust gate by design per Migration Parity §4). For mirror-trust rules, no remediation happens and the parity-gap-found signal is the operator's escalation path.

Verification via unit tests: tests/unit/monitoring/FrameworkParitySentinel.test.ts now covers all four trust-level branches (autonomous, log, approve-always, blocked) plus a backward-compatible no-adaptiveTrust case. tests/unit/PostUpdateMigrator-paritySentinelTrust.test.ts covers seed creation, operator-override preservation, idempotency, additive merge with existing services, marker recording, and graceful skip on missing config.

## What to Tell Your User

- "The parity sentinel now actually checks our trust system before auto-fixing drift, instead of just checking a global on-off switch. The first time you update, a one-shot migration seeds your trust-system entry for the sentinel at the log level so existing behavior is preserved with an audit trail. You can downgrade to approve-always or upgrade to fully autonomous through the trust system without touching code."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Mirror-trust actually mirrors trust | When constructing FrameworkParitySentinel, pass an AdaptiveTrust instance via the adaptiveTrust config field. Mirror-trust rules then gate through trust levels for the parity-sentinel service on modify operations. |
| Trust-profile auto-seed on update | The PostUpdateMigrator now seeds the parity-sentinel service entry at level log on first update. Idempotent. Preserves any operator-set entry. |
| Trust-audit channel for parity events | Every parity remediation now flows through AdaptiveTrust's logging path. Trust elevation streak can promote the parity-sentinel entry to autonomous after a track record of clean remediations. |

## Deferred (Tracked Follow-ups)

- The sentinel is not yet wired into server.ts boot. The current PR delivers the trust-consultation layer so when the boot wiring lands the mirror-trust gate is honest from the first run. Boot wiring is the next sentinel work item.
- Migration Parity backfills for the five recently-shipped primitives (Skill, Hook, Agent, Tool, Memory) and Testing Integrity Tier-3 lifecycle tests for four primitive specs remain as the next tasks in this autonomous session.
