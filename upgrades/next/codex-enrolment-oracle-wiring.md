# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The last piece needed to actually enrol a second Codex account.

Enrolment asks "who is signed in to this credential slot?" The code that answers had learned
to read Codex slots, and the check in front of it had been taught to allow Codex through. It
still failed, for a third reason: the enrolment path uses the Codex-aware reader only when
nobody hands it one — and something always did, the older reader that understands Anthropic
only. The Codex-aware version was correct, wired, and never reached.

A default that a caller always overrides is not a default.

The server now supplies the Codex-aware reader for subscription-account identity. It does so
only there: a separate part of the system asks the same question for a different purpose —
managing where Claude credentials live — and that part is Anthropic-specific by design, so it
keeps what it had.

## What to Tell Your User

- "A second Codex login can now actually be enrolled — this was the last of three separate
  things blocking it."
- "Nothing changes for accounts you already have, and nothing changes for Anthropic accounts."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Enrol a Codex account | The existing verified-add path now identifies an `openai` / `codex-cli` slot end to end |

No new endpoint and no configuration.

## Compatibility Notes

For an Anthropic account the behaviour is identical: the composite reader checks for Codex,
finds nothing, and delegates to exactly the previous code. A Codex slot that cannot identify
itself is still refused, now with a reason naming the Codex slot rather than blaming an
Anthropic lookup. The credential-field guard still runs first, so the registry still cannot be
handed a token.

## Evidence

12 tests. The three new ones: the server passes the composite reader — verified by restoring
the old wiring, which makes it fail, so it catches precisely the defect that shipped; the
credential-location ledger keeps its Anthropic reader, so the change cannot quietly widen into
a feature it was not scoped for; and an end-to-end property stated as behaviour rather than
wiring, with a control asserting the plain reader genuinely cannot resolve the slot — so the
result is attributable to the composite rather than to an easy fixture.

This is the third layer this feature broke at, and all three passed every test that existed at
the time, because each test stopped one layer below the break. Each was found by attempting
the enrolment on a running system, not by reading code.
