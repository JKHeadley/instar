# Side-Effects Review — console chat bubbles show inline markdown as styling

**Version / slug:** `console-chat-markdown`
**Date:** `2026-11-17`
**Author:** `Echo`
**Second-pass reviewer:** `not required (display-only rendering, no decision point)`

## Summary of the change

On the web console's Conversations page, a message bubble put the raw message text into one text node, so an agent's `**Build things.**` showed its asterisks. The iPhone and Android apps were changed today to render inline markdown (Android: `MessageMarkdown.kt`). This change makes the web console match them.

Change: a pure `messagePieces(text)` in `dashboard/console/chats-model.js` that splits text into pieces `{text, bold, italic, code, strike, url}` using the same rules as the Android parser (line breaks and list dashes stay as typed, `my_file_name` is not italic, an unmatched marker stays literal, `***x***` is bold and italic, text without markers is unchanged). A link becomes a link only when its target is `http://` or `https://` (`safeMessageUrl`); any other target (`javascript:`, `data:`, relative) stays as the typed text. `chats.js` builds the bubble body (`messageTextNode`) from text nodes and `strong`/`em`/`s`/`code`/`a` elements only, never `innerHTML`; links open with `target="_blank" rel="noopener noreferrer"`. `.chat-text` keeps `white-space: pre-wrap`; small CSS added for inline code and links.

Tier 1, 5 files (2 source, 1 CSS, 2 test), about 170 lines. One commit attempt planned, no spec review rounds (Tier 1, no spec).

## Decision-point inventory

None. Display rendering only; nothing gates, blocks or filters. The link-scheme check decides only whether a piece of text is clickable, not whether anything is shown or sent.

## 1. Over-block

No issue identified: no text is dropped. A link to a non-web scheme (for example `mailto:`) shows as its typed text rather than a link; that is a deliberate narrow allowlist.

## 2. Under-block

Message text is untrusted. It reaches the page only through `textContent` and `createTextNode`; markup such as `<img onerror>` renders as literal text (tested). Only `http(s)` targets become `href` values, so `javascript:` and `data:` cannot run. Block markdown (headings, tables, fenced code) is not rendered and stays as typed, same as the phone apps.

## 3. Level-of-abstraction fit

Right layer: the pure parser sits in the page's view-model file with its other unit-tested helpers; the page only turns pieces into nodes.

## 4. Signal vs authority compliance

Not applicable: no decision point (see `docs/signal-vs-authority.md`).

## 4b. Judgment-point check

None.

## 5. Interactions

Tests and code that read `.chat-text` `textContent` still see the visible text (markers removed only where they styled something). The conversation list preview, pin bar and pin list are untouched and still show plain text. Sending is untouched: what the person types is sent unchanged.

## 6. External surfaces

Visible to the owner and team members on the console Conversations page. No routes, config or stored data change. Link clicks open a new tab without an opener reference.

## 7. Multi-machine posture

Machine-local by design: pure browser-side rendering of message text the server already sends; nothing replicated.

## 8. Rollback cost

Revert the commit; no state, no migration.

## Conclusion

Small display fix matching the iPhone and Android apps, with untrusted text kept out of HTML. Ship.

## Evidence pointers

- `tests/unit/console-chats-model.test.ts`: no markers unchanged, line breaks and list dashes, bold/italic/code/strike, `***both***`, `my_file_name`, `2 * 3 = 6`, unclosed markers, an https link, `javascript:` and `data:` links staying as typed text.
- `tests/unit/console-chats-page.test.ts`: the shipped page in jsdom renders an agent bubble with `<strong>Build things.</strong>`, no literal `**`, a `code` element, one link with `target=_blank` and `rel=noopener noreferrer`, the `javascript:` link as text, and `<img onerror>` as text with no `img` element.
