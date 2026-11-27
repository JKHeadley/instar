# Legacy default job reconciliation — ELI16

Some agents still use `.instar/jobs.json` for scheduled jobs. Setup gave them a starter list, and the setup refresh path could add newer defaults. Ordinary updates installed newer agentmd jobs but did not reconcile the legacy list before its migration. A second machine could therefore boot with fewer default jobs than the original machine even after updating.

The update pass now checks the legacy list for missing shipped defaults before it migrates that list. It leaves existing schedules, enabled settings, priorities, and custom jobs alone. A missing default gets the current shipped definition. The same refresh runs during setup as before.

One default needs special care: `git-sync` can stage the agent's local config and backups, which may contain tokens. A Git remote is not permission to start that job. A newly added git-sync entry is disabled, and refresh never re-enables a disabled copy. An operator may still enable it explicitly after reviewing their repo's exclusions. Luna's git-sync should stay off.

This step covers shipped legacy defaults. Machine-specific user jobs and external project dependencies need their own catalog and placement mechanism; they are not inferred from source defaults.
