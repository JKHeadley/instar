# Local History Progress Registration

Tier 1 reversible metadata repair: one registry row and one semantic test (13 added implementation/test lines), plus explanatory documentation. One review pass. The approved design remains docs/specs/local-history-native-contract.md.

## Problem and evidence

Full unit verification found two failures. Rebuilding the generated builtin manifest fixed its stale version/hash artifact, and all10 manifest tests passed; no generated file is committed. The other failure is genuine source omission: the local-history spec names a ladder absent from feature-ladders.json. Add that real registry entry, tracking.state=needed, with sensitive posture and code-only advancement. Eighteen focused cases passed after correction.

## Side effects

Over-block: no new refusal or runtime gate. Under-block: progress metadata cannot establish native availability or replace the unwritten intake/library wiring. Layer fit: the central registry owns maturation tracking, and the spec-to-registry coverage check enforces registration. Signal versus authority: reference docs/signal-vs-authority.md; missing proof is a progress signal. Both advancement operations require code; no config start action is added. Interactions: source-specific native acceptance and an installed review remain separate requirements; counts alone cannot enable a feature. Tracking stays needed until real instrumentation and acceptance exist. The existing registry schema requires at least one observation day; this is monitoring metadata, not new import authorization or a runtime approval timer. The existing fourteen-day progress checkpoint remains tied to the first released candidate.

External/operator surface: one honest unfinished-work row, explicitly unavailable. No new endpoint, owner permission, runtime flag consumer or app action. Team and multi-machine posture: requirements retain actual owner, verified target and private transport checks; this row moves through the existing shipped registry and creates no replicated private data. Rollback: remove the metadata/test if the corresponding design is retired; no user data migration or deletion.

## Verification

Retained red full-run evidence: spec local-history-native-contract.md names missing localHistoryImport. Green focused result: eight ladder checks and10 rebuilt-manifest checks passed. No full-suite pass or installed native acceptance is inferred.

## Class-Closure Declaration

- defectClass: unbounded-self-action
- closure: n/a
- reason: Registry metadata and a semantic test introduce no controller, retry, polling cadence or activation authority.
