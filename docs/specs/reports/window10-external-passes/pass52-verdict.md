=== VERDICT ===
UNSOUND. The network funnel is materially tighter, but the rich-message source model still lets syntax that Telegram treats as markup or non-rendering structure vouch for an otherwise invisible rendered payload. I found 2 NEW load-bearing findings, both in the rich source reduction.

=== MAGNITUDE ===
NEW load-bearing findings: 0 DESIGN, 2 PRECISION.

## FINDINGS

1. PRECISION — HTML stripping stops at the first `>` byte, even inside quoted attributes.

Evidence: `src/messaging/invisible-payload.ts:354-356` strips HTML with `/<[^>]*>/g`; `src/messaging/invisible-payload.ts:357-370` applies the same stripping to Rich Markdown before its visibility test; `src/messaging/invisible-payload.ts:803` lets any visible residue in a structured leaf vouch for delivery. The code comments say an HTML tag is markup and attributes are never shown (`src/messaging/invisible-payload.ts:331`, `src/messaging/invisible-payload.ts:358-360`), but the regex is not an HTML tokenizer.

Failure path: a supported HTML/Rich Markdown tag can contain a quoted attribute value with `>` and visible-looking bytes after that character. The guard removes only through that first `>`, leaves the rest of the attribute source in the leaf, and treats it as visible content. Telegram parses the full quoted attribute as markup and renders only the invisible text node, so the payload can reach the reader as nothing.

2. PRECISION — media waivers are matched against raw source, not parsed rendering positions.

Evidence: `src/messaging/invisible-payload.ts:667-668` treats direct media/custom emoji syntax as rendering when the regex appears anywhere in the source; `src/messaging/invisible-payload.ts:683-692` accepts a declared media id in any HTML tag with a `src` attribute; `src/messaging/invisible-payload.ts:697-705` returns true on those raw regex matches; `src/messaging/invisible-payload.ts:733-735` turns that into `undecidable`; `src/messaging/invisible-payload.ts:799-802` then allows the structured payload before checking invisible leaves.

Failure path: rich HTML or Rich Markdown can place media-looking syntax in markup that does not render media, such as a non-rendering comment or a `src` attribute on a tag Telegram does not use as a media block. The raw-source regex still grants the media waiver. Telegram renders no media from that position and the remaining text leaf is invisible, so the request can leave and arrive as nothing. This is the same class as pass 50, but still present for the direct-media and over-broad HTML-`src` arms.

Non-counted claim drift: the direct media comment describes "MEDIA" broadly (`src/messaging/invisible-payload.ts:653-658`), while the direct HTTP(S) matcher only recognizes Markdown image syntax and HTML `<img>` (`src/messaging/invisible-payload.ts:667`). Current Bot API rich HTML also has direct `<video>` and `<audio>` media tags, so video/audio-only rich HTML is over-refused. That is not counted above because it destroys visible sends rather than allowing invisible ones, but the source claim is not fully true.

## REGRESSION-CHECK

Redirect crossing: confirmed still open. Classification is from the initial URL only (`src/messaging/telegram-egress.ts:36-45`), and the final `fetch` uses default redirect behavior (`src/messaging/telegram-egress.ts:487`).

Body encoding from wrapper: confirmed still open. `collectParams` branches on JS body shape (`src/messaging/telegram-egress.ts:256-314`) while its own comment states Telegram decides from media type (`src/messaging/telegram-egress.ts:234-245`).

Duplicated top-level JSON key: confirmed closed as stated. The scanner detects decoded duplicate keys (`src/messaging/telegram-egress.ts:162-195`) and JSON bodies with duplicates are refused before relevance (`src/messaging/telegram-egress.ts:266-269`).

`answerCallbackQuery` / `editForumTopic`: unchanged product judgments. `answerCallbackQuery` is declared no-reader-visible (`src/messaging/invisible-payload.ts:186-195`); `editForumTopic` names `name` as visible (`src/messaging/invisible-payload.ts:159-160`).

Local Bot API Server endpoint: confirmed still open. Runtime and lint hard-code `api.telegram.org` (`src/messaging/telegram-egress.ts:60-73`, `scripts/lint-telegram-egress-boundary.mjs:54`, `scripts/lint-telegram-egress-boundary.mjs:147`).

Multipart and single-read claims: multipart claim remains false because FormData is serialized to URLSearchParams before send (`src/messaging/telegram-egress.ts:357-365`), despite multipart prose at `src/messaging/telegram-egress.ts:299-308`. The single-read claim is now true: the body is captured once and copied without re-reading (`src/messaging/telegram-egress.ts:357`, `src/messaging/telegram-egress.ts:481-486`), with a test pin at `tests/unit/telegram-egress-boundary.test.ts:439-453`.

Structured content only in JSON body: confirmed still open. JSON object bodies preserve object structure (`src/messaging/telegram-egress.ts:258-271`), while query/form values are collected as strings (`src/messaging/telegram-egress.ts:246-249`, `src/messaging/telegram-egress.ts:280-284`) and only object-valued fields enter `structuredFieldScan` (`src/messaging/invisible-payload.ts:799-800`).

Lint host prefilter literal source: confirmed still open. The lint skips files by literal source text before AST analysis (`scripts/lint-telegram-egress-boundary.mjs:145-147`).

No-leaf structures: confirmed still allowed, and the distinction is not carried far enough. Anchors and empty structured scans produce no leaves (`src/messaging/invisible-payload.ts:431-432`, `src/messaging/invisible-payload.ts:739-748`), and no-leaf structured fields are allowed (`src/messaging/invisible-payload.ts:801-802`); the formula-only allowance is pinned in `tests/unit/telegram-egress-boundary.test.ts:530-544`.

Deliberately red family-audit test: not evaluated as acceptance. I did not edit expectations; this pass is an external reading only.
