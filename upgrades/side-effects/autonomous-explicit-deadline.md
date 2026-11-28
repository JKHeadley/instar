# Autonomous runs honor their stored deadline

The stop hook recognizes fractional RFC 3339 timestamps with UTC offsets. It honors the declared end time in both ordinary and native-goal stop paths. Older state records derive a deadline from the start time and duration. Malformed fields use that fallback when it is valid. The existing completion check still governs early completion.

The persisted deadline is the authority. The hook interprets that record at each stop and sends the existing terminal receipt. It does not decide completion from a checkbox count. The change is local to the machine reading the run state, with no cross-machine coordination or new message type.

Existing agents receive the bundled hook during update when their installed bytes match the previous stock version. Customized hooks remain under operator control. The migration is idempotent. Rollback restores the prior hook code. Any run already closed remains closed and requires a new authorized run to resume autonomous operation.

## Second-pass review

**Reviewer:** Pipeline Strategy (echo-pipeline-strategy, independent Studio session)

Concurred on the final implementation and test diff against main 7cb5d8b1f747df20d0e232bd93006f33fff6c581. Tracked diff SHA-256 ca9fbd19553f84c35268b4edeb101c3a618b6e6b04e02346efcfdbea2a5fb4c9. Review receipt fac0c394-0813-46f6-8dad-8ca816a1b14d. The reviewer confirmed the warning correction and ran 220 tests across 20 focused unit files.
