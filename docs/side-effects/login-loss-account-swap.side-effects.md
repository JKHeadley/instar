# Login-loss account swap — side-effect map

- Persistent state: optional scrubbed `sourceTrigger` on existing swap-ledger rows.
- Session lifecycle: a promoted live decision can restart one refreshable
  conversation through the existing SessionRefresh resume funnel.
- Credentials: no credential write, copy, login, or default-slot mutation.
- Network: no new egress; existing quota/account/session surfaces only.
- User-visible output: no new message or attention path.
- Rollout: fleet-dark; development-agent decision soak; dry-run first.
- Rollback: disable the nested trigger or revert; quota swaps remain unchanged.
