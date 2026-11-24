# Worktree runtime and local verification

New worktrees with the SQLite dependency install a private dependency tree when sharing supplies none. They open an in-memory database using the provisioning Node executable and record its path for the commit and push hooks. Both hooks repeat the check. A missing executable or unloadable binding stops the hook before its checks. Existing unpinned worktrees continue using their existing PATH.

An indeterminate affected-test listing returns failure. This can delay a push under heavy load. The failure preserves the diagnostic output and the test count. Known empty and broad selections retain their existing behavior. Full verification belongs to Throughput.

Installation adds disk and network cost when the dependency source is missing. The normal sharing path still uses its existing clone or link. No repair should install into a shared symlink. A failed provisioning attempt may leave a registered worktree for inspection.

Older target branches receive the direct binding check at creation. The pin is written only when the target includes the new helper. Independent second-pass review concurred after the installation deadline, direct check and subprocess regressions were added. The reviewer inspected source only.

Complete verification of the first revision flagged the CommonJS call embedded in the child script. The revised child explicitly selects ES module mode and imports Node's module loader to open the absolute checkout-local dependency. A private Node 24 probe successfully opened and closed the in-memory database.

The complete suite detected an unclassified SQLite open in the child probe. The registry inventory now records this probe as transient. It opens an in-memory database and closes it in the same expression. The registry's detection of unclassified source files and its long-lived store checks remain active.
Independent review concurred after tracing the actual child open and close. The review was read-only.
