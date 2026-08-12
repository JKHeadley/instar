=== VERDICT ===
UNSOUND. No fresh runtime bypass outside the already named rich-source reduction/root was found in this pass, but the guarantee is still not sound because stated-open under-refusals remain: valid no-leaf rich structures are allowed, and structured rich content sent through query/form/multipart is still inspected as a serialized string rather than as the object Telegram parses. One new precision defect remains in the spec.

=== MAGNITUDE ===
NEW load-bearing findings: DESIGN 0, PRECISION 1. Previously-stated-open items are not counted here.

## FINDINGS

1. PRECISION - The spec's current method-to-field example is stale and omits `rich_message` for `editMessageText`.

   Evidence: `docs/specs/telegram-egress-invisible-payload-guard.md:136-143` still lists `editMessageText -> text`. The code now maps `editMessageText` to `['rich_message', 'text']`, with `rich_message` highest precedence, at `src/messaging/invisible-payload.ts:125-140`; the pinned unit expectation agrees at `tests/unit/telegram-send-funnel-invisible-payload.test.ts:581-590`. This is not a runtime bypass today, because the code and tests are correct. It is a false source/spec claim: a later reader using the spec table as the coverage account would believe `editMessageText` has only one reader-visible field and could re-open the pass-43/pass-45 class while following the documented design.

   Failure path: reviewer or maintainer audits the field map from the approved spec section, concludes `editMessageText` only needs `text`, and accepts a change that removes or reorders the `rich_message` arm. The live code's current guard would then stop matching Telegram's precedence model.

Not counted as NEW: further cases where raw rich HTML/Markdown source can vouch for rendering are instances of the named root, not a new class. The file names the root at `src/messaging/invisible-payload.ts:345-374`; the still-open raw-source media waiver remains in the `sourceRendersMedia` path at `src/messaging/invisible-payload.ts:764-803`.

Concrete inversion account: to close the named root, the rich-source path must stop subtracting known markup from raw source. It must positively extract only tokens Telegram proves rendered: text nodes after rich HTML/Markdown parsing; inline media only from actual embedding positions; declared media only when an embedded `tg://photo|video|audio?id=` reference resolves to a declared id; custom emoji embeddings; formula regions only as an undecidable/rendering token when their formula body itself contains content; and no-content for anchors/comments/attributes/destinations/discarded arms. Anything outside that positive grammar must not vouch for visibility.

## REGRESSION-CHECK

- Redirect crossing: confirmed still open. The door classifies only the initial URL (`src/messaging/telegram-egress.ts:36-45`) and the final `fetch` uses default redirect following (`src/messaging/telegram-egress.ts:487`).
- Body encoding from JavaScript wrapper: confirmed still open. `collectParams` branches on body runtime type, while its own comment states Content-Type is not governing the parse (`src/messaging/telegram-egress.ts:234-245`, `src/messaging/telegram-egress.ts:256-314`).
- Duplicate top-level JSON key: confirmed. Any duplicate top-level key makes the body unreadable before relevance is considered (`src/messaging/telegram-egress.ts:162-195`, `src/messaging/telegram-egress.ts:266-269`).
- `answerCallbackQuery` and `editForumTopic`: confirmed as product judgments. `answerCallbackQuery` is deliberately excluded despite a `text` parameter (`src/messaging/invisible-payload.ts:121-123`, `src/messaging/invisible-payload.ts:195`); `editForumTopic` is guarded as `name`, but the classification remains a product decision about topic-title visibility (`src/messaging/invisible-payload.ts:150-160`).
- Local Bot API Server endpoint: confirmed still open. Runtime and lint hard-code `api.telegram.org` (`src/messaging/telegram-egress.ts:60-73`, `scripts/lint-telegram-egress-boundary.mjs:54-55`, `scripts/lint-telegram-egress-boundary.mjs:145-147`).
- Multipart claim and single-read claim: multipart remains false/limited; FormData is converted to `URLSearchParams` before send (`src/messaging/telegram-egress.ts:358-365`), so "multipart delivers" in `tests/unit/telegram-egress-boundary.test.ts:106-112` is not true of the outgoing representation. The single-read body getter claim appears corrected by the explicit copy that skips `body` (`src/messaging/telegram-egress.ts:481-486`) and the read-count test (`tests/unit/telegram-egress-boundary.test.ts:439-453`).
- Structured content outside JSON body: confirmed still open. Query/form/multipart collection leaves values as strings (`src/messaging/telegram-egress.ts:247-250`, `src/messaging/telegram-egress.ts:277-285`, `src/messaging/telegram-egress.ts:305-307`), while structured scanning only runs when the effective field is an object (`src/messaging/invisible-payload.ts:866-870`).
- Lint host prefilter: confirmed still literal-source based. Files without literal `api.telegram.org` text are skipped before AST analysis (`scripts/lint-telegram-egress-boundary.mjs:145-147`).
- No-leaf structures: confirmed still allowed. Anchor is distinguished from unreadable media/formula (`src/messaging/invisible-payload.ts:493-536`), but `assertOneOutgoingField` returns on `leaves.length === 0` (`src/messaging/invisible-payload.ts:858-870`). A structure proven to render nothing should not be allowed if the guarantee is literal.
- Deliberately red family-audit assertion: not re-run in this copy. The tree has no `node_modules` or lockfile, `node scripts/lint-telegram-egress-boundary.mjs` fails with missing `typescript`, and a focused `npx vitest` run produced no output before being interrupted.

Local verification note: dependency-backed commands were not runnable from this no-dependency copy. Static reading was completed against the requested files, and current Telegram Bot API docs/server source were checked for the rich-message model and current method set.
