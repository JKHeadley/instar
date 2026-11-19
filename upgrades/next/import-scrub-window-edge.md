# A secret at the edge of a very long imported message is still removed

<!-- bump: patch -->

## What Changed

Imported Claude and ChatGPT messages longer than the secret scrub's proven bound (1,000,000 characters) were scrubbed in pieces cut at whitespace. Secret shapes that include whitespace, or a long run with no whitespace near the cut, could be split so that neither piece matched. Long messages are now scanned in overlapping windows with every match kept in whole-text coordinates, and a match that reaches a window's edge is removed through to the next whitespace. Messages up to 1,000,000 characters are scrubbed exactly as before.

## What to Tell Your User

- **Safer import of very long chats**: "When I bring in your old chats, passwords and keys are removed before anything is saved. That now also works when one sits right where a very long message is split for checking."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Overlapping-window secret scrub for very long imported messages | Automatic |

## Evidence

- `tests/unit/import-claude-chatgpt.test.ts` ("a secret at a scrub window edge is removed whole"): labelled pairs, a known-prefix key in a long unbroken run, a token starting well before the edge, a labelled value longer than the overlap, a run longer than a whole window, and a secret inside the overlap counted once. Four of these failed on the previous code.
