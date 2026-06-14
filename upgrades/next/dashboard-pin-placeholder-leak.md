---
bump: patch
audience: agent-only
maturity: stable
---

## What Changed

The dashboard-link broadcast (the pinned "here is your dashboard + PIN"
reference in the Dashboard topic) no longer leaks an internal placeholder to
the user. Previously, when the 6-digit PIN failed to resolve from the encrypted
vault at server boot (a transient vault read failure under host load left the
config secret-merge incomplete), the broadcast fell back to sending the literal
text "(check your config)" in place of the PIN — a value the user cannot act on
and that reads like a stray instruction.

The broadcast now resolves the PIN defensively: it uses the already-resolved
in-memory value when present, and otherwise re-reads the real PIN straight from
the vault at send time, so a transient boot-time failure still yields the
correct PIN. If no real PIN can be resolved at all, the PIN line is omitted with
an honest, actionable note ("ask me for your dashboard PIN and I'll send it")
instead of ever emitting the placeholder.

## What to Tell Your User

Nothing changes for the common case — your dashboard message keeps showing your
real PIN. This fixes an edge case where, right after a server restart under
heavy load, the PIN line could show the words "check your config" instead of
your actual code. Now the message either shows your real PIN or, if it genuinely
cannot be found in that moment, tells you to just ask for it — it will never
show you placeholder text in place of your PIN again.

## Summary of New Capabilities

- The dashboard broadcast re-resolves the PIN from the per-agent vault at send
  time, recovering from a transient boot-time secret-resolution failure.
- The internal placeholder string can no longer reach a user as a PIN value —
  when the PIN is unresolvable the line is omitted with an honest, actionable
  note.
- `pickDashboardPin` / `resolveDashboardPinFromVault` in
  `src/core/dashboardPin.ts` — pure, never-throws resolution mirroring the
  vault-read pattern used for GitHub tokens.

## Evidence

Verified by 25 unit tests across two files. `dashboard-pin-vault` (16 tests)
covers the resolver against a real on-disk SecretStore: the happy path,
whitespace trimming, absent vault, wrong key, empty/whitespace value, the
unresolved object value, the production dual-key read path, corrupt-vault
never-throws, the in-memory-first preference, vault fallback for each
unresolvable in-memory shape, and the invariant that the placeholder is never
returned as a value. `telegram-dashboard-pin-leak` (9 tests) drives the adapter:
the formatted message renders a real PIN, omits the line with an honest note
when null, NEVER contains "(check your config)", and end-to-end recovers the
real PIN from the vault when the config holds the unresolved object — never
"[object Object]" or the placeholder. Existing TelegramAdapter, SecretStore,
config-secret-merge, and gh-token canaries stay green (81/81).
