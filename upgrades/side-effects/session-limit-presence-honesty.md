# Side-Effects Review — Session-limit presence honesty (pattern coverage)

**Version / slug:** `session-limit-presence-honesty`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `not required` (additive detection patterns in an existing, already-wired honest-message path; both sides test-pinned)

## Summary of the change

`detectQuotaExhaustion` (PresenceProxy) gains three patterns covering the
session-limit banner wording from the 2026-06-05 topic-2169 incident
("Session limit reached ∙ resets 10:30pm" — no timezone paren), so the
standby reports "paused on its limit, resets at HH:MM" instead of "actively
working". No new code paths — the honest message + its three tier call sites
already exist.

## Decision-point inventory

1. New wordings match → honest paused message. Pinned (verbatim incident
   banner + comma/middot variants + bare "resets 4pm").
2. "Approaching session limit" → NOT matched (approaching ≠ paused). Pinned.
3. Ordinary prose with "resets" (no limit context) → NOT matched. Pinned.
4. Existing recovery logic (substantive output after the banner = stale)
   unchanged and still covered by the 16 pre-existing tests.

## Over-block / Under-block

Over: a false match only swaps one templated standby message for another
(more cautious) one — no action taken, nothing killed. Under: unknown future
banner wordings still fall through to the generic message — same as today.

## Level-of-abstraction fit / Signal vs authority

Pattern list inside the single detection helper all three tiers share.
Signal-only — message wording, never gates or kills.
**Reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

## External surfaces / Rollback

None / revert the pattern lines. No config, no state, no migration.

## Evidence pointers

`tests/unit/presence-proxy-quota.test.ts` 21/21 (5 new incl. the verbatim
incident banner + both negative cases); tsc + lint clean.
