# Native lock-call measurement (12.12 / 12.13)

Run these cases only after the proof owner has established a clean, isolated account with exactly the A+B proof servers as guard-spawning authorities. Pass `--isolated-guard-population` to record that prerequisite. The flag is an assertion, not a scan or an isolation mechanism. A prior unknown actor cannot be dismissed because a later scan is empty.

The driver additionally verifies both listener identities, complete lifetime histories, a matching store identifier, and no surviving baseline guard. It never substitutes one responding server for the other. Exactly one fresh request/guard may be measured. Its positive native watch checkpoint must precede departure; its native final seal and positive child exit must match. Both final histories are read after observed human completion. Any extra actor, overflow, restart, missing witness or failed process query stays unmeasured.

For logout, a clean native terminal witness is still mandatory. Killing the guard or server during logout cannot be turned into a measured zero. No process-exclusion fallback is used.

The common shipped helper and proof helper must have identical source identity. The source change requires the ordinary build/sign and permission-validation workflow before hardware proof. Unit results do not certify a Mac.
