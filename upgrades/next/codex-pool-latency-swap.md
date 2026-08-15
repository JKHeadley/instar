# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Codex accounts can now be enrolled in the subscription pool, and an internal Codex
call can now choose which account it runs on.

Both were previously impossible, for reasons that were invisible from outside:

**Enrolment.** The pool refuses to add an account whose credential slot it cannot
identify — a sensible guard, since two rows pointing at the same login would make
"switch to the other account" a switch to itself. But the only identity check asks
Anthropic's OAuth servers who is signed in, so handed a Codex slot it simply could not
answer. Enrolment failed as `email-unresolved`. That is why a pool could hold six
Anthropic accounts and zero Codex ones while Codex logins sat authenticated on disk.

A Codex slot can answer the same question offline: its credential file carries an OIDC
id_token whose payload holds the account email, a stable per-account id, and the plan.
The identity check now lets the slot identify itself — a Codex home has that token, an
Anthropic one does not — and falls back to the existing Anthropic path otherwise, which
is unchanged.

**Account selection.** Internal Codex calls never named an account: the child inherited
the ambient `CODEX_HOME`, so every one of them used the default login. The ability to
target a specific slot existed in the spawn layer and was honoured — this path just
never used it. So "move a struggling account's work to the other account" had nothing
to move.

## What to Tell Your User

- "If you have more than one Codex login, I can now hold both — before, I could only
  ever see one of them."
- "Nothing changes about which account I use until that's deliberately configured."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Enrol a Codex account in the subscription pool | The existing enrolment path now accepts a Codex credential slot |
| Point an internal Codex call at a specific account | `resolveAccount` on the Codex provider (unused by default) |

No new endpoint and no configuration.

## Compatibility Notes

**Nothing changes by default.** A Codex call that does not name an account behaves
exactly as before — same account, same result — and nothing in the shipped wiring names
one. A broken or throwing account resolver also falls back to the previous behaviour
rather than failing the call.

The Anthropic identity path is untouched: any slot that is not a Codex home takes the
identical pre-existing check with the identical result. A Codex slot that cannot
identify itself is reported as a Codex problem rather than mislabelled as an Anthropic
failure.

Reading a credential never exposes it: the identity reader returns an email, an account
id and a plan, and no token material.

## Evidence

26 tests across two tiers.

Unit: the identity reader (real-shaped read, two logins resolving to DIFFERENT
identities, every named failure reason, never-throws across six malformed shapes, and
two security canaries); the composing identity check (Codex resolves, a CONTROL that a
non-Codex slot still reaches the Anthropic path verbatim, a broken Codex slot reported
honestly, a throwing probe degrading safely); and account selection (no resolver means
no override, two accounts genuinely distinguishable, per-call rather than
per-construction resolution, all three degradation paths, and a CONTROL that env
scrubbing still holds when an account is selected).

Integration: the tier that would have caught the real defect, since unit tests of a
reader pass whether or not it is wired. It drives the real registrar against a real pool
and asserts BOTH directions — the Anthropic-only check REJECTS a Codex account, and the
composing one enrols it. The identity guard is shown still biting: a caller-supplied
email contradicting the slot is refused, and a slot with no credential is refused.

Both security canaries carry controls: the planted secret is asserted absent from the
result AND asserted present in the bytes being read, so a clean scan is a measurement.

Verified against real credentials, not only fixtures: two Codex homes on this machine
resolve to two distinct accounts. The 45 pre-existing Codex provider and env tests still
pass.
