# Round 17 — Performance and Frontloaded Decisions

Performed a fresh final pass over the unchanged durability, bounded recovery, operator metrics, retained audit, notice and decision contracts. Reviewable-body SHA-256: `9294f4b98380ebfb6727a408530ea66092e9710d0971e46a82a67ad7347ca5b5`. Independently recomputed full-file SHA-256 including frontmatter: `7c6880438be3257bc25c6755136094cc98b4427d821c697485a048a8341609c1`, matching round 16. No specification/runtime edits or external calls.

## PERFORMANCE

**DESIGN: 0. PRECISION: 0.**

The two-second evidence fallback retains distinct 250 ms primary and 500 ms spool windows, leaving at least 1,250 ms for one authenticated peer attempt. No evidence sink can execute. A single credential-owner outbox still owns transactional admission, unique child claims and fenced outcomes across main/lifeline workers. Ambiguous acknowledgments return to that same authority rather than creating a second executor.

The 1,000-operation/256 MiB payload limits, bounded children/derivations, persistent per-child attempt ceilings and original six-hour deadlines remain explicit. Work stays off the serving event loop. Archive movement does not erase origin evidence, reset metrics or skip rows behind recovered shards; indexed reads and independent shard cursors remain required.

Full-funnel metrics separate logical operations, physical children and attempts. Transactional updates and idempotent source events prevent replay inflation; unavailable data stays stale/unknown instead of zero. This preserves the resolution of round-14's actual instrumentation gap.

N1–N10 still enforce finite reserved notices, one process/boot owner, non-transferable single-use consumption and one paced attempt. The projection's 30-second bound does not extend an ownership lease or survive observer-health loss. Each dequeue must satisfy current policy; a long multi-operator fan-out cannot reuse an expired snapshot. Restart tests forbid old-permit reuse and fabricated availability. No unbounded retry, new authority or new resource leak found.

Browser writes require the authenticated capability/receipt proof; the first unsupported build holds. The two-build threshold triggers transport migration, not permission to continue sending. Bounded canary self-healing cannot replay uncertain requests. No further performance defect identified.

## FRONTLOADED DECISIONS

**DESIGN: 0. PRECISION: 0.**

Verified the numbered Frontloaded Decisions section directly: **9 decisions; 0 cheap-to-change tags; 0 contested cheap tags; 0 unresolved operator policy decisions**. It covers recording/display, format, preference scope, evidence labels, HOLD/uncertainty, companions, audit/retention/limits, existing ASP and managed browser ownership/forms.

Justin already approved HOLD with notification and implementation. The concrete failure limits and alternate account enrollment requirements are disclosed. The operator need not make another policy choice before implementation. Runtime observation fixtures, receipt proofs, migrations, production wiring and activation tests remain necessary engineering work; none is claimed complete by approval or this review.

## Independent gate verification

Read conformance-round-17.json: **90 checked / 0 findings**, `degraded:false`, and a passing 90-article canary.

Read both actual round-16 external outputs and external-round-17-delta.json. The actual Codex report declares **0 DESIGN / 3 PRECISION** and explicitly withdraws the Web-first design objection. The actual Claude report declares **0 DESIGN / 2 PRECISION**. The delta artifact names this exact unchanged reviewable-body hash and those same counts; it records a legitimate unchanged-body reuse, not a new external execution or an abbreviated review. Their remaining PRECISION declarations are preserved.

This independent final internal pass is **0 DESIGN / 0 PRECISION**, following a quiet round-16 internal pass. No additional external round or design expansion is requested by these perspectives. The parent owns the aggregate convergence determination and implementation handoff.
