# Message origin on every platform — plain-English overview

## What this is

Every message the agent sends you should say where it came from: which of your machines wrote it, which "door" (Claude Code, Codex, and so on) the agent was running through, and which AI model produced the words. Justin asked for three things on 2026-11-03: show it by default, let him hide it (in the app or just by asking the agent), and ALWAYS record it for every message on every platform, even when it is hidden.

## What already exists

On Telegram this is already done. Before any Telegram message leaves, Instar writes a signed record of its machine, door and model, and refuses to send if it cannot write that record. A small footer shows it in the Telegram message, and a setting hides the footer.

## What is new

1. **App conversations** (the Instar iPhone app's own chats): each reply the agent writes is now stored together with its origin, in the same write, so a reply can never be saved without it. That record travels to your other machines with the conversation.
2. **Slack**: every message the agent's Slack connection posts, edits or uploads first writes a small origin record on the machine. If that record cannot be written, the message is not sent (the same rule Telegram follows), whether it is the agent's own reply or a server notice. So that you are never left with silence, a few copies of one short notice ("a message was not sent because I could not record where it came from; ask me again") are recorded ahead of time, and one of them is sent into the conversation instead. The agent's own Slack replies also get a one-line origin footer in Slack, like Telegram's, under the same on/off setting.
3. **The phone**: when the app reads history for an app conversation, a Slack conversation or a Telegram topic, each agent message now comes with an `origin` block: machine name, door, model, how each was known, and whether the agent's setting currently says to show it.

## How the agent knows the door and model

The reply routes already check a signed token that proves which conversation, and which session, a reply belongs to. The agent's sessions also carry a private credential that the Telegram system uses to read which model the session is really running; the app and Slack reply scripts now pass it too, and it is only accepted when it belongs to that same session. When the agent has no Telegram, that credential system is not running, so the server falls back to its own record of how it started that session, and marks the answer "configured" (what it was started with) rather than "observed" (what was actually seen running). If neither is available, it says "unknown". It never guesses, and it never takes a session name from the request.

## The setting

It stays on by default. The agent-wide switch is the same one that already exists for Telegram; an agent with no Telegram gets the same four switches at the top of its config. Telegram topics can still be overridden one by one; app and Slack conversations follow the agent-wide switch, so asking the agent to hide it there hides it everywhere. The app can also hide it on one phone without asking the server (that hides it only on that phone, not the Telegram or Slack footers). Hiding it never stops the recording. Nothing shows on the phone until the app itself is updated to read the new data; that app work is tracked as ACT-179.

## Safeguards

- Nothing secret is sent to the phone: no tokens, session ids, file paths or hostnames, only a machine's display name, the door, the model and a status word.
- Records that come back from disk or from another machine are checked field by field; a malformed one is treated as missing.
- Older messages, and messages from a machine that did not answer, say plainly "not recorded" instead of inventing an answer.

## What you would need to decide

Nothing beyond the request itself. Two things to know: WhatsApp and iMessage are not covered by this change (they are tracked as their own item, ACT-023), and the constitution's rule still names only Telegram; the spec proposes the wording that would make it every platform, which is Justin's to approve.
