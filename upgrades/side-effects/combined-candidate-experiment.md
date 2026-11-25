# Combined Candidate Experiment Side Effects

Tier 1, documentation-only. Three tracked documents plus immutable sample membership; no runtime implementation, test execution, publication, queue change or merge is performed by this change.

- Over-block: conservative initial exclusion of auth/security/held work limits batch selection; it does not change existing gates.
- Under-block: path-disjoint candidates can still interact; fresh owner overlap review and complete combined testing remain mandatory.
- Layer fit: reuse the existing single-candidate complete verifier; do not add a parallel source of green authority.
- Signal versus authority: the sample membership and compatibility tree are planning evidence only. Existing signed exact-head result and safe merge retain authority.
- Interactions: train-created queue holds must be tracked separately and removed on abandonment; active verification and all prior holds are preserved.
- External surfaces: proposed future publication is Chief-owned and separately recorded. This documentation performs none.
- Multi-machine posture: design is repo-replicated; any future peer run uses current pinned signatures. Cross-machine shard protocol is explicitly unimplemented/default-off.
- Rollback: revert documents. Any later unmerged train can be abandoned without installed-state migration; original candidates still need their own valid verification.

Independent review: root independently reviewed the final design SHA256 ce81335791c90f923ceb837e50c651fc9a7f7292fa3f23b900f93f5b4b617ff1 and proposal SHA256 fe385293c77e0c1486386e57326015e8f7d6aea2699204b1965c04b5f7b06cd2. Root concurred with exact-tree authority, fresh Mini key/lease/fingerprint checks, provisional adjacency and preserved holds. Root requested the retry-policy wording correction; it is included. No implementation, full test result or runtime activation is claimed.
