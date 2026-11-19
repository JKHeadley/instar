# Imported chat titles and project instructions reach the agent only as quoted history

<!-- bump: patch -->

## What Changed

Imported history (Claude and ChatGPT exports) was already shown to the agent as quoted history, information and not instructions, but only for message text. Other text from the same export reached the agent as plain fields. The agent's view of the imported-history routes now carries every export-written field (chat titles, project names, instructions and file names, remembered facts in a preview) only inside the same quoted wrapper. Counts, times and Instar's own summary stay plain. The owner's view is unchanged.

## What to Tell Your User

- **Imported chats stay quoted**: "When I read the chats you brought over from another app, everything in them, including titles and project instructions, now reaches me as quoted history, so nothing in an old export can act like an instruction to me."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Quoted titles, project text and remembered facts for the agent | Automatic |

## Evidence

- `tests/unit/imported-history-agent-view.test.ts`: titles, project name, instructions, file names and remembered facts appear only inside one wrapper that cannot be closed early; refs of an unexpected shape are withheld; counts and the summary stay plain.
- `tests/integration/imported-history-routes.test.ts`: the agent's list, chat and search views carry no plain title; the owner's list still does.
