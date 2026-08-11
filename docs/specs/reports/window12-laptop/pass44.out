The workspace is read-only, so creating `PASS44-VERDICT.md` and printing through a shell heredoc were both rejected. The completed report follows.

=== VERDICT ===  
UNSOUND

The door still has two independent bypass classes: structured rich-message content is never inspected at its content leaves, and Telegram’s supported Local Bot API Server endpoint is outside both method recognition and the boundary lint. The multipart, single-read, live-method-table, and documentation claims are also false.

=== MAGNITUDE ===  
6 load-bearing findings: 4 DESIGN, 2 PRECISION.

## FINDINGS

1. **DESIGN — pass 43 models `rich_message` as a string leaf, but Telegram models it as structured `InputRichMessage`.**

   Evidence: `src/messaging/invisible-payload.ts:125-150` maps `rich_message` parallel to `text`, while `src/messaging/invisible-payload.ts:380-383` checks a field only when it is a string. A JSON request produces an object, so the guard skips it. With query/form/multipart encoding, the JSON serialization’s punctuation is mistaken for visible content. `tests/unit/telegram-egress-boundary.test.ts:290-302` instead tests invalid string-shaped rich messages.

   Telegram documents `rich_message` as an [`InputRichMessage`](https://core.telegram.org/bots/api#inputrichmessage), whose content is under `html`, `markdown`, or `blocks`. [`sendRichMessage`](https://core.telegram.org/bots/api#sendrichmessage) and [`sendRichMessageDraft`](https://core.telegram.org/bots/api#sendrichmessagedraft) require that object. The official server parses the argument as JSON and then reads those nested members ([Telegram server source](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L11607-L11644)).

   Failure path: a valid `editMessageText`, `sendRichMessage`, or `sendRichMessageDraft` request places all reader-facing content inside the structured value. The door either skips the object or approves its JSON syntax, while Telegram renders nested content the predicate never evaluated.

2. **DESIGN — cloud-host-only recognition excludes Telegram’s supported Local Bot API Server.**

   Evidence: `src/messaging/telegram-egress.ts:60,83-105` recognizes methods only on `api.telegram.org`; lines 358-409 guard only recognized methods; line 423 fetches all other URLs. The lint repeats the cloud-host assumption at `scripts/lint-telegram-egress-boundary.mjs:48-55,143-167`.

   Telegram explicitly supports [sending requests to a locally hosted Bot API server instead of `api.telegram.org`](https://core.telegram.org/bots/api#using-a-local-bot-api-server). This is distinct from the stated redirect-crossing judgment.

   Failure path: `telegramFetch` targets a configured Local Bot API Server. Both method recognizers return no Bot API method, the guard block is skipped, and the request is sent. The lint cannot identify that endpoint either.

3. **DESIGN — the multipart repair changes the representation instead of correctly freezing it.**

   Evidence: `src/messaging/telegram-egress.ts:314-326` converts `FormData` into a URL-encoded string and drops non-string parts, while lines 421-423 retain the caller’s headers. An implicit multipart request therefore loses fetch’s multipart content type and boundary; an explicit multipart header retains a boundary that no longer describes the body. Lines 272-275 also reject byte-backed bodies according to their JavaScript wrapper even when their media type describes valid JSON or form data. Telegram’s accepted encodings are HTTP representations/media types ([Making requests](https://core.telegram.org/bots/api#making-requests)).

   `tests/unit/telegram-egress-boundary.test.ts:92-113` proves only that mocked `fetch` was called. It never constructs the HTTP request or verifies its content type and boundary. Lines 397-405 claim the init is unchanged while testing only a JSON string.

   Failure path: visible multipart content passes the predicate but reaches Telegram as URL-encoded text without a matching content type, or with a stale multipart boundary, and is rejected. A valid byte-backed JSON request is refused. This is the still-live pass-41 content-type defect, omitted from the current stated-open list.

4. **DESIGN — the versioned method/field table is already stale against Bot API 10.2.**

   Evidence: `src/messaging/invisible-payload.ts:125-150` lacks `editEphemeralMessageText`, `editEphemeralMessageCaption`, and `sendMessageDraft`; `src/messaging/telegram-egress.ts:362-380` therefore refuses all uses as unclassified.

   Telegram documents [`editEphemeralMessageText.text`](https://core.telegram.org/bots/api#editephemeralmessagetext), [`editEphemeralMessageCaption.caption`](https://core.telegram.org/bots/api#editephemeralmessagecaption), and [`sendMessageDraft.text`](https://core.telegram.org/bots/api#sendmessagedraft). The latter gives empty text the useful visible semantic of a “Thinking…” placeholder.

   Failure path: a caller adopts one of these current methods through the door and is refused regardless of visible content or documented empty-value semantics. This is fail-safe against an invisible send, but it destroys supported operations and falsifies the claim that the live API model was swept. `sendMessageDraft` needs an explicit judgment entry, not a mechanical empty-text refusal.

5. **PRECISION — pass 42 still re-reads `init.body`.**

   Evidence: the first read is `src/messaging/telegram-egress.ts:318`, but `{ ...init }` at line 421 invokes every enumerable accessor, including `body`, before line 422 overwrites its result. Lines 418-420 say it is “never re-read.”

   `tests/unit/telegram-egress-boundary.test.ts:275-287` is titled “never re-reads the body” but asserts only that the second value is not stored in `outgoing.body`; it never asserts `reads === 1`.

   Failure path: a getter succeeds during capture and throws or performs a state-changing action on its second access. Overwriting its second value closes the exact pass-42 wire-value bypass, but does not establish the claimed single-read property.

6. **PRECISION — the prose sweep still leaves live-facing descriptions of the deleted per-sender architecture.**

   Evidence:

   - `docs/specs/telegram-egress-invisible-payload-guard.eli16.md:80-90` says the lint derives senders and requires a per-sender guard; lines 116-126 say the centralized door is still owed. The ELI document has no superseded warning.
   - `docs/specs/telegram-egress-invisible-payload-guard.md:327-334` still describes method-aware sender derivation and a shrink ratchet.
   - Its frontloaded decisions, rollback, and acceptance criteria at lines 358-373 and 451-485 prescribe the deleted per-egress design.
   - `docs/specs/reports/telegram-egress-invisible-payload-guard-convergence.md:14-36` repeats the old architecture and old L/N/P/S predicate.
   - The actual lint states its narrower confinement role at `scripts/lint-telegram-egress-boundary.mjs:19-40`.

   Failure path: a maintainer follows the ELI, decision table, rollback instructions, or convergence report and edits or assesses a per-sender population that no longer exists. Marking two headings superseded did not sweep the remaining current-tense surfaces.

## REGRESSION-CHECK

1. **Rendering shortcut:** still open in both directions at `src/messaging/invisible-payload.ts:324-350`, but the description needs narrowing. Telegram does not itself resend malformed markup as plain text; the adapter and lifeline implement that retry for failed formatted `sendMessage` calls at `src/messaging/TelegramAdapter.ts:5823-5845` and `src/lifeline/TelegramLifeline.ts:2959-2974`. The over-refusal exists on those fallback-capable paths. Comments at `src/messaging/invisible-payload.ts:327,389-399` incorrectly attribute the fallback to Telegram and overstate it for other methods and direct door callers. CMT-1260’s under-refusals remain open.

2. **Surviving per-sender guard:** still open as described. `src/messaging/TelegramAdapter.ts:1380-1402` guards the tokenless relay before handing text to another machine; this process never reaches the Bot API on that branch.

3. **Unicode table not vendored:** still open as described. Runtime property escapes remain at `src/messaging/invisible-payload.ts:64,76`, the hand-maintained blank set remains at lines 91-97, and the spec assigns the unfinished table to CMT-1261 at `docs/specs/telegram-egress-invisible-payload-guard.md:266-277,341-349`.

4. **Relay refusal/unreachable conflation:** still open as described. The holder returns invisible-content refusal as 400 at `src/server/routes.ts:14945-14951`; `src/core/TelegramRelay.ts:126-147` recognizes only 422 and collapses other non-2xx outcomes to `null`.

5. **Lint blind spots:** still open as described. `scripts/lint-telegram-egress-boundary.mjs:29-40` assigns a blinded door to behavioural tests, and lines 112-114 do not resolve fetch aliases. Its clean output at lines 253-255 remains categorical despite those limits. The statement that computed-member calls are all uncovered is itself stale: literal `['fetch']` is recognized at lines 126-129; unresolved or dynamic computed access remains uncovered.

6. **Deliberately red family audit:** still open as described. `tests/unit/standards-coverage-ratchet.test.ts:906-925` expects six current audits while recording Building and The Substrate as stale. Changing the expectation would forge acceptance.