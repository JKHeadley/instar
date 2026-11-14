# Mobile device keys — Plain-English Overview

> The one-line version: each phone gets its own key, which you approve once in Telegram and can take back on its own, instead of holding the agent's master key.

## The problem in one breath

Today the iPhone app holds the agent's master key, which can't be taken back from one phone, and which agents themselves also hold. That means the app can't safely send chat messages "as you": anything with the master key could fake them.

## What already exists

- **Pairing links** — the agent sends a one-time link, the app opens it and gets connected.
- **Telegram buttons only you can press** — the agent already asks for some approvals with buttons that only the owner's tap counts for.
- **The conversation pipe** — every Telegram message from you goes through one path into the agent's session; the app can reuse it.

## What this adds

When you pair a phone, the phone makes its own key inside its security chip, a key that can never leave the phone. The agent then sends you a 6-digit code in your private Telegram chat, and you type it into the Instar app. From then on the phone signs everything it sends with its key. The master key never goes to the phone.

- **Revoke one phone**: take back one phone's access without signing out anything else.
- **Groundwork for chat**: because only your approved phone can sign, a later change can let the app send chat messages that the agent knows are really from you.

## The safeguards

**An agent can't make itself a phone.** An agent could make a pairing code, but the new phone stays unusable until someone types in the code that only goes to your private Telegram chat. No part of the agent can read that code back, and a surprise code does nothing unless you type it into a phone.

**A stolen request can't be replayed.** Each signed request carries the time, and the agent remembers recent signatures, so copying a request and sending it again fails.

**Losing a phone is fixable.** Revoke it (or ask the agent to) and it stops working at once.

**Easy to switch off.** One setting turns off all phone access.

## What ships when

The agent side and the matching TestFlight update ship together, because pairing changes shape: the app stops receiving the master key and uses its own key instead. Pairing links and phone keys ship in the same release, so no phone ever receives the master key through pairing. Chat in the app is the next, separate change.
