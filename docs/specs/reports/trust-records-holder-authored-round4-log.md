# trust-records-holder-authored — round 4 log (2026-11-18)

Reviewers: same three internal reviewers (re-asked), claude-opus-5-5; codex-cli gpt-6-astra (ok); clean-door claude-code claude-fable-5-2 (ok). Standards-Conformance Gate: ran (2 flags: Trust Is Earned by Work, already approver item 14a; An Instar Agent Is Always a Multi-Machine Entity, per-machine levels). Spec hash at review: a0dfb556.

Round-3 findings: resolved (security: no grant path; decision-completeness: 0 design this round).

New design findings (deduplicated, 5): lastForeignEpoch can be lowered by a rebuild or a stale restore, reviving an earlier-term approval (4 reviewers); the coordinator exposes no replaced lease, so a foreign term missed while down is invisible (integration); "single machine" decided by coordinator absence lets a multi-machine agent with a failed coordinator count e0/pre-build grants (security); withdrawals keyed by id do not reach the other holder's acceptance after a hand-back (fable); existing legacy grants anchored on a peer change would collapse at upgrade (fable).

Resolution: lastForeignEpoch + lastSeenEpoch, never lowered, not backed up, missing -> currentEpoch-1, a gap of more than +1 presumes a foreign epoch (a same-machine lapse is exactly +1); single machine decided by the registry, multi-machine without a coordinator fails closed; withdrawals narrow by subject; legacy anchor matched by changeId from any writer; decision 4 justification restated (no cross-machine-verifiable grant before identity piece 2) and made approver item 14c; restore detection made concrete in checkAtLoad; peerNarrowingOfCurrentTerm count; residuals for same-id restore and split brain.

Left behind (precision): optional response signature is diagnostics-grade (kept per the Chief of Staff's instruction, honest limit stated); glossary of local terms; request-id collision across machines.
