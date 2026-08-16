# Side-effects review — Phase 5b.3 (TelegramConfirmer)

**Version / slug:** `phase-5b3-telegram-confirmer`
**Date:** `2026-05-15`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (the confirmer is a thin coordinator over a transport interface + the already-tested OverrideDetector; the shorthand parsers are deterministic and exhaustively tested; the only authority added is the user's reply itself)
**Driving spec:** `specs/provider-portability/10-suggest-and-confirm-ux.md` §"Confirmation prompt shape" and §"Edge cases"

## Summary of the change

Third implementation slice of Phase 5b. Lands the blocking suggest-and-confirm round-trip — `TelegramConfirmer` in `src/providers/uxConfirm/TelegramConfirmer.ts`. The confirmer:

1. Sends a structured prompt via a thin `ConfirmationTransport` abstraction (`send` + `awaitReply`).
2. Blocks on the next reply on that topic for up to `timeoutMs` (default 5 minutes).
3. Parses the reply through four deterministic shorthand checks (`ok|c|yes|y|go|👍` → confirm-cache, `one-shot|oneshot|once` → confirm-no-cache, `/route reset` → reset, `no|n` → decline), then falls through to the LLM-backed `OverrideDetector` (Phase 5b.2) for free-text.
4. Returns a discriminated `ConfirmationResult`: `confirmed | overridden | reset | default-no-reply`.

The `ConfirmationTransport` interface is intentionally thin so the confirmer is unit-testable without spinning up real Telegram. Production wiring composes a `TelegramAdapter` into a transport that delivers `send` to a topic and resolves `awaitReply` from the inbound message stream — that wiring is part of the composition root in the next slice.

Files touched:
- `src/providers/uxConfirm/TelegramConfirmer.ts` — new, 230 LOC.
- `tests/unit/providers/uxConfirm/TelegramConfirmer.test.ts` — new, 30 cases.

## Decision-point inventory

This change adds the **user-facing confirmation surface** of Phase 5b. The user's reply IS the authority; the confirmer just decodes it.

- **`TelegramConfirmer.confirm(prompt)`** — `add`. Drives the round-trip. Returns the user's structured decision.
- **`TelegramConfirmer.parseReply(reply, prompt)`** — `add`. Pure-ish (the LLM call inside is async-pure given fixed reply). The shorthand checks are deterministic, brittle-by-design — they only activate on exact match.
- **`formatConfirmationPrompt(prompt)`** — `add`. Pure rendering function.

The four shorthand patterns are deliberately string-matching, which would normally violate the "intelligence over string matching" rule. But: they have no blocking authority — a missed shorthand falls through to the LLM-backed `OverrideDetector`. So the shorthand path is a fast-path optimization, not a decision authority. The signal-vs-authority constraint is satisfied: the LLM is always the safety net.

## Signal vs authority

- The shorthand parser is a fast-path; the LLM detector is the safety net.
- The confirmer does NOT decide what to do with the result — it returns the discriminated outcome. The composition root above (next slice) decides whether to update the PreferenceStore, run the task with the new pick, or auto-default after a no-reply.

## Over-block / under-block analysis

**Over-block (treating ambiguous reply as an override):**
- A user typing "yeah" gets classified as overridden-scope-this-task with no named pick (because "yeah" isn't in the confirm shorthand list). This propagates to the composition root which, per spec edge case §"Reply is unparseable", should re-ask once with the shorthand reminder. That re-ask logic lives in the composition root (next slice). The confirmer's job is just to surface the outcome.
- A user replying with "okay sounds good" — the LLM detector sees no override request → confirmer returns overridden-no-named-pick. Same recovery path as above.

Tunable: the shorthand list could be expanded (e.g., include "okay" / "sounds good"). Deferring until production produces real data — false-positive cost is one extra prompt; false-negative cost would be applying a wrong override.

**Under-block (missing a real override):**
- The LLM detector fail-safes to no-override on errors. Same conservative direction as the rest of Phase 5b.

## Level-of-abstraction fit

- The `ConfirmationTransport` interface is the thinnest possible abstraction over the Telegram-specific operations needed: send to topic, await reply with timeout. Adapter implementations live in the messaging layer; this layer doesn't reach into Telegram internals.
- The confirmer doesn't depend on `TelegramAdapter` directly — only the transport interface. Same code drives a Slack confirmer, an iMessage confirmer, etc., when those land.

## Interactions

- **Phase 5b.2 (`OverrideDetector`)** — confirmer delegates free-text parsing to the detector.
- **Phase 5b.1 (`PreferenceStore`)** — confirmer returns the outcome; the composition root above writes to the store. The confirmer does NOT write to the store directly (separation of concerns: decoding vs persisting).
- **No existing source file is modified.** Pure addition.

## External surfaces

- New exports: `TelegramConfirmer`, `TelegramConfirmerOptions`, `ConfirmationTransport`, `ConfirmationPrompt`, `ConfirmationResult`, `ConfirmationReason`, `formatConfirmationPrompt`.
- No new endpoint, no new CLI command, no new config field. The composition root next slice will introduce the wiring + new config field if any.
- The shorthand reply contract (`ok|c|yes|y|go|👍|no|n|one-shot|oneshot|once|/route reset`) is now part of the user-facing surface. Future changes should be additive only.

## Rollback cost

Trivial. `git revert` removes two files. No persistent state, no runtime callsite consumes this yet — the composition root is the next slice.

## Tests / verification

- `npx tsc --noEmit` clean.
- `vitest tests/unit/providers/uxConfirm/` — 86/86 pass (cumulative across five files: store 11, gate 12, classifier 13, detector 20, confirmer 30).
- Confirmer test coverage: prompt-shape, reason-text variants, transport ordering (send-before-await), timeout → default-no-reply, custom timeoutMs, default timeoutMs, eight confirm shorthand variants, four one-shot shorthand variants, four reset shorthand variants, four decline shorthand variants, LLM-override (this-task + this-pattern), ambiguous-free-text fallback.
- No real-API verification needed — confirmer composes pure stubs in tests. Live Telegram round-trip verification happens at integration time as part of the composition-root slice.
