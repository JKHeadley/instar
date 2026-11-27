# Mobile operator chat — Plain-English Overview

> The one-line version: from the Instar iPhone app you can now reply to any of your agent's conversations, and the agent treats it exactly like a message you typed in Telegram.

## The problem in one breath

The app can show your agents and their conversations, but you can't answer from it. You have to switch to Telegram. The plan also promised an "ask for update" button that opens a conversation with the question ready to send.

## What already exists

- **Phone keys** — each phone you pair has its own key, and it only works after you type the private code the agent sent you. That makes a phone's message provably yours.
- **The message pipeline** — every message you send in Telegram goes through one path: emergency stop, duplicate protection, the checks that watch for approvals, then the agent's session.
- **Conversation history** — the app can already read each topic's messages.

## What this adds

A chat screen in the app. You pick a conversation, read it, and type a reply. Your reply goes through the very same pipeline as a Telegram message, so "stop everything" typed in the app really stops everything, and the agent answers as usual. A copy of your message also appears in the Telegram topic ("📱 Justin (from the app): …") so both places show the whole conversation.

- **Ask for update**: one tap opens the right conversation with "Can you give me a quick update on this?" ready. It never sends by itself.

## The safeguards

**Only your confirmed phone can speak as you.** The agent's own master key cannot send these messages; only a phone you confirmed with your private code can.

**No double messages.** If the app retries after a bad connection, the agent still gets your message once.

**The record says where it came from.** Messages from the app are marked as coming from the app, so nothing mistakes them for something else.

**Easy to switch off.** One setting turns off chat from the app without touching anything else.

## What ships when

The server side and the app's chat screen ship together, right after phone keys.
