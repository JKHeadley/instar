The report could not be written to `PASS39-VERDICT.md`: the workspace is mounted read-only and the write was rejected. No files were changed. Full report follows.

=== VERDICT ===  
UNSOUND

The door retains four unchecked reader-visible request classes, and the boundary lint can still report confinement while missing direct egress. Supported requests are also over-refused, one refusal is absent from the promised decision stream, and current source/spec claims remain false. The six stated-open items are excluded from the magnitude.

=== MAGNITUDE ===  
9 load-bearing findings: 7 DESIGN, 2 PRECISION.

## FINDINGS

1. **DESIGN — Telegram can select the method from request parameters when the URL path contains no method.**

   `BOT_PATH` requires a path method at `src/messaging/telegram-egress.ts:61`; failure returns `null` at `:101`, causing the entire guard block at `:279` to be skipped before the unconditional fetch at `:324`.

   Telegram’s server falls back to the first `method` argument when the path method is empty; its argument accessor returns the first match ([Telegram HttpConnection](https://raw.githubusercontent.com/tdlib/telegram-bot-api/master/telegram-bot-api/HttpConnection.cpp), [Telegram Query](https://raw.githubusercontent.com/tdlib/telegram-bot-api/master/telegram-bot-api/Query.h)).

   Concrete failure path: a request to the token root supplies a reader-visible method through an accepted parameter channel. Telegram dispatches it, while the door returns `null` and sends without collecting or checking its payload.

2. **DESIGN — host canonicalization remains narrower than fetch/DNS canonicalization.**

   `src/messaging/telegram-egress.ts:98` requires `.hostname` to equal `api.telegram.org` exactly. A fully qualified hostname with a terminal DNS root dot denotes the same host, while `new URL()` preserves that dot.

   Concrete failure path: the equivalent fully qualified API hostname reaches Telegram, but `methodFromTelegramUrl` returns `null`; the door skips the guard at `:279` and fetches at `:324`. The lint marker at `scripts/lint-telegram-egress-boundary.mjs:51` misses the same spelling.

3. **DESIGN — the duplicate-JSON scanner compares raw source spellings, not decoded JSON keys.**

   The scanner drops an escape introducer and appends the next source character literally at `src/messaging/telegram-egress.ts:127-131`; it never JSON-decodes keys before checking `seen` at `:137-140`. `JSON.parse` subsequently decodes keys and retains the last value at `:195-207`.

   Telegram decodes each JSON member name, preserves argument order, and takes the first matching argument ([Telegram HttpReader](https://github.com/tdlib/td/blob/master/tdnet/td/net/HttpReader.cpp), [Telegram Query](https://raw.githubusercontent.com/tdlib/telegram-bot-api/master/telegram-bot-api/Query.h)).

   Concrete failure path: two top-level keys decode to the same reader-visible parameter but have different source spellings. The scanner considers them distinct, the door checks the last value, and Telegram uses the first. Both the bypass and opposite over-refusal directions are reopened.

4. **DESIGN — the method table confuses a valid empty/no-op value with a method having no reader-visible field.**

   `answerCallbackQuery` is classified as bodyless at `src/messaging/invisible-payload.ts:164-174` because omitted or empty text may dismiss the spinner, although `:117-123` admits it has reader-visible text. Telegram documents `text` as its notification body and `show_alert` as selecting an alert ([Bot API](https://core.telegram.org/bots/api#answercallbackquery)). A dynamic handler result reaches this method at `src/messaging/TelegramAdapter.ts:5461-5472`.

   Concrete under-refusal: a non-empty but mechanically invisible handler result becomes a blank notification or alert because the whole method is exempt.

   The inverse defect exists for `editForumTopic`, mapped unconditionally to `name` at `src/messaging/invisible-payload.ts:125-139`. Telegram documents an empty name as preserving the current name ([Bot API](https://core.telegram.org/bots/api#editforumtopic)). An icon-only edit carrying an empty name is therefore wrongly refused.

5. **DESIGN — the lint’s case-insensitive and concatenation claims are defeated outside and inside its recognizer.**

   `hasHostMark` is case-insensitive at `scripts/lint-telegram-egress-boundary.mjs:51-52`, but the file loop first applies a case-sensitive lowercase prefilter at `:122-125`. The uppercase-host canary at `:186-203` calls the recognizer directly and never exercises that prefilter.

   The binary-expression logic at `:75-80` ORs recognition of each operand rather than evaluating concatenated pieces. Local-helper resolution similarly searches an initializer for the complete marker at `:89-98`.

   Concrete failure path: a direct Bot API fetch outside the door using an uppercase literal or a host marker assembled across operands is missed, after which the lint prints categorical confinement at `:230-232`. These are additional to its stated alias/import limits.

6. **DESIGN — “unreadable” is determined from the JavaScript wrapper rather than Telegram’s effective parameter.**

   `src/messaging/telegram-egress.ts:247-250` claims Blob, ArrayBuffer, typed-array, and stream bodies are not accepted parameter encodings. Telegram’s documented encodings are HTTP media types: JSON or form bytes remain accepted regardless of the JavaScript `BodyInit` wrapper ([Bot API request formats](https://core.telegram.org/bots/api#making-requests)). A fresh `Request` is also cloneable and readable, contrary to `:265-273`.

   More directly, query precedence is correctly recorded at `:172-188`, but an unreadable, irrelevant body still causes refusal at `:304-319` even when the query already supplies the effective reader-visible field.

   Concrete failure path: a visible query value accompanied by an ignored byte-oriented body is decidable and deliverable, yet rejected. Valid JSON bytes carried by a Blob or fresh Request are likewise destroyed.

7. **DESIGN — the new Request refusal is absent from the structured decision stream.**

   The early throw at `src/messaging/telegram-egress.ts:265-274` precedes both `emitInvisiblePayloadRefusal` sites at `:283-315`.

   The test named “records the door’s OWN refusals” covers only unknown methods and unparseable bodies at `tests/unit/telegram-egress-boundary.test.ts:252`, while the spec promises that every refusal is emitted at `docs/specs/telegram-egress-invisible-payload-guard.md:304` and `:477`.

   Concrete failure path: a Telegram Request object is blocked, but no `unreadable-request` record is emitted and the error carries no decision. A catcher can erase the refusal completely.

8. **PRECISION — “exactly one function issues an HTTP request to the Telegram API host” is false in the live tree.**

   The current shipped-state section makes that claim at `docs/specs/telegram-egress-invisible-payload-guard.md:222`; the door repeats it at `src/messaging/telegram-egress.ts:253`.

   Existing direct Telegram-host fetches occur at:

   - `src/messaging/TelegramAdapter.ts:3212`
   - `src/lifeline/TelegramLifeline.ts:1322`
   - `src/lifeline/TelegramLifeline.ts:1353`

   They are file downloads and do not carry reader-visible outbound bodies, so they are not safety bypasses. They nevertheless falsify the host-wide claim. The lint actually recognizes only the narrower `api.telegram.org/bot` marker.

9. **PRECISION — the spec sweep left multiple live, unsuperseded descriptions of the deleted design.**

   The decision table still attributes body-method derivation and a shrink ratchet to the current lint at `docs/specs/telegram-egress-invisible-payload-guard.md:327`. The frontloaded decisions still prescribe per-sender presence and baselines at `:356-367`; rollback instructs maintainers to remove deleted guard calls at `:447-449`; and the acceptance/known-limit sections still require the deleted per-file lint and ratchet at `:453-479` and `:501-508`.

   Concrete failure path: a maintainer following the governing acceptance or rollback sections searches for nonexistent guard calls and ratchets, or attributes predecessor properties to the current boundary. The summary’s broad warning at `:50-57` does not make these unlabelled governing sections true or safely historical.

## REGRESSION-CHECK

1. **Still open, but incompletely described.** The malformed-tag over-refusal and encoded-invisible/emphasis under-refusals remain at `src/messaging/invisible-payload.ts:312-337`. The explicitly allowed valid-pure-markup case at `:363-379` is a third known under-refusal: valid markup with no text node renders as nothing and is deliberately sent.

2. **Still open as described.** The surviving guard sits immediately before the tokenless cross-machine relay at `src/messaging/TelegramAdapter.ts:1380-1402`.

3. **Still open as described.** Runtime property escapes remain at `src/messaging/invisible-payload.ts:64` and `:77`; the vendored table remains assigned to CMT-1261 at `:83-89`.

4. **Still open as described.** `relayOutbound` recognizes only 422 at `src/core/TelegramRelay.ts:126-147`; `tests/unit/telegram-relay-refusal-status-conflation.test.ts:37-69` contains the three stated pins.

5. **The named limits remain open, but the description is incomplete.** The blinded-door and alias/computed-fetch limits are stated at `scripts/lint-telegram-egress-boundary.mjs:25-40` and `:101-110`. Finding 5 adds the unstated case-sensitive prefilter and split-marker failures.

6. **Still open as described.** `tests/unit/standards-coverage-ratchet.test.ts:906-925` deliberately expects a current six-family audit while recording Building and The Substrate as stale. Changing that expectation would forge acceptance.

Executable verification could not be repeated because this archive lacks `node_modules` and the Vitest/TypeScript project configuration.