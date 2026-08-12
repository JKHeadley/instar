The workspace is read-only, so creating `PASS40-VERDICT.md` was rejected. The requested report is printed below.

=== VERDICT ===

UNSOUND

Beyond the acknowledged rendering under-refusals, two unchecked egress paths remain: test-environment method-in-parameter requests and mutation between inspection and `fetch`. The boundary lint also cannot sustain its categorical confinement claim. Several source/spec claims remain materially false.

=== MAGNITUDE ===

7 load-bearing findings: **3 DESIGN, 4 PRECISION**.

## FINDINGS

1. **DESIGN — Test-environment token-root requests bypass method classification.**

   Evidence: [telegram-egress.ts:67](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:67), [telegram-egress.ts:111](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:111), [telegram-egress.ts:317](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:317), [telegram-egress-boundary.test.ts:198](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:198), [telegram-egress-boundary.test.ts:221](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:221).

   Telegram’s server removes the optional `test` segment and treats the entire remaining path as the method; when that method is empty, its query layer falls back to the first `method` argument. See Telegram’s [HTTP path extraction](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/HttpConnection.cpp#L33-L45) and [method-argument fallback](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Query.cpp#L555-L590).

   `BOT_PATH` returns no method for a test-environment token root, while `isBotApiRoot` recognizes only the production root. Consequently, a test-environment root request whose method and reader-facing field are parameters reaches `fetch` without classification or visibility checking. The tests cover test paths with a path method and production roots with a parameter method, but not their intersection.

2. **DESIGN — The inspected body need not be the body passed to `fetch`.**

   Evidence: [telegram-egress.ts:16](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:16), [telegram-egress.ts:366](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:366), [telegram-egress.ts:391](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:391), [TelegramAdapter.ts:5794](/Users/justin/window12-exam/src/messaging/TelegramAdapter.ts:5794).

   The door reads `init.body`, checks that value, and later gives the original mutable `init` object to `fetch`. A valid stateful `RequestInit` property—or another mutation of the object during those accesses—can therefore expose visible content to the check and different, invisible content to native `fetch`.

   This directly falsifies the claims that the door checks “the exact bytes about to go on the wire” and that the adapter’s checked bytes are “the exact bytes Telegram receives.” The boundary needs a captured, immutable request representation, not a check followed by reuse of the caller-owned wrapper.

3. **DESIGN — The lint has additional unacknowledged direct-egress blind spots.**

   Evidence: [lint-telegram-egress-boundary.mjs:58](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:58), [lint-telegram-egress-boundary.mjs:74](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:74), [lint-telegram-egress-boundary.mjs:104](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:104), [lint-telegram-egress-boundary.mjs:235](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:235).

   The scan includes only `.ts`, although executable `.js` and `.mjs` files exist under `src`. Its binary-expression handling recursively searches operands for a complete host marker; it does not constant-fold a host split across concatenated literals. Its call matcher also misses direct invocation through `call`, `apply`, or computed property access.

   A direct Bot API request placed in any such shape can therefore bypass `telegramFetch` while the lint prints that all egress is confined. These are additional to the already-stated imported-URL and renamed-`fetch` limitations.

4. **PRECISION — Path recognition consumes an alphabetic prefix, while Telegram consumes the entire remaining path.**

   Evidence: [telegram-egress.ts:67](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:67), [telegram-egress.ts:76](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:76), [telegram-egress.ts:341](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:341).

   `BOT_PATH` is not end-anchored and captures only `[A-Za-z]+`. Telegram instead uses the complete residual path as the method. A path beginning with a known method followed by a nonletter suffix is classified locally as the known method and forwarded, while Telegram sees an unknown full method and rejects it.

   This is not presently an invisible-message delivery bypass, because Telegram rejects the request. It is nevertheless a false closed-world decision and disproves the comment that the locally recovered method “cannot disagree with the request.”

5. **PRECISION — The specification still describes a predicate different from the implementation.**

   Evidence: [telegram-egress-invisible-payload-guard.md:239](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:239), [telegram-egress-invisible-payload-guard.md:268](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:268), [telegram-egress-invisible-payload-guard.md:325](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:325), [telegram-egress-invisible-payload-guard.md:339](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:339), [invisible-payload.ts:64](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:64), [invisible-payload.ts:76](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:76), [invisible-payload.ts:91](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:91), [invisible-payload.ts:109](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:109).

   The spec repeatedly says the implemented guarantee is merely membership in `L/N/P/S/M`. The implementation additionally subtracts `Default_Ignorable_Code_Point` and five explicit blank glyphs. The multi-machine section then says drift is bounded to General Category membership and derives a fail-safe direction from that premise.

   A maintainer following the spec would audit only category changes and omit a runtime Unicode property that actually participates in every verdict. Therefore both the claimed predicate and the claimed bound/direction of version drift are unsupported.

6. **PRECISION — The spec’s live lint-population row describes the deleted lint, not the current one.**

   Evidence: [telegram-egress-invisible-payload-guard.md:327](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:327), [lint-telegram-egress-boundary.mjs:125](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:125), [lint-telegram-egress-boundary.mjs:222](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:222).

   The row says population membership requires building the API host, calling `fetch`, and referencing a body-carrying method, with a shrink-only ratchet. The current lint does not inspect body-carrying method references and contains no population ratchet. It scans host-marked direct fetch calls and emits violations.

   Thus method references can change—or the recognizer can silently lose a source—without the claimed ratchet firing. The supersession notices elsewhere do not supersede this live decision-table claim.

7. **PRECISION — Comments attribute plain-text fallback to Telegram, but fallback belongs to the adapter.**

   Evidence: [invisible-payload.ts:312](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:312), [invisible-payload.ts:365](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:365), [TelegramAdapter.ts:1411](/Users/justin/window12-exam/src/messaging/TelegramAdapter.ts:1411).

   Telegram rejects malformed entity markup; it does not itself successfully deliver the source as plain text. The local adapter catches the failed HTML attempt and issues a second request without `parse_mode`.

   The acknowledged over-refusal remains real on that adapter path: the door refuses before Telegram can return the parse error that would trigger the retry. But a direct `telegramFetch` caller receives only Telegram’s error. Statements saying Telegram “falls back to sending the source” are false and incorrectly assign responsibility for the recovery behavior.

## REGRESSION-CHECK

- **Unnumbered open — `answerCallbackQuery` / `editForumTopic` classification:** Still open. The product judgments remain explicit at [invisible-payload.ts:121](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:121) and [invisible-payload.ts:137](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:137). The test title claiming the map is “exactly” all reader-visible methods remains stronger than that acknowledged policy judgment.

- **Unnumbered open — byte-oriented bodies classified by JavaScript wrapper:** Still open. [telegram-egress.ts:269](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:269) refuses byte bodies without consulting `Content-Type`, although Telegram chooses JSON, form, or multipart parsing from the media type. The description is correct but incomplete: the door generally models wrapper type rather than the transmitted request representation.

- **1. Rendering shortcut:** Still open in both stated directions at [invisible-payload.ts:312](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:312) and [invisible-payload.ts:323](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:323). The over-refusal description is correct only when the adapter’s retry is included; Telegram itself does not perform the claimed fallback.

- **2. Surviving per-sender guard:** Still open exactly as described. The sole guard remains at [TelegramAdapter.ts:1401](/Users/justin/window12-exam/src/messaging/TelegramAdapter.ts:1401) before transfer to another machine.

- **3. Unicode table not vendored:** Still open, but its account is incomplete. Runtime Unicode escapes remain, while the spec incorrectly limits drift to General Category and omits the runtime `Default_Ignorable` dependency described in finding 5.

- **4. Relay refusal/unreachable conflation:** Still open exactly as described. [TelegramRelay.ts:134](/Users/justin/window12-exam/src/core/TelegramRelay.ts:134) recognizes only 422; other non-success statuses become `null`. The three pinning tests remain at [telegram-relay-refusal-status-conflation.test.ts:37](/Users/justin/window12-exam/tests/unit/telegram-relay-refusal-status-conflation.test.ts:37).

- **5. Lint limits:** The named blind-door, imported-URL, and renamed-`fetch` limitations remain. The description is not exhaustive: finding 3 identifies further direct-egress forms that the lint misses while retaining its categorical clean output.

- **6. Deliberately red family-audit assertion:** Still present as described at [standards-coverage-ratchet.test.ts:906](/Users/justin/window12-exam/tests/unit/standards-coverage-ratchet.test.ts:906) and [standards-coverage-ratchet.test.ts:923](/Users/justin/window12-exam/tests/unit/standards-coverage-ratchet.test.ts:923). Execution was unavailable because this copy has no installed test dependencies; statically, the expectation still demands `current` while its comment records Building and The Substrate as stale.