# Native app conversations, in plain words

## What this is

The Instar iPhone app can already chat with an agent, but only by borrowing Telegram. Every conversation in the app is really a Telegram topic, the agent's answers travel through Telegram, and the six-digit code that pairs a phone arrives in a private Telegram chat. An agent that has no Telegram set up cannot be reached from the app at all.

Justin asked for two things. First, an agent must not need Telegram: the app should have its own conversations, stored by the agent itself. Second, the app should still let him continue his Telegram and Slack chats, side by side with the app's own ones. A third request came a minute later: messages he sends from the app should carry a signature, kept with the saved message, that proves they came from him and his phone.

## What already exists

- The agent already knows how to give a Slack conversation a permanent number and route its messages to the right working session. App conversations reuse exactly that machinery, with "app" as a new kind of conversation.
- The phone already signs every request with its own private key, which never leaves the phone. Today the agent checks that signature and then throws it away, keeping only a label that says "from the app".
- Push notifications to the phone are built, but they are only switched on when Telegram exists.

## What is new

- The app can start a new conversation, give it a title, and chat in it. The agent answers with a small reply script, like it does for Slack, and the answer lands in the app's history and buzzes the phone.
- One list in the app shows app conversations, Telegram topics and Slack conversations together, newest first, each with a small label saying where it lives.
- Pairing works without Telegram: on an agent with no Telegram, the pairing code appears on the agent's dashboard after Justin unlocks it with his PIN.
- Every saved app message keeps the phone's signature and the exact bytes it signed. Anyone can re-check it later. The phone mark (📱) is shown only when that check passes, and a message with a broken signature is shown with a warning, never quietly trusted.
- A small permanent list of every phone key the agent ever paired. A signature only counts if its key is on that list, so someone cannot forge a message with a key they made up. Unpairing a phone later does not erase the proof on messages it sent before.

## Safeguards

- Nothing changes for Telegram users: the existing chat routes keep working, now with the signature saved too.
- Old saved messages are not rewritten; they simply show no mark.
- The phone can still only reach the short list of routes it is allowed to use, and every request is still signed and time-limited.
- When the agent runs on several machines, each machine keeps the conversations it holds and the app's list combines all of them; a message for a conversation held elsewhere is passed to the right machine.

## What needs deciding

Nothing from Justin. The open design choices (reuse the Slack numbering, show a warning for broken signatures, use the dashboard PIN for Telegram-less pairing) follow standing rules and are recorded in the spec.
