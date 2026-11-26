# Mobile pairing link — Plain-English Overview

> The one-line version: instead of typing an address and a PIN into the Instar iPhone app, the operator taps a one-time link the agent sends them, and the app adds that agent.

## The problem in one breath

The Instar iPhone app can show every agent the operator runs, but adding an agent means finding its dashboard address and typing its 6-digit PIN, on every phone, for every agent. That is fiddly on a phone and it is the first thing every new user hits.

## What already exists

- **The dashboard PIN** — typing it into the dashboard (or the app) gets back the agent's access key, which is what the app uses from then on. The agent limits how many wrong PINs anyone can try.
- **The agent's secure web address (tunnel)** — the HTTPS address the dashboard and the app already use to reach the agent from anywhere.
- **The iPhone app** — keeps each agent's access key in the phone's keychain and talks to each agent directly. There is no central server in between.

## What this adds

The agent can now mint a **one-time pairing link**. The operator asks "add yourself to my phone", the agent sends a link in Telegram, the operator taps it, the iPhone app opens, and the agent appears in the app. Tapping the link does what typing the PIN did, with nothing to type.

- A small page on instar.sh for when the link is opened somewhere other than the phone: it shows a QR code so the phone can scan it.
- A simple list of which phones have paired, so the operator can see them.

## The new pieces

- **Pairing codes** — random, used once, gone after ten minutes, and wiped if the agent restarts. Only something that already holds the agent's access key (the agent itself, or a signed-in dashboard) can make one. A code buys the app's access key and nothing more: it can never stand in for the PIN on the actions that need proof a person is there (approvals, money, remote desktop).
- **The link lives on instar.sh** — the iPhone treats instar.sh/pair links as belonging to the Instar app only, so no other app can catch them. Everything secret rides in the part of the link after the "#", which browsers never send to any server. Opened on a laptop, the same page shows a QR code for the phone's camera.
- **A permanent address is required** — the phone remembers the agent's address, so pairing refuses to start on a temporary address that changes at every restart, and the agent offers to set up a permanent one.
- **The paired-phones list** — a record for the operator to read. It does not grant or block anything.

## The safeguards

**Prevents guessing, without new lockouts.** The codes are far too long to guess. Wrong codes have their own limit, kept apart from the PIN's, so someone sending bad codes can never lock the operator out of their PIN.

**Prevents reuse and lingering links.** A code works once. An old link in Telegram history is dead after ten minutes or after it is used, whichever comes first.

**Prevents leaks over insecure connections.** A code is only accepted over the secure address or from the machine itself, always (stricter than the PIN today).

**Easy to switch off.** One setting turns all of it off; nothing stored needs cleaning up.

## What is not in this change

Taking away one specific phone's access needs a separate per-phone key, a bigger change to how the agent checks access, and today there is no button to change the agent's access key at all. So this ships only on development agents (Justin's own), and turning it on for everyone waits for the per-phone keys, which are the next piece of work.

## What ships when

The agent side (codes, page, list) ships first in instar. The iPhone app gets the matching "open the link" handling and a QR scanner in its next TestFlight build.
