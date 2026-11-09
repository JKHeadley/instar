# Convergence Report — Evolution retention targets

## ⚠ Cross-model review: DEGRADED — ALL ROUNDS

External Codex CLI reviews were actually attempted. The installed agent-home dist resolved
the retired gpt-5.5 model and timed out twice. Compiling current origin/main locally resolved
gpt-6-astra; those CLI attempts also timed out. No successful external opinion is claimed.
Gemini is not authenticated. Internal independent review plus the live constitution inspector
provide the evidence below; external assurance remains reduced.

## ELI10 Overview

The work lists have a bug at exactly the point their targets fill up. This fixes every copy
of the bug while preserving unfinished work. Finished records move into the existing archive
only after complete content is durably saved and checked. Taking a record out of a work list
never means telling other machines to erase its memory.

Open work can exceed the target. Accurate counts and operational warnings make that visible.
The archive also keeps complete local copies of peer memory, so it does not depend on another
machine being online for a reader to recover a lesson.

## Original vs Converged

Started from the corrected September preserved spec, including its unresolved preservation,
identity, replication and alarm tasks. Re-measured November state instead of using August's
352/300 count. Chose soft total retentionTargets with backwards-compatible aliases. Review
required strict reads, archive fsync/readback, replication-key precedence, full-content archive
anti-entropy, bounded pagination, durable retry parking, and a finite archive document ceiling.
Existing auto-expiry behavior is preserved; retention reuses its archive.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|---|---|---|---|---|
| 1 | independent all-lens reviewer; constitution | 6 | 0 | strict reads; fsync; pagination; replication identity precedence; live proof; full replica custody |
| 2 | independent all-lens reviewer; constitution | 1 | 3 | bounded per-peer backoff, breaker, metadata; precision inventory/order/cost clarified |
| 3 | constitution; internal delta review | 1 | 0 | durable park after six failures rather than endless breaker probes |
| 4 | constitution; internal delta review | 1 | 0 | 64 MiB archive document ceiling; source retained and pressure explicit |
| 5 | constitution; internal final delta review | 0 | 0 | quiet safety/design round |

Standards-Conformance Gate, round 1: ran (95 checked, 1 flag: single-machine survivability).
Standards-Conformance Gate, round 2: ran (95 checked, 1 flag: retry brakes).
Standards-Conformance Gate, round 3: ran (95 checked, 1 flag: bounded cumulative self-action).
Standards-Conformance Gate, round 4: ran (95 checked, 1 flag: bounded host resources).
Standards-Conformance Gate, round 5: ran (95 checked, zero flags; parent fit).
An initial path-based invocation was rejected because the temporary worktree is outside the
server specsDir. All actual inspections then used the supported full markdown request.
External passes were attempted on changed bodies; all returned degraded timeout. These are
not described as clean opinions. Internal reviewer grouped all six required perspectives:
security, scalability, adversarial, integration/deployment, decision completeness and lessons.
It also contested evidence, judgment classification, and subsystem foundations.

## Proportion

Tier 2 because hot eviction changes durable state. Five constitution rounds of a six-round
cap. More design work than the four arithmetic expressions: preservation is load-bearing,
not a reason to ask the operator to approve an unfinished design. Source changes begin only
after convergence and desk approval under the standing non-critical process statement.

## Left behind

No unresolved safety/data-loss design findings. The archive ceiling can hold retention and
replication under resource exhaustion; this is deliberate conservative behavior, observable
as degraded pressure. No hard bound on active work is claimed. Replication is eventual,
not instantaneous protection against loss before a peer has caught up.

## Full Findings Catalog

1. DESIGN, integration/lessons: pool-only archive reads violate single-machine survivability.
   Resolved: durable full-content local replica union and gossip via existing presence cadence.
2. DESIGN, integration: projected operational puts cannot preserve full arbitrary memory.
   Resolved: full record digest/envelope copying, no projection or silent text clamping.
3. DESIGN, adversarial: archived variants conflict with live replication keys and stop repair.
   Resolved: actual replication identity precedence; live first, latest archive otherwise;
   auto-expiry keeps its reversible cancelled projection.
4. DESIGN, durability: rename/readback alone does not survive power loss.
   Resolved: fsync temporary archive and parent directory before hot eviction.
5. DESIGN, data integrity: tolerant hot-store read can turn corruption into healthy empty.
   Resolved: strict shape validation and mutation refusal; report unknown on read failure.
6. DESIGN, scalability: no-TTL full archive eventually exceeds 2 MiB peer response bound.
   Resolved: bounded paginated export and targeted kind/id lookup, no truncation.
7. DESIGN, evidence: a copied real queue is not proof of live deployment.
   Resolved: require harmless real API save and independent actual hot/archive reads after main.
8. DESIGN, P19: finite per-attempt limits do not bound cumulative retries.
   Resolved: durable parked state after six failures on unchanged evidence; changed-URL or
   explicit agent reset re-arms, never successful presence alone.
9. DESIGN, resource safety: whole-file archive rewriting can consume unbounded host resources.
   Resolved: 64 MiB pre-read/write ceiling; preserve source, stop import/cursor, emit pressure.
10. PRECISION, inventory/order/cost: enumerate import/retry invariants, persist stable export
    order, distinguish network deadline from synchronous rewrite duration. Clarified in passing.

## Convergence verdict

Converged after final internal delta review and the fifth constitution pass. Nine frontloaded
decisions, zero cheap-to-change tags, zero unresolved user decisions. External review remains
explicitly degraded, not a passed gate. Desk approval follows PR #2776's standing statement.
