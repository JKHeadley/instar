=== VERDICT ===
UNSOUND - the door still allows rich-message payloads whose source text contains visible-looking markup/reference bytes that Telegram does not render as reader-visible content. The new issues are in the rich-message source model, not in ordinary JSON serialization or the egress funnel.

=== MAGNITUDE ===
2 NEW load-bearing findings: 0 DESIGN, 2 PRECISION. Stated-open items below are not counted.

## FINDINGS

1. PRECISION - Rich Markdown HTML is judged as Markdown source, so tag and attribute bytes can vouch for a message whose rendered text is empty.

Evidence: `src/messaging/invisible-payload.ts:699-725` scans the `markdown` arm as mode `'Markdown'`, and `src/messaging/invisible-payload.ts:357-363` reduces Markdown only by stripping Markdown link/image syntax. It never applies the HTML tag removal used for the `html` arm at `src/messaging/invisible-payload.ts:354-356`. Telegram's current Rich Markdown documentation says Rich Markdown can contain arbitrary supported HTML and parses those tags as Rich HTML; the docs list supported `<a href=...>` style links and anchors.

Failure path: a `sendRichMessage` or `editMessageText` request with a JSON-body `rich_message.markdown` arm whose only rendered text node is invisible, while the visible code points live in supported HTML tag names or attributes, is treated as visible by this guard. Telegram parses the HTML inside Rich Markdown and displays only the invisible label/body, so a payload reaching the reader as nothing can leave.

2. PRECISION - Declared rich media IDs are matched by prefix, not as the exact `id` value Telegram resolves.

Evidence: `src/messaging/invisible-payload.ts:675-683` builds the embed regex as `id=${idPattern}[^)]*` / `id=${idPattern}[^"']*`, and `src/messaging/invisible-payload.ts:689-695` treats any match as rendered media. The test at `tests/unit/telegram-egress-boundary.test.ts:628-634` covers a totally different undeclared ID, but not an ID where the declared value is a prefix of the referenced value.

Failure path: a rich markdown/html source can embed a `tg://photo`, `tg://video`, or `tg://audio` URL whose `id` parameter starts with a declared media id but is not equal to it. The guard marks the message undecidable/rendering because the prefix matches, then `src/messaging/invisible-payload.ts:788-791` allows the structured field. Telegram's `InputRichMessageMedia.id` is the unique identifier used in the link, so the longer id is a different, undeclared reference; the declared entry does not render the referenced media. With the surrounding text leaves invisible, the guard waives the refusal on content Telegram will not show.

## REGRESSION-CHECK

- Redirect crossing remains STATED OPEN: `src/messaging/telegram-egress.ts:36-45` classifies only the initial URL and still lets `fetch` follow redirects.
- Body encoding remains STATED OPEN: `src/messaging/telegram-egress.ts:235-244` says the collector branches on the JavaScript body wrapper rather than `Content-Type`, and the code does that at `src/messaging/telegram-egress.ts:256-314`.
- Duplicate top-level JSON keys remain intentionally refused before relevance: `src/messaging/telegram-egress.ts:261-269` makes any duplicate top-level key unreadable, not only duplicated reader-visible keys.
- `answerCallbackQuery` and `editForumTopic` remain product judgments: `answerCallbackQuery` is in the no-reader-visible set at `src/messaging/invisible-payload.ts:195`, while `editForumTopic` is guarded as `name` at `src/messaging/invisible-payload.ts:160`.
- Local Bot API Server support remains STATED OPEN: runtime hard-codes `api.telegram.org` at `src/messaging/telegram-egress.ts:60-72`; lint hard-codes the same host at `scripts/lint-telegram-egress-boundary.mjs:51-56`.
- The old multipart and single-read prose claims are not currently false in the repaired code: FormData is read at `src/messaging/telegram-egress.ts:299-309`, and the outgoing init now skips `body` while copying at `src/messaging/telegram-egress.ts:481-486`.
- Structured content outside JSON-body representation remains STATED OPEN: query/form/multipart collection leaves values as strings at `src/messaging/telegram-egress.ts:247-249`, `src/messaging/telegram-egress.ts:280-284`, and `src/messaging/telegram-egress.ts:305-307`.
- The lint host prefilter remains literal-source based: `scripts/lint-telegram-egress-boundary.mjs:145-147` skips files without literal `api.telegram.org` text before AST recognition.
- No-leaf structures remain allowed and the distinction is not carried far enough for a literal no-nothing guarantee: anchors are proven non-rendering at `src/messaging/invisible-payload.ts:423-466`, then empty scans are allowed at `src/messaging/invisible-payload.ts:788-791`.
- The deliberately red family-audit assertion is outside this door's runtime guarantee; I did not edit or count it.
