# Migration agent fixtures (Seamless Migration Guarantee)

Each subdirectory represents one shape of pre-migration agent state. The
guarantee suite (`tests/integration/migration-guarantee.test.ts`) iterates
these and runs both code paths — `instar job migrate` CLI and
`PostUpdateMigrator.autoMigrateLegacyJobsJson` — against each, asserting
the nine invariants from spec §Seamless Migration Guarantee.

Each fixture directory MAY contain:

- `jobs.json` — the pre-migration `.instar/jobs.json` content. Required.
- `setup.json` — optional pre-migration on-disk state directives:
  ```json
  {
    "preExistingScheduleSlugs": ["foo"],
    "preExistingUserMd": [{ "slug": "foo", "body": "..." }],
    "preExistingMarkers": [".migration-complete.json"],
    "expectedOutcome": "completed | aborted | abandoned"
  }
  ```

The pre-commit gate refuses to delete any fixture from this tree. Adding
new fixtures is unrestricted — they automatically join the suite.

| Fixture | Shape |
|---------|-------|
| `pristine/` | Fresh agent; `jobs.json` exactly as `getDefaultJobs()` produces. |
| `customized/` | Two defaults disabled, two have edited cron expressions, no body edits. |
| `body-edited/` | Two defaults have body edits beyond near-miss threshold (forces fork-to-user). |
| `user-jobs/` | Five user-authored jobs alongside defaults. |
| `retired-defaults/` | Slugs in `jobs.json` that no longer ship as defaults. |
| `mixed-state/` | Both `jobs.json` AND a partial `schedule/` (simulating interrupted prior migration). |
| `multi-machine-drift/` | Two divergent snapshots; merge resolution must drop nothing. |
| `in-flight/` | A run is mid-execution when the migrator starts. |
