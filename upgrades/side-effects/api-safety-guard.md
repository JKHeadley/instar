# Side-Effects Review — API Safety Guard

Spec: `docs/specs/API-SAFETY-GUARD-SPEC.md`
Driving topic: Telegram 9003, Justin, 2026-05-13.

## What's IN

1. Extract shared-intel-provider selection into a pure function `selectIntelligenceProvider()` at `src/core/selectIntelligenceProvider.ts`.
2. Remove the silent last-resort fallback at `src/commands/server.ts:2081-2092`.
3. Require BOTH `intelligenceProvider: "anthropic-api"` AND `intelligenceProviderConfirmed: true` for API mode to engage.
4. Render a visible billing banner on every startup when API mode is active.
5. Surface `ANTHROPIC_API_KEY` in env without opt-in as a warning (not a spend).
6. 14 unit tests asserting every cell of the selection table plus failure modes.

## What's DEFERRED

- **Telegram alert on first API-mode engagement**: would require per-machine "acknowledged" state file + attention queue routing. The visible banner + per-startup yellow log are sufficient signal for v1. Future spec: `api-mode-first-use-alert`.
- **Audit of every LLM call site**: the shared provider is used by Sentinel, InputGuard, Coherence checks, etc. — they all read from the chokepoint we just hardened. `StallTriageNurse` and `reflect.ts` also receive the shared provider. A separate audit would confirm no orthogonal API call sites exist. Spot-checked above; full audit deferred.
- **Removal of `AnthropicIntelligenceProvider` class**: explicit opt-in users still need it. Out of scope.

## Over-block analysis

The new behavior REFUSES API mode in two cases that previously allowed it:

1. **Single-flag opt-in** (`intelligenceProvider: "anthropic-api"` without `intelligenceProviderConfirmed: true`). Previously: API mode active. Now: warning + CLI fallback. **Intended over-block**: a single field is too easy to set accidentally.
2. **Silent env-key fallback** (CLI fails + key in env + no opt-in). Previously: API mode silently active. Now: `provider: null`, degradation. **Intended over-block**: this is the security hole the spec exists to close.

No unintended over-block: the new `selectIntelligenceProvider()` function exhaustively covers every previously-allowed case that should still work.

## Under-block analysis

After this lands, the remaining accidental-spend surface area is:

- A user who deliberately sets BOTH flags and forgets they did so. The visible banner on every startup is the mitigation — they will see the billing warning until they remove the flags.
- A user who explicitly runs in API mode and is surprised by the cost. This is consent + visibility; outside the scope of "silent" spend.

No under-block paths remain in the shared-provider selection logic.

## Level-of-abstraction fit

The selection logic was inline in a 70-line block inside the server-startup procedure. Extracting it to a named function:

- **Improves**: testability (the safety rules are now unit-tested rather than encoded in integration startup behavior), reviewability (one place to audit the selection rules), separation of concerns (selection vs rendering).
- **Costs**: one new file, ~120 lines (most of which is JSDoc and types). Net positive — the spec itself is the documentation surface for the chokepoint principle.

The function takes constructor functions as dependencies, not class instances, so it's pure and doesn't require a process or env to test.

## Signal-vs-authority compliance

Per CLAUDE.md "Signal vs authority separation" rule: brittle filters emit signals; intelligent gates with full context have blocking authority.

This change is not a filter — it's a configuration gate at startup. The "signal" here is the config (user's stated intent). The "authority" is the selection function (one place that enforces the rule). Compliant.

## Interactions

- **`InputGuard`**: receives `sharedIntelligence` from server.ts. With API mode disabled, falls back to `provenance + patterns only (no LLM review)` — already the documented degraded mode. No new interaction.
- **`StallTriageNurse`**: same as above. No new interaction.
- **`DegradationReporter`**: still reports the `SharedIntelligenceProvider` degradation when `provider: null`. The reporter call site is unchanged (we wrap the existing call rather than replacing it). New: the warnings array from `selectIntelligenceProvider()` adds context to the console output, but does not change degradation routing.
- **Git sync intelligence wiring** (`gitSync.setIntelligence(sharedIntelligence)` at line 2117): unchanged. If selection returns `null`, gitSync gets no intelligence (same as before).
- **`relationships.intelligence` wiring** (lines 2150–2179): a separate code path that already has correct subscription-by-default behavior (does NOT silently fall back to API). Untouched by this PR but worth noting it's the model the new chokepoint mimics.
- **Test isolation**: new unit tests use injected constructor functions, no real CLI or API. Tests cannot accidentally spend money even if `ANTHROPIC_API_KEY` is in CI env.

## Rollback cost

- One commit revert undoes the change. No data migrations, no state files written.
- No downstream consumers schema-changed; `IntelligenceProvider` interface unchanged.
- After revert, the silent-fallback security hole returns. Operators who want the rollback are explicitly outside the principal's stated security stance.

## CI surface

Touches:
- `src/commands/server.ts` (modified) — Build, Type Check, all unit shards (server startup tests live in `tests/integration/server-startup.test.ts` — none rely on the old silent-fallback path; checked).
- `src/core/selectIntelligenceProvider.ts` (new) — new unit test file.
- `tests/unit/selectIntelligenceProvider.test.ts` (new) — 14 assertions.

No CI workflow changes. No husky hook changes. No native module changes.

## Open questions

None. The change is fully specified by the user statement in topic 9003: "By default Instar should only run on subscription," paired with my reported finding of the single silent-fallback location.
