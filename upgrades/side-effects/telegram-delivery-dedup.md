# Side-Effects Review — Telegram delivery-chokepoint dedup

**Version / slug:** `telegram-delivery-dedup`
**Date:** `2026-06-03`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`SessionManager.injectTelegramMessage` gains an optional trailing `messageId` param and a
structural dedup: a `(tmuxSession, messageId)` ledger (pruned on a 10-minute window) ensures
a given Telegram message reaches a session at most once. A repeat is suppressed (returns
`true` — already delivered) and logged via `console.warn`. `messageId` is threaded from the
two delivery callers: the `/internal/telegram-forward` route and the in-process
`telegram→session` path (derived from `pipeline.id` = `tg-{messageId}`).

## Decision-point inventory

One decision: "have I already delivered this `(session, messageId)` within the window?"
→ suppress + log, else record + deliver. Gated on `messageId` being a positive number.

## 1. Over-block

**What legitimate inputs does this reject?** Only a re-delivery of the SAME Telegram
`messageId` to the SAME session within 10 minutes — which is, by definition, a duplicate of
a message already delivered (Telegram `message_id` is unique per chat; a genuine re-send is a
NEW id). The first delivery always lands. Distinct messages (distinct ids), messages to
different sessions, and any caller that supplies no positive `messageId` (e.g. `0`/undefined)
are never deduped. So no legitimate distinct user message is dropped.

## 2. Under-block

**What does this still miss?** It does not fix the *upstream* cause of the over-forward
(lifeline re-forward / PendingRelayStore re-drive / sentinel pause+resume) — it is a
chokepoint backstop. The suppression `console.warn` is deliberately retained so the upstream
multiplicity remains observable for a follow-up root-cause. It also does not dedupe non-
Telegram delivery paths (WhatsApp/iMessage inject have their own methods, out of scope).

## 3. Level-of-abstraction fit

**Right layer?** Yes. `injectTelegramMessage` is the single server→session delivery
chokepoint that writes the `/tmp/instar-telegram` file and does the tmux inject; every
Telegram delivery path funnels through it. Guarding there means the dedup holds regardless of
which upstream component over-forwards (defense-in-depth, Structure > Willpower). The two
callers only thread the id through.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

The dedup is an authority (it suppresses a delivery), but a tightly-scoped and conservative
one: it acts only on an exact `(session, messageId)` duplicate within a short window, and
returns success (the message WAS delivered on the first call), so callers see no failure. The
`console.warn` preserves the signal of the upstream over-forward for diagnosis. No user
message is lost.

## 5. Reversibility / blast radius

Bounded. The ledger is an in-memory `Map` pruned on a 10-minute window (naturally bounded by
message volume). No persistence, no schema, no config, no migration. If the dedup ever
misbehaved, the change is a few lines in one method plus two one-line caller edits; reverting
is trivial. The only behavioral change is "the exact same Telegram message is not injected
into the same session twice within 10 minutes."

## 6. Test coverage

`tests/unit/session-telegram-inject.test.ts` — both sides of the boundary with realistic
input: repeat id → suppressed (one file); distinct id → delivered (two files); no id →
no dedup (two files); id `0` → no dedup; same id to two sessions → both deliver.
