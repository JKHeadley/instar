# Side-Effects Review — Session Clock Step 2c (user-turn query injection)

**Slug:** `session-clock-step2c` · **Date:** `2026-06-02` · **Author:** `echo` · **Tier:** 2
**Spec:** `docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md` (Component 2 — the query call site)

## Summary
Completes the time-awareness injection's SECOND call site: the `telegram-topic-context.sh`
UserPromptSubmit hook now, after resolving PORT + AUTH_TOKEN + TOPIC_ID, calls
`emit-session-clock.sh query` so the SESSION CLOCK line surfaces on the user's OWN turns too
(not just autonomous continuations). With Step 2b (the stop-hook render site), both call sites
of Component 2 are now wired — the routine's render AND query modes are both consumed.

- `src/core/PostUpdateMigrator.ts` `getTelegramTopicContextHook()`: an additive query call after
  the existing CURRENT TIME block + AUTH resolution. Signal-only: emits nothing when no time-boxed
  session is active or the server is unreachable. Guarded on the script existing.

## 1-7 (brief)
Over/under-correction: additive; the CURRENT TIME block + history fetch are unchanged; emits only
when a clock exists. Abstraction: reuses the shared routine. Signal vs Authority: pure stdout, no
gate. External surfaces: calls the existing Bearer-gated `/session/clock`; only the already-sanitized
label is surfaced. Interactions: composes with the hook's existing AUTH/PORT/TOPIC resolution.
Rollback: remove the ~3-line block.

## Migration parity
`telegram-topic-context.sh` is a BUILT-IN `instar/` hook → always-overwritten on every migration
(migrateHooks), so existing agents receive the query injection automatically. No new migration needed.

## Tests
`telegram-topic-context-session-clock.test.ts` (2): the generated hook contains the
`query "$TOPIC_ID" "$PORT" "$AUTH_TOKEN"` call AND is syntactically valid bash (`bash -n` — guards
the TS-template escaping). Regression: migration-parity-hooks + neutralRelayPath + emit-session-clock
migration (12) green; `npm run lint` (tsc + custom linters) clean.
