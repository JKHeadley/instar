<!-- bump: patch -->

## What Changed

The two clean-up sweeps (old promises, old self-improvement to-dos) can no
longer close something that is still live. The promise sweep now skips standing
rules and anything not pending, and any promise or to-do can carry a hold, with
a reason, that keeps it out of both sweeps until someone removes it. The to-do
sweep no longer deletes: it copies the whole item to an archive first, sends no
delete signal to other machines, and an item can be restored with one call. If
the archive cannot be read or written, it removes nothing. Both sweeps stay in
practice mode by default.

## What to Tell Your User

Nothing closes on its own yet; both clean-up sweeps are still in practice mode.
If there is a promise or to-do you never want cleaned up, tell me and I'll put a
hold on it. If a to-do is ever cleaned up, it goes to an archive I can restore
it from.

## Summary of New Capabilities

- Hold any commitment or action out of auto-expiry: `PATCH /commitments/ID` or `PATCH /evolution/actions/ID` with `autoExpiryHold`.
- Reversible action archive: `GET /evolution/actions/archive`, `POST /evolution/actions/ID/restore`.

## Evidence

The 2026-10-30 feature-maturation review read both ledgers: 395 commitments and
18 actions were eligible, including standing rules, a 2027 token rotation and
unresolved defects, and a live action sweep would have deleted its rows for good.
Unit, integration and e2e tests cover the exclusions, the hold on both branches,
archive-before-remove, the damaged-archive refusal, restore, id reservation and
the no-tombstone replication path.
