# Side-Effects Review — A refused Attention button never costs the alert; peer actions are re-validated

**Version / slug:** `attention-button-refused-fallback`
**Date:** `2026-10-26`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Closes feedback fb-99bc2103-19b inside PR #2377. Two gaps in the new Attention-hub button:

1. `TelegramAdapter.sendToTopic`'s plain-text retry re-sent the SAME `reply_markup`. Telegram refuses the whole request when a button is bad (a URL it will not accept, a malformed `reply_markup`), so the retry failed the same way and the alert was lost. The retry is now `sendPlainKeepingText`: with no buttons it is byte-for-byte the old single retry; with buttons it tries plain WITH the button (formatting may have been the cause), then the formatted text WITHOUT the button, then plain without it. When the text goes out without its button, the `onButtonRefused` callback fires; the attention hub passes one that logs a warning and appends a `reason: "button-refused"` line to `logs/attention-unactionable.jsonl`.
2. `GET /attention?scope=pool` passed a peer item's `action` through unchecked whenever the key was present. It now runs `peerItemAction`: a valid console hash path (same `validAction` as local producers) is kept; an explicit null stays null; an older peer with no `action` key is stamped from the local rules; anything else gets no tap and one `reason: "peer-action-invalid"` line in the unactionable log (deduped per id+action in a bounded in-memory set, so a polled read does not write a line per poll).

Tier 1: small, reversible, flag-free change to delivery fallback and a display field; a revert restores the previous behavior exactly. Size: 3 source files (~110 LOC), 2 test files. Effort: one build pass, one commit.

## Decision-point inventory

- `sendPlainKeepingText` — add — chooses the next representation after a failed send; it never withholds a message, it only adds attempts that drop the button.
- `peerItemAction` — add — display validation of a peer's button target (same validator as `POST /attention`).

## 1. Over-block

Nothing new is refused. A peer action that is not a console hash path loses its button; this is the same rule local producers already face at `POST /attention` (400), so a legitimate peer on this version never emits one. Only a Telegram HTTP 400 on the plain-with-button attempt drops the button; any other 400 cause (not button-related) also lands the text without its button and is logged `button-refused` — acceptable, the alert gets through.

## 2. Under-block

`InvisiblePayloadRefusedError` and `TelegramOriginHoldError` stay terminal at every attempt, as before. If every representation fails, the error propagates exactly as the old retry's did (the hub then self-heals the topic id, unchanged). The relayed (tokenless standby) path never carried markup and is unchanged.

## 3. Level-of-abstraction fit

The fallback sits in the one place the plain retry already lived (`sendToTopic`), and the logging stays with the caller that knows the item (via a callback), so `sendToTopic` stays generic. The peer re-check lives in `attentionAction.ts` beside `validAction`, the single source of the rule.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface. Both changes only decide which representation of an already-approved message is sent, and whether a display button is shown.

## 4b. Judgment-point check

No competing-signals judgment; a fixed fallback order and an existing validator.

## 5. Interactions

- **Double-fire:** the button-free attempts run only after Telegram returned HTTP 400 on the plain-with-button send — a definite refusal, so nothing was delivered. A timeout or network error rethrows exactly as the old single retry did (unit test: a timeout produces 2 calls, both with the button, then the error). Duplicate exposure is unchanged from before.
- **Shadowing:** hub filter and repost throttle run before the send; `markPosted` still runs only after a delivered send.
- **Logging:** the unactionable log is append-only JSONL; the peer dedupe set is bounded at 500 keys.

## 6. External surfaces

Telegram may now receive up to four sendMessage calls (was two) for one buttoned post, and only when two of them were refused with HTTP 400. The pool read's `action` field for a peer item can now be null where it previously echoed the peer's value.

## 7. Multi-machine posture

Proxied-on-read: the peer check runs on the machine serving the pool read, over every merged item. The hub post is machine-local (the lease holder posts). The unactionable log is machine-local by design (a producer-fix audit).

## 8. Rollback cost

Revert the commit; no state, config or migration involved. Log lines already written are harmless.

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** one-shot bounded fallback within a single send (at most two extra sendMessage attempts, only after an HTTP 400 refusal); not a self-triggered loop. Mirrors the trace's `classClosure` block.

## Second-pass review

Concern raised: `sendPlainKeepingText` (src/messaging/TelegramAdapter.ts, the new private method) drops to the button-free attempts on ANY failure of the plain-with-buttons send, not only on a Telegram refusal. A network timeout or abort after the request went out is an uncertain outcome, and in that case the message may already have been delivered. Today one uncertain send can be replayed once; with buttons it can now be replayed up to three times (formatted with buttons, plain with buttons, formatted without, plain without), each with a 15 s timeout and its own 429 retries. Telegram refuses a bad button with an HTTP 400 (e.g. BUTTON_URL_INVALID). Suggested fix: keep `buttonErr`, and go on to the stripped attempts only when it is a 400 response error (the `Telegram API error … (400)` shape apiCall throws); otherwise rethrow it as the old code did. That brings the duplicate exposure back to exactly the old single retry and also removes the `button-refused` over-attribution that section 1 accepts.

Verified otherwise: sends without `reply_markup` take the old single call unchanged; both terminal errors are rethrown at every attempt; a throwing `onButtonRefused` is caught after a delivered send; `peerItemAction` admits only `validAction` forms, returns null for explicit null/undefined, applies the local rules when the key is missing, and caps its dedupe set at 500. Local items arrive already stamped (valid or null), so they pass through unchanged. No new blocking authority. Ran tests/unit/attention-action.test.ts: 16/16 pass (the integration file did not run under that config).

**Author's resolution (echo):** adopted the suggested fix — `sendPlainKeepingText` now rethrows any non-400 failure of the plain-with-buttons attempt, and only a `(400):` refusal proceeds to the button-free attempts. Added the unit test "a timeout (not a refusal) is NOT re-sent without the button". Verified red-for-the-right-reason: with the TelegramAdapter change removed, the two refused-button tests fail. Integration: `attention-pool-scope.test.ts` 8/8 under `vitest.integration.config.ts`.

Re-review: Concur with the review. Checked the current diff: the plain-with-buttons attempt now goes on to the button-free sends only on a `(400):` refusal, which matches the message `apiCall` throws for a 400. A timeout, a network error, or a 429 after its retries is rethrown, so an uncertain send is re-sent at most once, as before. A bad button makes the first formatted attempt fail with a 400 too, so that attempt never delivered. Both terminal errors are still rethrown. Unit tests 17/17 pass (including the new timeout test); integration tests 8/8 pass under vitest.integration.config.ts.
