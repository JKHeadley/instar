The report was printed to command stdout. I could not create `PASS47-VERDICT.md`: the workspace is mounted read-only, and the write attempt was rejected.

=== VERDICT ===

UNSOUND — three independent egress/model mismatches can admit content that Telegram renders as nothing. Three additional load-bearing claims are false of the code or Telegram’s live grammar. Previously stated-open defects are not counted again.

=== MAGNITUDE ===

6 load-bearing findings: 3 DESIGN, 3 PRECISION.

## FINDINGS

1. **DESIGN — a phantom `text` field on rich-message methods opens the unreadable-body exception.**

   [invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:125) classifies `sendRichMessage` and `sendRichMessageDraft` as accepting alternative fields `text` and `rich_message`. They do not: the live API requires only `rich_message` for both methods ([sendRichMessage](https://core.telegram.org/bots/api#sendrichmessage), [sendRichMessageDraft](https://core.telegram.org/bots/api#sendrichmessagedraft)), and the server reads only `rich_message` ([official implementation](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L11607-L11619)).

   Byte-oriented bodies become unreadable at [telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:272), but any query-supplied mapped field waives refusal at [telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:383).

   Concrete failure path: a rich-message request supplies a harmless visible query `text` and carries the actual reader-invisible `rich_message` in a byte-oriented JSON body. The door treats unsupported `text` as decisive, never inspects the body, and sends it; Telegram ignores `text` and consumes `rich_message`.

   The pinning test repeats the wrong table while claiming live-documentation verification ([telegram-send-funnel-invisible-payload.test.ts](/Users/justin/window12-exam/tests/unit/telegram-send-funnel-invisible-payload.test.ts:542)), disproving the spec’s assertion that this pin makes silent drift impossible ([spec](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:329)). This is an intersection of declared residuals, not a recount of either one alone.

2. **DESIGN — the RichText walker is not the grammar; it traverses Telegram-ignored object members.**

   `structuredTextLeaves` loops through every property and recursively descends every object-valued property ([invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:432)). Telegram instead selects a `type` discriminator and extracts only that variant’s defined fields before returning; for example, URL consumes `text` and `url`, while reference consumes `text` and `name` ([official parser](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L11326-L11443)).

   Concrete failure path: a valid wrapper has an invisible real label and an extra, server-ignored nested member containing a visible-looking `text` leaf. The door counts the ignored leaf and allows; Telegram discards it and renders only the invisible label.

   This contradicts the source claim that the walker visits “exactly” the literals ([invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:368)).

3. **DESIGN — mathematical expressions are checked as source code, not rendered content.**

   Inline and block mathematical expressions are LaTeX ([RichTextMathematicalExpression](https://core.telegram.org/bots/api#richtextmathematicalexpression), [InputRichBlockMathematicalExpression](https://core.telegram.org/bots/api#inputrichblockmathematicalexpression)). Telegram explicitly says formula source is treated as raw LaTeX.

   The walker classifies `expression` as an ordinary unformatted string ([invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:432)), then accepts it whenever source characters satisfy the Unicode predicate ([invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:464)).

   Concrete failure path: a valid layout/spacing-only LaTeX expression contains letters or punctuation in its source but paints no visible glyph. The source passes while the rendered message is empty. This extends CMT-1260 beyond its stated HTML/Markdown scope.

4. **PRECISION — the test advertised as exercising the “REAL RichText grammar” uses invalid Bot API discriminator values.**

   [telegram-egress-boundary.test.ts](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:332) uses `richTexts`, `richTextBold`, `richTextPlain`, and block type `math`. The Bot API uses a bare array for a sequence and discriminator values such as `bold` and `mathematical_expression`; unsupported types are rejected by Telegram’s parser ([official parser](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L11312-L11447)).

   The mocks prove only that the key-blind walker finds nested strings. They do not exercise Telegram-valid union members. The test title and comments at lines 332–335 are false coverage claims.

5. **PRECISION — the recorded `RichTextReference.name` ambiguity is backwards.**

   [invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:401) says `name` is the displayed reference label and that excluding it wrongly refuses a reference whose only visible content is its name.

   The live schema says `text` is the displayed “Text of the reference”; `name` is its identifier ([RichTextReference](https://core.telegram.org/bots/api#richtextreference)). Telegram’s parser likewise recursively parses `text` separately from `name` ([official implementation](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L11424-L11427)).

   The comment’s concrete failure path does not exist: a visible reference label is already walked through `text`. Applying the suggested discriminator repair to count `name` would instead count a non-rendered identifier and could introduce an under-refusal.

6. **PRECISION — the closeout’s classified-method population is internally contradictory.**

   [window12-closeout.md](/Users/justin/window12-exam/docs/specs/reports/window12-closeout.md:40) says the closed world contains 17 methods: four reader-visible plus 13 bodyless.

   The code contains six reader-visible methods ([invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:125)) and 13 bodyless methods ([invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:184)), totaling 19. The same closeout later reports 19 ([window12-closeout.md](/Users/justin/window12-exam/docs/specs/reports/window12-closeout.md:207)).

   Concrete failure path: a maintainer auditing the load-bearing closed-world population from the headline table begins two members short and can accept a falsely complete sweep.

## REGRESSION-CHECK

- **Redirect crossing:** Still open exactly as described. Classification occurs once from the initial URL ([telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:36)); final `fetch` retains default redirect following.

- **Encoding inferred from wrapper rather than `Content-Type`:** Still open. `collectParams` branches only on body value/type ([telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:215)) and never reads headers.

- **Irrelevant duplicated JSON keys:** Still open as an over-refusal. Any top-level duplicate makes the whole body unreadable before relevance is considered ([telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:217)).

- **`answerCallbackQuery`:** Still a stated product judgment rather than a mechanical no-content fact; it remains bodyless ([invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:176)).

- **`editForumTopic`:** Still guarded unconditionally through `name`; empty-name/preserve-current semantics remain unmodeled ([invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:140)).

- **Local Bot API Server:** Still outside runtime and lint recognition because both hard-code `api.telegram.org` ([telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:60), [lint](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:48)). Telegram supports replacing the cloud endpoint with a [local server](https://github.com/tdlib/telegram-bot-api#moving-a-bot-to-a-local-server).

- **Multipart claim:** Still false. FormData becomes a URL-encoded string ([telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:313)), changing its representation and normally its media type. The multipart test checks only whether mocked fetch was called.

- **Single-read claim:** Still false. `{ ...init }` invokes an enumerable `body` getter again ([telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:427)). The test checks only the final outgoing body, not the getter count ([telegram-egress-boundary.test.ts](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:275)). The captured value overwrites the second result, so this is now a claim/side-effect defect rather than the old direct body swap.

- **Live-method-table claim:** Still false; its new consequence is Finding 1. The test pins the source table to itself instead of comparing it with the API.

- **Structured content only in JSON bodies:** Still open. Query/form/multipart collection leaves `rich_message` as a JSON-serialized string, after which JSON punctuation satisfies the scalar predicate.

- **Cross-field query/body precedence:** Still open and unsafe. The waiver uses `fields.some(...)` ([telegram-egress.ts](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:389)), but Telegram’s `editMessageText` chooses `rich_message` whenever present before falling back to `text` ([official implementation](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp#L13605-L13612)).

- **Destination fields:** Excluding live URL/e-mail/phone/anchor/reference-link destinations remains correct because the displayed label is `text`. The claimed `RichTextReference.name` exception is wrong, per Finding 5. `document`/`RichTextIcon` is absent from the live Bot API RichText union, so the “live grammar” comment is also stale there.

- **No-leaf structures:** Still open and unsafe. All no-leaf objects are allowed ([invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:464)), but the union contains both visible media/dividers and non-rendered anchors. Telegram expressly permits an empty named anchor.

- **Normalized host spellings in lint:** Still open. The prefilter and recognizer depend on literal `api.telegram.org/` source text rather than URL semantics ([lint](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:51)).

- **`fetch.call`/`fetch.apply`:** Still open. The callee is recognized, but analysis always treats argument zero as the URL ([lint](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:151)); for `call` it is the receiver, while `apply` stores arguments in an array. No canary covers either.

- **Token-root `method` fallback:** The open description is wrong. The broad characterization is accurate for ordinary HTTP requests: the server extracts an empty path method ([HttpConnection.cpp](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/HttpConnection.cpp#L25-L45)), then falls back to the first `method` argument ([Query.cpp](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Query.cpp#L37-L40)). This item should be closed as disproven.

- **Rendering shortcut / CMT-1260:** Still open. HTML/Markdown are locally approximated ([invisible-payload.ts](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:298)); the stated malformed-tag over-refusal and encoded/delimiter under-refusals remain. Its description is incomplete because LaTeX adds Finding 3.

- **Surviving per-sender guard:** Still open exactly as described. The tokenless standby checks before sending text to another machine ([TelegramAdapter.ts](/Users/justin/window12-exam/src/messaging/TelegramAdapter.ts:1380)); this process’s door cannot observe the eventual Bot API request.

- **Runtime Unicode table / CMT-1261:** Still open. The predicate uses runtime property escapes and records the engine/version but does not pin or vendor the table.

- **Relay refusal/unreachable conflation / CMT-1247:** Still open. Only 422 becomes `RelayRefusal`; every other non-OK response returns `null` ([TelegramRelay.ts](/Users/justin/window12-exam/src/core/TelegramRelay.ts:126)).

- **Blinded door and aliased fetch:** Still open. The lint explicitly does not validate method-recovery behavior or follow a fetch reference stored under another name. Its categorical clean output therefore remains broader than its analysis.

- **Deliberately red family audit:** The assertion still expects `current` while comments identify Building and The Substrate as stale ([standards-coverage-ratchet.test.ts](/Users/justin/window12-exam/tests/unit/standards-coverage-ratchet.test.ts:906)). Runtime confirmation was unavailable because this copy lacks `js-yaml` and `typescript`; consequently, the standards script, boundary lint, and test suite could not execute. Static inspection confirms the red expectation remains.

The directory has no Git metadata, so the stated SHA, cleanliness, and local/remote equality could not be independently verified from this copy.