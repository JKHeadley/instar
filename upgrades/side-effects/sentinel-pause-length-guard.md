# Side-Effects Review — MessageSentinel: long-message pause downgrade

**Version / slug:** `sentinel-pause-length-guard`
**Date:** `2026-06-05`
**Author:** `instar-echo`

## Summary

New `downgradeLongPause()` applied to the LLM layer's result in `classify()`: a 'pause' classification on a message longer than `MAX_PAUSE_DIRECTIVE_WORDS` (25) becomes `normal`/pass-through, logged, with the original reason preserved inside the downgrade reason. Emergency-stop, redirect, and all short-message behavior unchanged.

## Decision-point inventory

- `MAX_PAUSE_DIRECTIVE_WORDS` — added (25) — a genuine natural-language pause directive is well under this; the two live victims were ~200 words.
- `downgradeLongPause()` — added — pure function of (classification, message); only transforms `pause`.
- `classify()` LLM branch — modified — result passes through the guard. Fast path untouched (its 4-word gate already excludes long messages from patterns; slash commands are exact-match short).
- The forward-route intercept, pause action semantics, stats recording — untouched (stats record the post-downgrade category, which is the truthful one).

## Direction of failure

- Old failure: a long task message classified 'pause' was CONSUMED — session paused, content destroyed, no trace in any queue/ledger (the delivery stack's only loss path with zero record).
- New behavior: long messages always deliver; only short messages can pause.
- Conservative failure direction: content is preserved. The worst new case is a user writing a >25-word pause request that now passes through as conversation — the session still RECEIVES it and can comply conversationally; nothing is destroyed. Compare old worst case: silent destruction of instructions.

## Side-effects checklist

1. **Over-deliver (missed pause):** a verbose pause directive (>25 words) no longer auto-pauses. Mitigations already in place: the message is delivered (the agent reads "please pause" and can stop itself), and /pause + short forms still work. Pause is politeness, not safety — the safety category (emergency-stop) is untouched.
2. **Under-deliver:** none — no path consumes more than before.
3. **Asymmetry justification:** emergency-stop on a long message remains possible by design (the prompt's own safety-first rule: better to stop unnecessarily than continue destructively). Length-gating it would trade safety for content; not taken.
4. **Level-of-abstraction fit:** the guard lives in MessageSentinel (the classifier), not the forward route (the consumer) — every consumer of classify() (route intercept, TelegramAdapter.processUpdate, /sentinel/classify API) gets the same corrected verdict; no consumer-side divergence.
5. **Signal vs authority:** the LLM keeps proposing; the structural gate bounds its authority over the destructive action. Exactly the signal-vs-authority pattern.
6. **External surfaces:** `/sentinel/classify` responses for long pause-ish messages change category to `normal` with an explanatory reason — truthful, observable, and carried in `/metrics/features` stats as the post-guard category.
7. **Rollback cost:** revert the commit; no state, config, or migration.

## Scope not taken

- No change to emergency-stop classification (deliberate, documented asymmetry).
- No configurability of the 25-word ceiling (constant; make it config only if a real false-negative shows up).
- No retroactive recovery of the two eaten messages (both manually resent during diagnosis).
- No prompt changes (the prompt's guidance stays as a first line; the guard is the backstop).

## Rollback

Revert the commit. Long messages classified 'pause' are consumed again.
