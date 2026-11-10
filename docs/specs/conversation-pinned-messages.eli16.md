# Pinned messages in conversations — Plain-English Overview

> The one-line version: you can pin as many messages as you like in any conversation the app or dashboard shows, the pins sit in a bar at the top like Telegram, they are the same on every machine, and in Telegram they really pin there too.

## The problem in one breath

In Telegram you can pin important messages so they stay at the top of a topic. The Instar app and the dashboard's Conversations page show app conversations, Telegram topics and Slack conversations, but none of them can pin anything. Justin asked for multiple pinned messages, like Telegram.

## What already exists

- **The conversation store** — every app conversation (and the parts of Telegram and Slack conversations that came from the app) is kept as a list of small, never-changed records, copied to every machine of the agent.
- **One access check** — the same rule already decides who may read a conversation and who may write in it, for the owner's phone, other people's phones and dashboard browsers.
- **History reads** — the app and the dashboard already ask for a conversation's messages every few seconds.
- **Telegram and Slack both have pin buttons of their own**, which a bot can press if it has the right permission.

## What this adds

A pin is a new kind of small record in the conversation store: "this message is pinned (or unpinned), by this person, at this time". Because the store is already copied to every machine, the pins are too, and every machine works out the same list: the latest pin-or-unpin for each message wins, newest pin first. Up to 100 pins per conversation.

- **New buttons in the dashboard**: a bar under the conversation title showing the newest pin ("1 of 3" when there are several). Tapping it jumps to that message and then steps to the next pin. An "All pins" list shows every pin with who pinned it, and each message gets a small menu with Pin and Unpin.
- **New routes the iPhone app can use** to list, pin and unpin, and the pins also come back with every history read, so a pin made on another phone shows up on its own.
- **Telegram**: pinning in the app also pins in the Telegram topic, quietly (no notification). A pin someone makes inside Telegram shows up in the app.
- **Slack**: pinning in the app also pins in Slack when the agent's Slack app has the pins permission.

## The safeguards

**Only people who may write in a conversation can change its pins.** Pinning counts as using the conversation, exactly like sending a message. A guest or someone with read-only access sees the pins but cannot change them. A message someone is not allowed to read never shows up in their pin list.

**A pin never gets lost because Telegram or Slack said no.** If the bot is not allowed to pin there, the pin is still kept in Instar and the app says plainly that it did not pin in Telegram or Slack.

**Retries never pin twice.** Every pin request carries an id, so a repeated tap or a resent request is recognised.

**It can be switched off instantly** with one setting, and an older version just ignores the pin records.

## Honest limits

- Telegram does not tell a bot when someone unpins a message, and a bot cannot list a topic's pins. So an unpin done inside Telegram is not seen; unpin it in the app instead (that unpins in Telegram too). Pins made in Telegram before this update are not imported.
- Pins made inside Slack are not read back.
- Messages typed in the app and sent into Telegram or Slack can be pinned in Instar, but not on Telegram or Slack themselves, because Instar does not have a platform message to pin for them.
- A machine still on an older version does not keep pins made before it updates; the other machines keep them.
- Pins by an anonymous Telegram admin are not recorded, because Telegram hides who they are.

## What ships when

Everything on the server side in one change: the store records, the routes for the app, the dashboard bar and menu, the Telegram and Slack mirroring, and the agent's own awareness of the feature. The iPhone app's own pin bar is built in the app against the routes described in the spec; that work is reported in the operator's topic 134088.

## What you actually need to decide

Nothing beyond the request: this builds what Justin asked for. The one judgement call is that pinning follows the "may send" rule rather than a new permission, so anyone who can write in a conversation can also pin in it.

**Note after rebasing (2026-11-10):** another change that landed first lets the Chief of Staff pin its own greeting in Telegram, and it used the same internal name this change used for pinning a message. This change's version was renamed so both work side by side. Nothing you see changes: pinning a message still pins it in the app, the dashboard and the Telegram topic, and the Chief of Staff greeting pin keeps working as it did.
