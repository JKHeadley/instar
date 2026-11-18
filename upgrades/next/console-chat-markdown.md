# Console chat bubbles show inline markdown as styling

<!-- bump: patch -->

## What Changed

On the dashboard's Conversations page, a message's inline markdown now shows as styling instead of raw symbols: `**bold**`, `*italic*`, `` `code` ``, `~~strike~~` and `[text](https://...)` links. Line breaks, list dashes and unmatched marks stay as typed, and `my_file_name` keeps its underscores. Only http and https links become clickable (opening in a new tab); anything else stays as typed text. Message text is never turned into HTML. This matches the iPhone and Android apps.

## What to Tell Your User

- **Formatted messages on the dashboard**: "Messages in the dashboard's Conversations page now show bold, italic, code and links properly instead of stars and brackets, the same as the phone apps."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Bold, italic, code, strike and web links rendered in dashboard chat bubbles | Automatic |

## Evidence

Tests: `tests/unit/console-chats-model.test.ts` (no markers unchanged, line breaks, bold/italic/code/strike, `***both***`, `my_file_name`, unmatched markers, https link, `javascript:` and `data:` links stay as text) and `tests/unit/console-chats-page.test.ts` (the shipped page in jsdom renders `<strong>` with no literal `**`, a code element, one safe link with `rel=noopener noreferrer`, and `<img onerror>` as text). 59 tests passed across the two files.
