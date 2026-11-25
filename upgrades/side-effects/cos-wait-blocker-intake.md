# Side-effects review for project wait blocker intake

This draft adds candidate intake behind `chiefOfStaff.waitBlockerIntake`, default off. The opt-in also requires the existing blocker ledger. Current installation defaults require no migration.

- Over-block and under-block. The code makes no authorization decision. Missing history or holder status prevents the candidate write. Existing owner notices remain in place.
- Abstraction and authority. The Chief of Staff loop projects exact journal references into the existing blocker ledger. A candidate records a signal and does not represent an owner decision. The ledger serializes creation and checks the source identity on retry.
- Interactions. The active coordinator skips the first tick after takeover. A local restart reuses an existing candidate. The active process skips repeat writes while the same wait remains visible.
- External surfaces. No route or message was added. When enabled, internal candidates appear through existing authenticated ledger reads.
- Rollback. Leave the switch unset or disable it. This stops intake. Candidates written by a trial remain as audit evidence.
- Activation blockers. Require a fresh check after legacy data or a rebind. Enforce current replicated episode and disposition before a candidate can advance or settle. Verify takeover and the owner projections before enabling this on a real agent.

Independent review concurred with committing a default-off draft. The review raised stale candidate authority, legacy check carry-forward, and redundant ledger writes. The switch remains off, the first two findings remain activation blockers, and repeated writes from a continuously visible episode are suppressed.
