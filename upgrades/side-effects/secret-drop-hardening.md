# Side-effects review — Secret Drop hardening

Per L6. Seven dimensions.

## 1. Over-block / under-block

**Before.** UNDER-block: a buggy consumer that called `/secrets/retrieve/<token>` once and dropped the response (parse error, exception in the writer step) lost the secret with no recovery path. The aggressive deletion-on-retrieve looked like a tight one-shot guarantee but actually created a silent-loss footgun, because the same 5-minute cleanup timer was already handling memory hygiene.

**After.** No new over-block: the default retrieval shape returns the same value the previous code did. Existing callers that don't pass `?consume=true` simply gain the ability to retry within the cleanup window — a safer state, not a different one. Callers that genuinely need one-shot semantics opt in with the query parameter.

The new stuck-consumer event closes the silent-failure gap: a submission that lingers unconsumed for 60s now produces a visible cue to the bound topic. Operators see the failure instead of waiting on a value that's already lost.

## 2. Level-of-abstraction fit

Three changes at deliberately different altitudes:

- `SecretDrop.ts`: new methods (`peekReceived`, `consumeReceived`, `onStuckConsumer`) and the stuck-timer state machine. Pure logic, unit-tested.
- `routes.ts`: the route honors `?consume=true`; one default listener wires the stuck-consumer event to the topic-bound session via `injectPasteNotification`. Thin orchestration only.
- Back-compat alias: `getReceived` is kept as `consumeReceived`'s legacy synonym so no caller has to migrate in this PR. Callers migrate at their own pace by switching to `peekReceived` + `consumeReceived` explicitly.

## 3. Signal vs Authority compliance

The Secret Drop request remains the authoritative declaration that this token may receive a submission (operator-issued via `/secrets/request`). The submission, once made, remains the authoritative payload — no agent code can mint a fake submission. The new methods change only the lifecycle of an already-authorized value:

- `peekReceived`: read-only, idempotent, returns the existing authority.
- `consumeReceived`: terminates the authority's lifetime explicitly.
- `onStuckConsumer`: signal-only emission to listeners; no listener gains write access to the submission.

No new authority is created. Existing CSRF, rate-limit, expiry, and one-time submission semantics are unchanged.

## 4. Interactions with adjacent systems

- **The `/secrets/retrieve/<token>` route.** Default behavior shifts from destructive to non-destructive. Existing callers that don't add `?consume=true` retain the value across multiple calls — strictly safer; no callers depend on "second call returns 404" except as a footgun.
- **The `/secrets/drop/<token>` form-side route.** Untouched. Operator-facing flow is byte-identical.
- **`onReceive` callback on the request.** Untouched. Still fires once on submit.
- **Existing 5-minute auto-cleanup.** Untouched. Still the safety net.
- **System-message routing via `injectPasteNotification`.** Reused for the new stuck-consumer system message. Same pattern as `secret-drop-received`.
- **Existing `SecretDrop.test.ts` suite.** All 25 cases continue to pass. The new test file adds 13 cases for the new surface.

## 5. Rollback cost

Low. Three files modified (`SecretDrop.ts`, `routes.ts`, one test file added). `git revert <merge-sha>` restores the pre-change atomic retrieve-and-delete behavior. Callers that adopted `?consume=true` continue to work after a revert (the parameter becomes a no-op against the pre-change atomic-delete path). The stuck-consumer event simply stops firing.

No state migration, no deployed-agent impact, no schema change. In-memory only.

## 6. Backwards compatibility / drift surface

Fully backwards-compatible at the call-site level:

- `getReceived(token)` is preserved as an alias for `consumeReceived(token)`.
- The route default is non-destructive — strictly safer for existing callers.
- Callers that depend on one-shot semantics (the bridge script in the parallel telegram-history-backfill PR being one example) opt in via `?consume=true` explicitly.

Drift surface: small. Two new methods on `SecretDrop`. One new event interface. One new constant for the grace period. The grace period is a hard-coded constant for v1 ship; a future PR can make it configurable per-request if a real need surfaces.

## 7. Authorization / Trust posture

No new authority. The two new methods read/write the same in-memory `received` map the previous code touched. The new listener-registration surface (`onStuckConsumer`) accepts callbacks from the route layer only — there is no external API to register a listener over HTTP. The route layer's default listener routes only to the topic-bound session (the same authority the `secret-drop-received` path already uses).

Trust ramifications: the operator gains a new visible signal (the stuck-consumer system message), which strengthens their ability to detect consumer-side failures. The agent gains a new structural primitive for safe-by-default retrieval, which reduces the surface for silent-loss bugs. Both directions of trust move in the safer direction.

## Outcome

Ship. Incident-driven, three independent changes, fully unit-tested, fully backwards-compatible at the call-site level. The single highest-impact change is the default-non-destructive retrieve — that alone makes the 2026-05-20 lost-SMS-code failure mode structurally impossible to repeat without an explicit `?consume=true` from the buggy consumer.
