# trust-records-holder-authored — round 3 log (2026-11-18)

Reviewers: same three internal reviewers (re-asked), claude-opus-5-5; codex-cli gpt-6-astra (ok); clean-door claude-code claude-fable-5-2 (ok). Standards-Conformance Gate: ran (2 flags: Trust Is Earned by Work; A Dark Feature Guards Nothing), both turned into named approver items (decision 14) before reviewers started. Spec hash at review: d09161e7.

Round-2 findings: all resolved (security: no grant or laundering path found, third round running).

New design findings (deduplicated, 7): the lease epoch moves on a same-holder lapse re-acquire, killing pending approvals with no handover (3 reviewers); `source: person` does not exist in TrustSource, and a whitelist filter widened authority versus today (2); pre-build records revive after a hand-back that happened before the upgrade; admission race across a handover during the dispatch write (codex); restored own stream lacks identity binding (codex); unreadable peer `change` still drives unreadable history / ask-first (fable); raised levels with no own history survive a new-id restore.

Resolution: term = epochs with no foreign holder, via own `lastForeignEpoch` in state/trust-term.json (backed up), record counts iff epoch > lastForeignEpoch, fail closed when unknown; legacy ends on any peer change except the closed automatic sources `revoked` and `default`; pre-build one-time records dead on multi-machine agents (one re-ask at upgrade); admission recheck after the dispatch write; own stream counts as own only when its stamped origin equals this machine id; unreadable peer records keep only id-keyed narrowing; raised levels narrowed after a detected new-id restore; every request key form carries the epoch; writer taken from entry.machine; approver named as the operator; decision 14 renumbered; re-ask rate added to graduation.

Left behind (precision): signature is diagnostics-grade (stated); request-id collision across machines (denial-equivalent).
