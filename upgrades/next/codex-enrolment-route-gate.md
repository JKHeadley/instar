# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Enrolling a Codex account now actually works.

The previous release taught the system to recognise which account is signed in to a Codex
credential slot — the thing standing between you and holding two Codex logins. It worked,
and enrolment still failed, because there were two doors rather than one.

The second door asks a cruder question than the first: not "who is signed in here?" but "is
this even a kind of account we know how to identify?" That door had its answer written into
it directly — Anthropic only. Correct when written, since Anthropic was the only kind we
could identify. It was not updated when Codex became identifiable, so it kept turning Codex
away without ever asking the door behind it.

It now asks the identity layer what it covers instead of carrying its own copy of the
answer, and that list lives beside the code that does the identifying — so adding a new kind
of account and declaring it identifiable are the same edit.

## What to Tell Your User

- "If you have a second Codex login, it can now be enrolled — the last release got close but
  a second check was still turning it away."
- "Nothing changes for accounts you already have."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Enrol a Codex account | The existing verified-add path now accepts an `openai` / `codex-cli` slot |

No new endpoint and no configuration.

## Compatibility Notes

The gate decides only whether the identity question is worth asking; it grants nothing. A
Codex slot that cannot prove which account is signed in is still refused, with the same
reason as before. The credential-field guard still runs first, so the registry still cannot
be handed a token. Accounts already enrolled are untouched.

## Evidence

9 tests. The load-bearing one is a regression test: restoring the old inline check makes it
fail, so it catches precisely the defect that shipped. A control proves the gate still
refuses a kind of account nothing can identify — without it, a gate that admitted everything
would pass equally well. A consistency test drives the real identity layer for every
advertised kind and asserts each is genuinely answerable, which guards the opposite failure:
advertising something with nothing behind it would trade a false refusal for a false
acceptance.

Worth recording how this was found: by attempting the enrolment on a running system, not by
reading the code. The previous release's integration test enrolled a Codex account
successfully, but started one step past the door that was broken — green tests over a
feature that did not work.
