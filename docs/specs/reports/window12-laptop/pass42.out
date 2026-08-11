The report was printed to stdout. `PASS42-VERDICT.md` could not be created because the workspace is read-only; the write attempt was rejected.

=== VERDICT ===

UNSOUND

The body freeze retains a second-read bypass. The lint also misses direct-call forms it claims to recognize, mutable-body freezing changes supported encodings, and several source/spec claims remain false. Stated-open rendering under-refusals independently preclude the literal guarantee but are excluded from the magnitude.

=== MAGNITUDE ===

7 load-bearing findings: **3 DESIGN, 4 PRECISION**.

`node_modules` is absent, so the TypeScript lint and Vitest suites could not run. Native `Request` behavior was checked directly for finding 4.

## FINDINGS

1. **DESIGN — an initially absent body is read again and can bypass the freeze.**

   Evidence: [telegram-egress.ts:313](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:313), [telegram-egress.ts:382](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:382), [telegram-egress.ts:407](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:407), [telegram-egress-boundary.test.ts:246](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:246).

   `rawBody` captures `init.body`, but the final `{ ...init }` reads an accessor again. The captured body overwrites that second value only when `checkedBody !== undefined`. The regression test covers only a defined first value.

   Concrete failure path: the first read returns `undefined`, so no reader-visible field is checked. The spread’s second read returns a serialized invisible body, which remains in the outgoing init and reaches `fetch` unchecked.

2. **DESIGN — `fetch.call` and `fetch.apply` inspect the wrong URL operand.**

   Evidence: [lint-telegram-egress-boundary.mjs:116](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:116), [lint-telegram-egress-boundary.mjs:151](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:151), [lint-telegram-egress-boundary.mjs:209](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:209).

   `isFetchCall` recognizes `.call` and `.apply`, but the visitor always analyzes `arguments[0]`. That is the receiver for both forms; the request URL is later or inside the applied argument array. No canary exercises either form.

   Concrete failure path: a direct Bot API invocation through either advertised form produces no violation, allowing the lint to report confinement while bypassing `telegramFetch`.

3. **DESIGN — binary/local URL resolution is only a one-hop textual marker search.**

   Evidence: [lint-telegram-egress-boundary.mjs:73](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:73), [lint-telegram-egress-boundary.mjs:143](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:143), [lint-telegram-egress-boundary.mjs:253](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:253).

   Binary recursion does not combine constant operands. Local lookup checks only whether one initializer already contains the complete host marker and does not follow another binding. The file prefilter has the same complete-marker dependency.

   Concrete failure path: a locally constructed host split across operands, or routed through a second local binding, is missed despite being neither an imported-URL nor renamed-fetch case. The lint still prints categorical confinement.

4. **PRECISION — freezing changes `URLSearchParams` and multipart representation.**

   Evidence: [telegram-egress.ts:259](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:259), [telegram-egress.ts:313](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:313), [telegram-egress-boundary.test.ts:84](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:84), [telegram-egress-boundary.test.ts:106](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:106), [telegram-egress-boundary.test.ts:367](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:367).

   Both wrappers become plain strings. Native fetch normally assigns URL-encoded or boundary-bearing multipart media types; the replacement receives `text/plain` without explicit headers. `FormData` file parts are also dropped. Telegram selects parsing from the request encoding. [Telegram Bot API request documentation](https://core.telegram.org/bots/api#making-requests).

   Concrete failure path: an ordinary visible mutable-wrapper request is inspected as fields, then transmitted as plain text Telegram will not parse as that encoding. The “DELIVERS a multipart body” test proves only that its fetch mock was called; it never checks the outgoing body or media type.

5. **PRECISION — path extraction still does not retain Telegram’s entire remainder.**

   Evidence: [telegram-egress.ts:96](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:96), [telegram-egress-boundary.test.ts:198](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:198).

   The door strips trailing slashes before classification. Telegram passes the entire residual path to its query dispatcher without that normalization. [Telegram `HttpConnection.cpp`](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/HttpConnection.cpp#L33-L45).

   Concrete failure path: a known method followed by a trailing separator is classified locally as known and sent, while Telegram treats the separator-bearing remainder as another, unknown method and rejects it. This is not an invisible delivery, but falsifies the “ENTIRE remainder” and “cannot disagree” claims.

6. **PRECISION — the spec still defines a different predicate from the implementation.**

   Evidence: [invisible-payload.ts:64](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:64), [invisible-payload.ts:91](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:91), [telegram-egress-invisible-payload-guard.md:239](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:239), [telegram-egress-invisible-payload-guard.md:266](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:266), [telegram-egress-invisible-payload-guard.md:327](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:327).

   The code requires `L/N/P/S/M` membership and subtracts `Default_Ignorable_Code_Point` plus five blank glyphs. The live spec repeatedly describes category membership alone and incorrectly bounds cross-version drift to General Category changes.

   Concrete failure path: a category-positive but default-ignorable code point satisfies the spec’s stated predicate but is refused by the implementation. The pass-41 sweep repaired one historical combining-mark list, not these live definitions.

7. **PRECISION — live spec rows still describe deleted lint enforcement.**

   Evidence: [telegram-egress-invisible-payload-guard.md:153](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:153), [telegram-egress-invisible-payload-guard.md:327](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:327), [lint-telegram-egress-boundary.mjs:140](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:140).

   The spec says the current lint reads the method map, derives body-carrying sender files, and maintains a shrink-only population ratchet. It does none of those.

   Concrete failure path: method references and the former population can change or shrink without the claimed map or ratchet check. A maintainer trusting the decision table believes two absent controls exist.

## REGRESSION-CHECK

- **Wrapper versus `Content-Type`:** Still open; finding 4 adds that freezing now changes automatic media types.
- **Irrelevant duplicate JSON key:** Still open at [telegram-egress.ts:219](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:219).
- **`answerCallbackQuery` / `editForumTopic`:** Still open at [invisible-payload.ts:117](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:117). Telegram documents displayed callback text and empty forum names preserving the current name: [answerCallbackQuery](https://core.telegram.org/bots/api#answercallbackquery), [editForumTopic](https://core.telegram.org/bots/api#editforumtopic).
- **1. Rendering shortcut:** Still open, but incorrectly and incompletely described. Telegram returns a parse error; the Adapter performs the plain-text retry at [TelegramAdapter.ts:1411](/Users/justin/window12-exam/src/messaging/TelegramAdapter.ts:1411). Valid pure markup is another allowed under-refusal at [invisible-payload.ts:363](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:363).
- **2. Surviving per-sender guard:** Still open exactly as described at [TelegramAdapter.ts:1379](/Users/justin/window12-exam/src/messaging/TelegramAdapter.ts:1379).
- **3. Unicode table:** Still open, but the description omits `Default_Ignorable` version drift.
- **4. Relay conflation:** Still open exactly as described at [TelegramRelay.ts:126](/Users/justin/window12-exam/src/core/TelegramRelay.ts:126), with three tests at [telegram-relay-refusal-status-conflation.test.ts:37](/Users/justin/window12-exam/tests/unit/telegram-relay-refusal-status-conflation.test.ts:37).
- **5. Lint limits:** Still open but incomplete; findings 2–3 identify additional missed direct/local forms.
- **6. Deliberately red audit:** Still present as described at [standards-coverage-ratchet.test.ts:906](/Users/justin/window12-exam/tests/unit/standards-coverage-ratchet.test.ts:906).