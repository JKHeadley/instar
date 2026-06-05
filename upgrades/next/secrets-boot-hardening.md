<!-- bump: patch -->

## What Changed

Hardened the messaging layer against a failure seen in the field: when the
encrypted-secrets read fails at startup, the unresolved secret marker used to flow
into the messaging adapter as-is — crash-looping the server on a type error and
leaving the message poller spinning uselessly against a dead address. Now the
adapter recognizes an unusable credential, announces it loudly, and runs in a
well-defined reduced mode instead: no polling, relay sends still work, and the
reason is visible in its status. The deeper at-the-source fix (per-agent keychain
keys and a loud, fail-fast secrets merge) ships separately; this change makes the
messaging layer structurally unable to crash or go silently deaf regardless.

## What to Tell Your User

If your agent ever starts up while its encrypted secrets are unreadable, it now
boots in a clearly-announced reduced messaging mode instead of crashing or going
silently deaf — and a normal restart brings everything back. Nothing changes during
ordinary startups.

## Summary of New Capabilities

- The messaging adapter refuses to poll with an unusable credential and reports the
  reason in its status, rather than spinning forever against a dead address.
- The server boots through an unresolved messaging credential instead of
  crash-looping on it.
- Maturity: stable; behavior on healthy startups is unchanged.
