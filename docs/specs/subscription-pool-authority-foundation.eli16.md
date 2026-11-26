# Subscription Pool Authority Foundation — ELI16

Instar keeps a local list of subscription accounts. Today, if that file is malformed or cannot be
read, some code can behave as though the list were simply empty. That is dangerous: “I cannot read
the authority” and “there are zero accounts” are opposite facts. The current list/get operations
also scan arrays in ways that make a supposedly bounded observer do unbounded work.

This prerequisite makes the account pool a trustworthy input. It adds a real ID index, a bounded
scan, strict file-size and row-count ceilings, and explicit states for never configured, invalid,
and temporarily unavailable. Errors never turn into an empty list. All existing account visibility
rules remain the same, including the special repair-only treatment of legacy rows with blank email.

The pool is published as a machine-local directory using an atomic staged rename. A separate
machine-bound witness proves the pool existed even if the directory is later lost. Existing
single-file pools migrate with a source digest and a crash-recoverable state machine. Nothing is
copied through ordinary backups, and a pool copied from another machine is refused rather than
adopted. The binding uses Instar's existing persisted machine identity, so changing a hostname or
enabling multi-machine coordination does not require setup.

This does not sign users in, select different accounts, or send notices. It is a foundation that
lets the separate sign-in ledger observe a bounded, honest pool without silently changing account
authority. The ledger stays off until this prerequisite is live and tested at unit, integration,
and production-lifecycle levels.

## Update, 2026-10-06 — the migration step is now built

The move from the old single shared file to the per-machine store, which this spec called for, was built in October 2026 after a second machine inherited the first machine's login locations (instar#2122). On update, each machine publishes its own store from the old file, keeping only logins whose folders exist on that machine. One deliberate difference from the text above: an old file that is still shared through the agent's repository is left in place, never deleted, because deleting it would also delete it on the other machine at its next sync.
