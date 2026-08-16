# The third door

## What this is

The last piece needed to actually enrol a second Codex account — and the third time this
same feature has been broken at a different layer.

## The story so far

Three things had to be true to hold two Codex logins.

**One:** the system had to be able to read which account is signed in to a Codex credential
slot. It could not. That was fixed, and it works.

**Two:** the enrolment check in front of that had a list of account types it would even
consider, and Codex was not on it. It turned Codex away without ever asking. That was fixed,
and it works.

**Three, this one:** the enrolment code says, in effect, "if nobody hands me a way to
identify accounts, I will use the one that understands Codex." That sounds like a safe
default. But something always hands it one — the older component that only understands
Anthropic. So the Codex-aware version was never reached. It sat there, correct, unused.

## The lesson, which is worth more than the fix

A default that a caller always overrides is not a default. It reads like a safety net and
behaves like dead code.

And more importantly: all three of these breaks passed every test that existed at the time.
Each test was real and each one checked something true — but each one stopped at the layer
just below the thing that was broken. Testing the reader does not test the check in front of
it. Testing the check does not test which reader got handed in.

The only thing that found any of these was trying to actually enrol the account on a running
system and reading the error. Three times.

## The fix

The server now hands the enrolment path the Codex-aware version.

Deliberately, it hands it ONLY there. There is a separate part of the system that also asks
"who is signed in here?", but for a different purpose — managing where Claude credentials
live. That part is about Claude specifically, and teaching it about Codex would change how it
handles Codex folders it was never designed to touch. So it keeps what it had, and a test
holds that line so a future edit does not quietly widen it.

## What could go wrong

For an Anthropic account, nothing changes: the new version checks for Codex, finds nothing,
and hands off to exactly the old code. A Codex slot that cannot prove who is signed in is
still refused — now with a clearer reason, saying the Codex slot could not identify itself
rather than blaming Anthropic for not knowing.

## What you would notice

A second Codex login can finally be enrolled. Accounts you already have are untouched.
