# Work cards from the owner's phone — Plain-English Overview

> The one-line version: the owner's phone can now open one work card directly, and turn a message into a work card with Face ID, the same way the dashboard already does with its PIN.

## The problem in one breath

On the dashboard, any message in a conversation has a "Make a card" button: it fills in a card from the message, asks for the dashboard PIN, and puts the card on the work board with a link back to the message. The phone apps cannot do this yet. They also cannot open a single card by itself; they have to load the whole board and look for it.

## What already exists

- **The work board** — the list of work cards the agent and the owner share. Each card remembers where it came from (which conversation, which message) when it was made from a message.
- **The dashboard's single-card read and "Make a card"** — the dashboard can read one card, and can make a card from a message after the owner types the PIN.
- **Face ID approvals on the phone** — for anything the owner decides from the phone (approving a card, a permission, a switch), the phone asks the agent for a one-time code tied to exactly that action, the owner confirms with Face ID, and the phone signs the code and the action with a key that never leaves the phone's secure chip. The agent cannot produce that signature.

## What this adds

Two things for the owner's phone only:

- **Open one card.** The phone can ask for a single card and gets exactly what the board shows for it. Other people's phones cannot use this, and a card the caller is not allowed to see answers "not found".
- **Make a card from a message.** The phone sends the card (title, what is needed, when it is done, and which message it came from) with a request number it chose. Before anything is written the agent checks that the conversation exists and the owner can see it. Then it checks the Face ID signature covers exactly this card. If the phone sends the same request again (for example after the network dropped the answer), it gets the same card back instead of a second copy.

## The safeguards

**Only the owner, only with Face ID.** Making a card goes through the same gate as every other decision the phone makes: the owner's paired phone, over this machine's secure connection, with a fresh Face ID signature. The agent holds the server password and the dashboard PIN, but not the phone's secure key, so it cannot make a card in the owner's name this way.

**What you saw is what gets saved.** The signature covers a fingerprint of the exact title, text, done list and source message. If any of it changed after Face ID, the signature no longer matches and nothing is saved.

**No duplicates.** The card's identity is worked out from the owner and the request number, so retries, even on another of the agent's machines, end up as one card. Reusing a request number for a different card is refused.

**Nothing new to switch on.** Both routes follow switches that already exist: the work board itself, and phone decisions.

## What ships when

One change: both routes, tests that use real phone signatures, and a short note so the agent knows phones can do this. The phone apps then add the button and the card screen on their side. If it turns out wrong, undoing the change is enough; cards already made stay as ordinary cards the owner wrote.
