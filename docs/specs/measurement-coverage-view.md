---
title: Independent measurement coverage on the existing maturation board
slug: measurement-coverage-view
tier: 1
status: draft
---

# Independent measurement coverage

The existing board enumerates reviewed/maturing features, excludes bare guards, and has no independent denominator for jobs, decision points or whole efforts. Add a read-only coverage part to that board, backed by the existing owners. This projection is neither a feature registry nor a measurement store.

## Denominator and joins

Enumerate feature flags from all boolean enabled/dryRun defaults (both on and off), the full guard manifest, developer gates and discovery definitions. Normalize only trailing enabled/dryRun; merge identical paths, retain their source names. Include every current provenance census decision point, every loaded scheduler job (including disabled), every initiative (including completed), and registered local capability definitions from the validated producer projection or canonical doorway sources. This is a definition census, not the advisory receiver's availability/placement classification. A valid observed-empty projection may have zero definitions; unreadable, foreign or truncated sources remain unavailable/incomplete. Keep kind namespaces distinct: registry-entry counts are not a count of unique capabilities across different namespaces. Keep source-unavailable/truncated notices visible; zero available entries never proves complete inventory.

Join features to measurement subjects only through exact existing rollout flagPath or ladder flag/subject links. Join an effort to its own initiative subject, preserving parentProjectId; a graduated or inactive D7 subject retains its independently read declaration and is explicitly inactive, never silently missing-contract. No title search or slug similarity. Multiple exact subjects remain ambiguous, preserving every association. Memoize proof once per unique subject per request. Generic effort/decision/job/capability contracts link through existing Initiative.measurement with exact kind/key as specified in measurement-subjects.md. Retain duplicate target bindings as ambiguous and never borrow an ordinary feature contract. Telemetry enrollment remains separate from a corroborated outcome baseline. Source authoring is implemented in that companion increment; deployment and full verification remain required.

Use the existing BlockerLifecycleService.maturationOutcomeForContract read against the freshly resolved exact owner to distinguish missing/invalid declarations, unavailable/stale/sample-poor evidence and numerically corroborated comparisons. A declared contract is never counted as verified. Whole-effort parents never inherit a child's success, and a child's missing measurement remains visible. This coverage is advisory and cannot activate features, promote a rung, or interrupt ordinary services.

## Read and bounds

Add part=coverage to the existing authenticated board route. Local inventory is independent of review JSON. Pool reads use the same origin-local part on known peers with credential allowlist and strict schema/size checks; old peers answering another board shape are unavailable. No new scheduler, file discovery walk, network to unrelated hosts or database. Compute counts over the full inventory before trimming rows. Bound returned rows/bytes, disclose omissions and source failures. A cached response displays its original generated time; a cache must not refresh evidence timestamps or imply live proof.

## View and verification

The existing phone/desktop board gets a concise coverage summary and tap-through table, with plain labels for measured comparisons, missing baseline/contract, stale evidence and unavailable sources. Parent/child links use existing initiative and composition edges only. Numeric chart work and the end-to-end real-activity/human-intelligibility proof stay in the same active run; this view must not claim them completed.

Tests independently add an unmeasured default-on flag, an unreviewed decision, disabled job and parent/child effort and verify all remain counted. Test exact/ambiguous joins, unavailable source, omission/count integrity, foreign peer origin, malicious strings, unsupported old peers and source freshness. Render with textContent and accessible phone layout. Targeted real-route plus DOM tests; no blanket fullsuite claim.

## Active carrier

The remaining work is the original authorized run, recorded through the existing registry:

> **CMT-001** — Complete topic139374: independent coverage for features, decisions, jobs, efforts and components; enforce missing-baseline claim/promotion holds; preserve versioned history; deploy parent/component trend views; verify real activity and understandable visuals; recurring review reports here with bounded corrective work. Report any remaining gap by the original November6 22:44Z ceiling.

<!-- tracked: CMT-001 -->

