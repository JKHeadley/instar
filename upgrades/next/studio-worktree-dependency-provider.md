# Verified worktree dependencies

An opted-in Mac can provision fresh Instar worktrees from a local, verified dependency seed. Each new checkout gets a private copy that shares disk blocks with the seed until written. The checkout still passes the usual native dependency and Git hook checks before it is ready.

The setting starts disabled. Existing checkouts are unaffected.
