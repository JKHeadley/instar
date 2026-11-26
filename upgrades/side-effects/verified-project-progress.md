# Verified project progress side effects

The Chief of Staff loop adds a time-limited read in the background. It reads the existing project registry, checks exact linked pull requests, accepts matching records from Local Verify, and reuses the existing deterministic checklist evaluator. It does not run another test suite or model evaluation. The existing Chief of Staff action cadence and restart logic remain separate from the display fields.

The observation is held in memory and displayed with its timestamp. A leader change or restart temporarily loses that observation until the elected reader samples the same source records. Progress is never computed from a repository-wide merge count, an unverified session note, or a transient diff. Incomplete source reads leave stall detection unknown. An older verified event for the same binding can remain visible during a failed refresh.

The refresh shares exact repeated lookups and rotates which projects are observed first within a fixed background read window. Genuine slow or unavailable sources can leave some rows incomplete. The coverage view reads the existing registry and binding list without adding a membership writer. Registry-only rows cannot start work or claim a verified stall.

Independent review concurred after the sampler was limited to the complete non-flushing journal, explicit conflicting pull request references were rejected, and both the outer reading window and its network subcalls were bounded. The review also verified that old checklist results cannot establish a current stall and that sampling order rotates.
