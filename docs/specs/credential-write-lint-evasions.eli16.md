# The credential-write guard could be switched off by splitting a string

> The one-line version: the rule that stops secrets being written outside the approved path only armed itself when it spotted a particular name written out in full, so writing that name in two halves turned the whole rule off.

## The problem in one breath

Every write of the Claude credential is supposed to go through one controlled path. A check enforces that, and part of it watches for raw writes straight to the system keychain.

To avoid complaining about the *other* keychain stores this system uses — which are legitimate and have nothing to do with this credential — that part only arms itself when the file mentions the specific service name in full. That scoping is sensible. It is also the whole weakness: assign the name in two pieces and join them, and the rule never arms at all.

Two smaller ways past existed alongside it: assign the credential store to a variable and write through the variable, or reach the write method with bracket notation instead of a dot. All three were confirmed getting past the check before this change.

## What already exists

- **One controlled path** for credential writes, holding a lock so two writers cannot interleave.
- **The check**, in the standard set that runs before every commit and in continuous integration.
- **A deliberate narrowing** so the other, unrelated keychain stores never trip it.

## What this adds

**Split strings are joined back together before the check decides whether to arm.** Writing the name in two pieces, or several, no longer disables the rule.

**A variable holding the credential store is treated as the store**, following assignments to a fixed point.

**Bracket access is recognised** alongside dot access, for both the store write and the credential-writing method.

**The detection is now a separate importable function**, so it can be tested with small examples, and the command body is guarded so importing it does not run it — without that, importing it in a test would stop the test run the moment the codebase had a real violation.

## The safeguards, and why they matter more here than usual

Widening a rule that blocks commits risks the opposite failure: flagging correct code everywhere. That would be worse than the hole, because the fastest way to get rid of a noisy check is to switch it off.

So five tests push the other way. A different keychain service is not flagged. A raw keychain write with no mention of the guarded service is not flagged. An unrelated store's write is not flagged. An unrelated variable assignment is not absorbed. Comments are not violations.

**Proven in both directions:** restored to the old behaviour, seven tests fail and seven pass — and the seven that pass are exactly those five controls plus the plain cases. That is what makes them guards rather than echoes of the change. The real codebase passes cleanly before and after, so no new work is created.

## How it was found

A peer agent audited every check of this kind for defeat-by-renaming, classified twenty-five as defeatable, and ranked them by consequence. This one was its top recommendation, because the thing behind it is a secret.
