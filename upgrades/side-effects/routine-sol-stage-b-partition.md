# Side-Effects Review — Classify The Routine Sol Dependency Closure

Date:2026-11-23. Author:echo. Tier1, data-only partition correction after pre-push refusal. One manifest plus review/release documents; one independent read-only review, no new canary or runtime logic.

## Summary of the change

The new routine Sol config type makes thirteen existing/new account, quota and metadata modules reachable to the conservative relative-import scanner. The path is InboundDeliveryStore, SecretStore, DegradationReporter, type-only MessagingToneGate, shared types, then routineCodexPlacement and its account dependencies. Each is explicitly excluded with a per-file reason. The supported fingerprint writer/checker owns the final manifest serialization.

## Decision-point inventory

Classifies the canary evidence boundary under the existing approved stage-b-evidence-code-binding spec. It changes no certified membership, root, signed artifact, file hash, fingerprint, signature or verifier rule. No launch, account-selection or delivery behavior changes.

## 1. Over-block

The previous unclassified closure conservatively blocked this unrelated routing change from pushing. Explicit reviewed classification resolves that block without skipping the gate.

## 2. Under-block

The excluded account/quota modules remain outside Stage-B evidence, as their individual reasons state. They are covered by their own routing tests; this classification does not claim the canary tested them. Any new unclassified dependency or certified-source drift still fails the same checker.

## 3. Level-of-abstraction fit

The certified-set manifest is the intended boundary for classifying imports reached by the conservative scanner, including erased type imports. No runtime account code or scanner predicate is removed to hide dependencies.

## 4. Signal vs authority compliance

Reference:docs/signal-vs-authority.md. The scanner remains a fail-closed evidence signal; reviewed explicit manifest classification supplies the authority already granted by the approved spec and Chief directive5ed1e0b9. No gate logic or approval route is weakened.

## 5. Interactions

The thirteen additions are disjoint from the seven certified sources. Assertions compare roots, certified, fingerprint, artifactDigest and fileHashes before/after; all remain identical. The supported writer updates classification provenance only and refuses rebinding changed certified code onto old evidence as before.

## 6. External surfaces

No API, model request, publication, credential or installed-agent behavior changes. The existing pre-push and publication verifier run unchanged and now validate the complete partition.

## 7. Multi-machine posture

This is shared source/release metadata shipped identically in the package. It carries no machine-local account state or credential; no new replication surface.

## 8. Rollback cost

Reverting this classification restores the conservative push refusal for this closure. No data or account repair is needed. The existing certified subject and signed evidence are unchanged either way.

## Verification and review

Before correction, the live --check named thirteen unclassified members and all certified hashes matched. After per-file classification, scripts/stage-b-certified-fingerprint.mjs --write and --check pass:7 certified,144 excluded,151 closure members. Existing Stage-B evidence and publication-gate unit suites:21 passed. The complete publication verifier is run unchanged before handoff; no full author suite is run.

Reviewer routine_route_review independently confirmed the erased type-import path, all seven hashes and all five unchanged binding fields, and concurred with the exclusions. No fresh canary is required or claimed for this partition-only correction.
