# Side-Effects Review — Telegram authorizedUserIds type-tolerant comparison

**Version / slug:** `telegram-auth-id-type-tolerant`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

The legacy (non-shared-AuthGate) Telegram auth path used
`authorizedUserIds.includes(userId)` where `userId` is a `number` but the config
field, though typed `number[]`, is untyped JSON at runtime and may hold the id as
a string. `Array.prototype.includes` uses SameValueZero (no coercion), so a
string-configured id silently failed to match and the authorized user was treated
as unknown. The fix compares as strings (`authorized.some(id => String(id) ===
String(userId))`), mirroring the shared-AuthGate path which is already string-based.
The mini-onboarding auto-add (`server.ts`) is given the same loose membership check
so it does not append a duplicate when the list already holds the id as a string.

## Decision-point inventory

One decision point: `isAuthorized(userId)` returns true/false (authorized vs gated).
The change only affects WHICH equal-by-value ids match; it does not change the
empty-list semantics (still "accept all" on the legacy path) or any other branch.

## 1. Over-block

**What legitimate inputs does this change reject?** None. The change only makes the
comparison match MORE inputs that were always intended to match (an id equal by
value, regardless of number-vs-string representation). No id that previously
authorized stops authorizing: `String(n) === String(n)` holds for every number that
`includes` would have matched. The empty/absent-list "accept all" path is untouched.

## 2. Under-block

**What does this still miss?** It does not change the fail-open vs fail-closed
posture of the legacy path (empty list still accepts all — unchanged, out of scope).
It does not touch the shared-AuthGate path (already string-based) or the Slack/
WhatsApp/iMessage adapters (separate code, their own typing). It compares by exact
string equality after coercion, so it intentionally does NOT treat e.g. leading-zero
or whitespace-padded ids as equal — Telegram ids are canonical integers, so this is
correct.

## 3. Blast radius

Two callsites: `TelegramAdapter.isAuthorized` (the auth gate) and the `server.ts`
mini-onboarding auto-add. Both are Telegram-only. No schema, config-shape, or API
change — existing configs (number ids, string ids, or mixed) all keep working, and
configs that already worked are unaffected. Behavior strictly widens recognition to
match the documented intent.

## 4. Reversibility

Fully reversible: revert the two edits. No state migration, no persisted format
change. Config files are not rewritten by this change (the mini-onboarding still
pushes a numeric id as before; it just no longer duplicates an existing string id).
