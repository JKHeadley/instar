=== VERDICT ===
UNSOUND. The repairs closed the formula-body vouching bug for all three formula representations, but the rich-message media recogniser still treats a declared media id as rendered media wherever the id string appears in the markdown/html source, not only in media-embedding syntax. That lets an otherwise invisible rich message be waved through as `undecidable` even when Telegram renders no media and no visible text.

=== MAGNITUDE ===
NEW load-bearing findings: 1 PRECISION, 0 DESIGN. Previously-stated-open items remain separate and are not counted here.

## FINDINGS

1. PRECISION - declared rich-message media references are recognised by substring, not by media syntax.

Evidence: `src/messaging/invisible-payload.ts:619` says the media array matters only when media are specified in the markdown/html fields using `tg://photo?id=`, `tg://video?id=`, or `tg://audio?id=` links, and `src/messaging/invisible-payload.ts:646` frames the helper as deciding whether the source puts media in front of a reader. But the implementation at `src/messaging/invisible-payload.ts:669` builds a regex for the bare `tg://photo|video|audio?id=<id>` URL and `src/messaging/invisible-payload.ts:670` accepts any occurrence in the source. It does not require markdown image syntax, an HTML media tag, or any other embedding position that actually renders a media block. Once that loose match succeeds, `src/messaging/invisible-payload.ts:698`-`700` marks the rich source `undecidable`, and `src/messaging/invisible-payload.ts:764`-`767` allows the whole structured field before checking that the only text leaf renders invisible.

Concrete failure path: a `sendRichMessage` or `editMessageText` request carries `rich_message` in the JSON body, chooses the `markdown` or `html` arm, includes only invisible displayed text, includes a `media` declaration with an id, and mentions that id in a non-media URL position rather than in a media block. Telegram's rich-message API treats `media` as declarations used by markdown/html media references, not as visible content by presence alone; a URL used as a link target/attribute is not the displayed label and does not put the media in front of the reader. The guard sees the id substring, sets `undecidable`, returns early, and the network send proceeds although the reader-visible result is nothing.

## REGRESSION-CHECK

Redirect crossing: still open as stated; `src/messaging/telegram-egress.ts:36`-`45` classifies once from the initial URL and lets `fetch` follow redirects.

Body encoding from wrapper: still open as stated; `src/messaging/telegram-egress.ts:234`-`245` records that `collectParams` branches on the JavaScript body wrapper instead of `Content-Type`.

Duplicated top-level JSON key: still refused before relevance; `src/messaging/telegram-egress.ts:266`-`269` returns an unreadable-request reason on any duplicate top-level key.

`answerCallbackQuery` and `editForumTopic`: unchanged product judgments; `src/messaging/invisible-payload.ts:121`-`123`, `src/messaging/invisible-payload.ts:159`-`160`, and `src/messaging/invisible-payload.ts:186`-`193` still classify them deliberately rather than mechanically.

Local Bot API Server: still open as stated; runtime host recognition is hard-coded at `src/messaging/telegram-egress.ts:60`-`72`, and lint uses the literal host marker at `scripts/lint-telegram-egress-boundary.mjs:51`-`55`.

Multipart and single-read prose: still not fully true as a byte claim; `src/messaging/telegram-egress.ts:353`-`365` freezes `FormData` by converting string parts to URL encoding, then sends that rebuilt body at `src/messaging/telegram-egress.ts:472`-`474`.

Structured content outside JSON body: still open as stated; query/form/multipart collection stores string values (`src/messaging/telegram-egress.ts:246`-`249`, `src/messaging/telegram-egress.ts:280`-`284`, `src/messaging/telegram-egress.ts:305`-`307`), while object scanning only runs when `raw` is an object at `src/messaging/invisible-payload.ts:764`.

Lint host prefilter: still literal-source dependent; `scripts/lint-telegram-egress-boundary.mjs:145`-`147` skips files without the literal `api.telegram.org` text.

No-leaf structures: still allowed; `src/messaging/invisible-payload.ts:764`-`767` returns on zero leaves, and the pass-49 regression test records formula-only allowance at `tests/unit/telegram-egress-boundary.test.ts:513`-`527`. A structure proven to render nothing should not still be allowed; that remains a real open gap, not a new finding in this pass.

Formula source with characters but no glyphs: still stated-open in effect; `src/messaging/invisible-payload.ts:516`-`522` treats any formula body with content code points as opaque/undecidable because there is no renderer.

Deliberately red family-audit assertion: not evaluated as a guarantee regression here; the tree copy lacks installed dependencies, and the brief already states the red expectation is intentionally waiting for real multi-reviewer convergence rather than an edited acceptance.
