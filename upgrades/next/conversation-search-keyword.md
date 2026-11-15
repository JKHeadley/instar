## What Changed
- **Keyword search over conversations.** `GET /mobile/conversations/search?q=<words>` finds messages in every conversation the caller can list (app conversations, Telegram topics, Slack), best match first. Add `ref=app:<uuid>`, `telegram:<topicId>` or `slack:<machine>:<id>` to search inside one conversation, and `scope=pool` to ask the agent's other machines too. Each hit carries the conversation `ref`, the `messageId` the history read uses (so the app can jump to it), the time, who sent it, and a ~160-character `snippet` with `marks` for the matched words.
- **Same visibility as the list.** A team member only gets hits from conversations shared with them and messages they may read; Slack stays owner-only. A conversation the caller cannot see answers 404 like a missing one.
- **Honest about gaps.** A machine that did not answer is named in `failedMachines`, and `partial: true` is set; a scan that stopped at its bound sets `capped`.
- **Off switch:** `mobilePairing.native.search.enabled: false` (503 `search-off`). Only `mode=keyword` for now; meaning search comes next.

## What to Tell Your User
Your conversations can now be searched by keyword from the app and the dashboard once their search screens arrive: type a few words and I find the messages that contain them, across all your conversations or inside one, and jump you straight to each one. Searching by meaning is coming next.

## Summary of New Capabilities
- Keyword search across all conversations or within one, on this machine or every machine.

## Evidence
- `tests/unit/conversation-search.test.ts`: query words, the FTS query, the word matcher, highlight spans, snippets and marks in UTF-16 indices with non-ASCII text, the index query, the ref and message id per channel, visibility, peer hits, order, off switch.
- `tests/integration/conversation-search.test.ts`: the real auth middleware, device allowlist and team log: owner hits in all three channels, a member never sees an unshared conversation, `ref=`, errors, the off switch, a pool read with a dark peer.
