# trust-records-holder-authored — round 2 log (2026-11-18)

Reviewers: the SAME three internal reviewers as round 1 (re-asked, per the 2026-11-18 rule), session model claude-opus-5-5; external codex-cli gpt-6-astra (ok); clean-door claude-code claude-fable-5-2 (ok). Standards-Conformance Gate: ran (1 flag: Trust Is Earned by Work). Spec hash at review: b562d95e.

Round-1 findings: all resolved or nearly (security reviewer: no remaining path for a peer to produce a grant).

New design findings (deduplicated, 8): "own arrival order" is not persisted, so ask-first flips across restart (4 reviewers); honest standby load-time restores write `change` records that put the holder's kinds into ask-first (2); ask-first aliased to unreadable history blocks the one-action re-ask forever; the lease-acquisition supersede record has no type/field (old issue 1), fires on every restart including single-machine, and races admit() (4); dispatch-by-actionIdentity poisons all future approvals for an identity (2); autonomy-profile check does not run without own history (codex); signature is strippable (precision for this design); decision-10 sentence does not cover existing acceptances and breaks exact statement matching (2).

Resolution: ask-first removed entirely (trust and autonomy levels are machine-local files, so a peer change describes the peer's level; levels read only own changes); legacy ends on own changes or peer `source: person` changes only, order-free; one-time grants and requests carry the lease epoch in the record key (no type/field change, read-time comparison, restart keeps the epoch, single-machine epoch 0); dispatch marks only its approval id; invalid signature refuses trust records only; decision 10 states the exception for the approver instead of the acceptance-sentence; /trust/summary gains a trustJourney block; switch resolution spelled out incl. throwaway agents; writer mapped via per-peer meta (sanitised ids).

Left behind (precision): request ids can coincide across machines (denial-equivalent); measured handover count goes into the approval request; own-journal rotation (rotateKeep 0) is pre-existing.
