# trust-records-holder-authored — round 6 log (2026-11-18, round cap)

Reviewers: same three internal reviewers (re-asked), claude-opus-5-5; codex-cli gpt-6-astra (ok); clean-door claude-code claude-fable-5-2 (ok). Standards-Conformance Gate: ran (2 flags: Trust Is Earned by Work = approver item 14a; Attributed Statements, answered before review by quoting the Chief of Staff's brief). Spec hash at review: c1f3826e.

Round-5 findings: resolved (security D3 resolved; integration 0 design; decision-completeness 0 design). No reviewer found a way for a peer to grant, launder or double-run.

Design findings at the cap (5): an owner's device withdrawal on B may never name A's unreplicated acceptance, so after a hand-back a revoked device approves again (security); an owner's lowering on B is lost when the lease returns to A (fable); the joining-machine check `othersImported` loses its evidence under own-only queries, risking a first-machine legacy import on a joining machine (codex); pre-import change history ends existing legacy grants at upgrade (codex, availability); a short post-wake window before a same-epoch peer lease is seen (security, precision-to-design).

Fixes written into the spec after the round (NOT reviewed): epoch in acceptance, withdrawal and change keys; a peer withdrawal at epoch W ends own acceptances of the subject at W or lower; a peer non-automatic change at W puts the kind on ask-first unless an own change is above W; pre-build changes judged by today's rule among themselves; `legacyImportedAnywhere()` evidence query for the import; proceed-once requires a lease view refreshed since wake; notice suppressed while contested and writer list kept in a test.

Left behind (precision): integration build notes (hook fires only on change of (epoch, holder); contested call site is MultiMachineCoordinator; withdrawal partial-failure reporting; local sink passes writer explicitly; thread a `verified` flag to the notice); signature canonicalisation (RFC 8785); handover notice from the machine that lost the lease; crash-before-persist test; `person` named in the source list.
