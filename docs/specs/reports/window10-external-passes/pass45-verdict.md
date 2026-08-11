The report was printed to stdout. I could not create `PASS45-VERDICT.md`: the enforced read-only sandbox rejected `apply_patch`, and approval escalation is disabled.

=== VERDICT ===

UNSOUND

The pass-44 structured-content repair remains incomplete in two independent dimensions, both permitting valid rich content with exclusively invisible effective text to reach `fetch`. The boundary lint also misses a direct-call shape it claims to recognize. Previously stated-open defects remain open and are not recounted in the magnitude.

=== MAGNITUDE ===

5 new load-bearing findings: 4 DESIGN, 1 PRECISION.

## FINDINGS

1. **DESIGN — structured `rich_message` is inspected only in JSON-body representation.**

   [telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:207) leaves query, form, `URLSearchParams`, and multipart values as strings; lines 319–326 also freeze `FormData` into form encoding. [invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:420) invokes the structured walker only for objects, while lines 450–453 treat serialized JSON as ordinary visible characters. [telegram-egress-boundary.test.ts](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:305) covers only an `application/json` body whose nested object was already parsed.

   Telegram supports all four encodings and JSON-decodes the `rich_message` parameter before reading `blocks`, `markdown`, or `html`: [Making requests](https://core.telegram.org/bots/api#making-requests), [InputRichMessage](https://core.telegram.org/bots/api#inputrichmessage), [official server implementation](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L11607-L11644).

   Failure path: query, form, or multipart carries a valid JSON-serialized rich message whose effective leaves are all invisible. The door approves the serialization’s punctuation and member names; Telegram decodes and renders the unchecked leaves.

2. **DESIGN — the walker does not implement Telegram’s `RichText` grammar.**

   [invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:380) recognizes only object properties named `html`, `markdown`, or `text`. Array recursion at lines 383–385 loses primitive string members because line 381 immediately rejects non-objects. That line also imposes a depth-8 ceiling. When no leaves are found, lines 417–423 allow the request—contradicting the closed-door claim in [telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:33) and the “any depth” claim at line 376.

   Telegram defines `RichText` as a String, Array of `RichText`, or tagged object and permits 16 nested levels. It also has reader-facing keys outside this heuristic, including `summary`, `credit`, `expression`, and `alternative_text`: [RichText](https://core.telegram.org/bots/api#richtext), [Rich Message Limits](https://core.telegram.org/bots/api#rich-message-limits), [RichBlockDetails](https://core.telegram.org/bots/api#richblockdetails).

   Failure path: a legal block carries its `RichText` as an array of invisible primitive strings, or places its only invisible leaf beyond depth eight. The walker reports zero leaves and opens the door. Ignored reader-facing keys also cause symmetric over-refusals.

3. **DESIGN — “check every field” mistakes alternatives and ignored arguments for simultaneously rendered fields.**

   [invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:125) maps `editMessageText`, `sendRichMessage`, and `sendRichMessageDraft` to both `text` and `rich_message`; lines 408–411 independently require every supplied field to pass.

   Telegram documents only `rich_message` for the dedicated methods and treats `text` and `rich_message` as alternatives for `editMessageText`. Its server selects `rich_message` whenever present: [editMessageText](https://core.telegram.org/bots/api#editmessagetext), [server selection logic](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L13605-L13612).

   Failure path: the effective rich content is visible but an ignored `text` argument is invisible. Telegram would render the visible rich message; the door destroys it by rejecting the ignored field.

4. **DESIGN — the lint recognizes `fetch.call`/`fetch.apply` but examines the receiver as the URL.**

   [lint-telegram-egress-boundary.mjs](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:120) explicitly recognizes both forms. The visitor at lines 151–163 nevertheless always passes argument zero to `denotesBotApiUrl`. For these invocation forms, argument zero is the receiver; `apply` additionally carries fetch arguments inside an array. The canaries at lines 209–218 exercise neither case.

   Failure path: an outside-door direct fetch uses either claimed-supported Function invocation form. The lint analyzes a non-URL receiver, records no violation, and prints categorical confinement.

5. **PRECISION — the token-root `method` fallback is not an ordinary Bot API dispatch rule.**

   [telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:108) and lines 330–355 state that `/bot<token>/` or `/bot<token>/test/` resolves its method from a parameter. [telegram-egress-boundary.test.ts](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:221) repeats the claim, but its mocked fetch never exercises Telegram.

   Telegram requires `METHOD_NAME` in an ordinary request path. The `method` parameter is documented only for responding to an incoming webhook. The official server derives the method solely from the remaining URL path and returns “method not found” when it is absent: [request documentation](https://core.telegram.org/bots/api#making-requests), [path extraction](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/HttpConnection.cpp#L25-L45), [method lookup](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L12804-L12807).

   Failure path: mocked tests remain green while recording a Telegram dispatch rule that does not exist, causing maintainers to trust an invalid model as behaviorally proven.

## REGRESSION-CHECK

1. **Redirect crossing:** still open as described at [telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:36).

2. **Encoding inferred from wrapper/body text:** still open at [telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:217); `Content-Type` is never consulted, including for byte-backed bodies.

3. **Irrelevant duplicate JSON keys:** still open at [telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:227); every top-level duplicate makes the whole body unreadable before field relevance is considered.

4. **`answerCallbackQuery`/`editForumTopic`:** still open. [invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:149) unconditionally maps `editForumTopic.name`; lines 184–198 still classify displayed callback text as bodyless.

5. **Local Bot API Server:** still open. Recognition remains hard-coded to the cloud host in [telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:60) and [the lint](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:48), despite Telegram’s [supported local server](https://core.telegram.org/bots/api#using-a-local-bot-api-server).

6. **Multipart representation:** still open. [telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:319) rewrites `FormData` while retaining caller headers; the test at [line 92](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:92) proves only that mocked fetch was called.

7. **Single-read claim:** still false. `{ ...init }` at [telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:421) re-invokes enumerable accessors. The test at [line 275](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:275) does not assert the read count.

8. **Live method table:** still stale. [invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:125) omits `sendMessageDraft`, `editEphemeralMessageText`, and `editEphemeralMessageCaption`. Runtime refusal is fail-safe, but the live-model claim is false.

9. **Documentation sweep:** still incomplete. The deleted per-sender derivation/ratchet remains current guidance in [the ELI](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.eli16.md:32), [the convergence report](/Users/justin/window12-exam/docs/specs/reports/telegram-egress-invisible-payload-guard-convergence.md:14), and [the main spec](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:327).

10. **Rendering shortcut:** still open in both directions at [invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:312). Its description remains partly wrong: Telegram rejects malformed markup; the adapter/lifeline perform the plain retry. CMT-1260 under-refusals remain.

11. **Surviving relay guard:** still open as described at [TelegramAdapter.ts](/Users/justin/window12-exam/src/messaging/TelegramAdapter.ts:1380).

12. **Unicode table:** still not vendored. Runtime property escapes remain at [invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:64), with CMT-1261 still owning the unfinished work.

13. **Relay refusal/unreachable conflation:** still open. The holder’s refusal remains a 400 path around [routes.ts](/Users/justin/window12-exam/src/server/routes.ts:14927), while [TelegramRelay.ts](/Users/justin/window12-exam/src/core/TelegramRelay.ts:126) recognizes only 422.

14. **Lint blind spots:** still open and partly stale. Blinded-door coverage is delegated at [lint lines 29–40](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:29), and aliases remain unresolved at line 112. Literal computed `['fetch']` is recognized; only dynamic/unresolved computed access remains. Finding 4 adds an unstated defect inside a claimed-supported shape.

15. **Deliberately red family audit:** still open as described at [standards-coverage-ratchet.test.ts](/Users/justin/window12-exam/tests/unit/standards-coverage-ratchet.test.ts:906). Building and The Substrate remain stale; changing the expectation would forge acceptance.