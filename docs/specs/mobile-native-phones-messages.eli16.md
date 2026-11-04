# Phones, messages to you, and insights on the phone — the plain version

## What this is

The Instar iPhone app can already show chats, the "Needs you" list, the schedule, promises, machines, accounts, spending, resource use, plans, what the agent learned about you, and other agents without opening a web page. Three more parts of the web console still needed the console: **Phones** (which phones are paired with the agent, and removing one), **Messages to you** (whether any of the agent's replies to you are stuck and why), and **Insights** (a plain-language read of what stands out on each console page).

This change adds two new read-only answers on the agent's server — `/mobile/messages` and `/mobile/insights` — and lets the owner's phone remove another paired phone. It adds three phone screens under a new "Phones and messages" section on the agent's page. You pull down to refresh.

## What already exists

- The phone could already list the paired phones. It could remove only itself. The console's Phones panel lets the owner remove any phone, without a PIN.
- The console's Messages page reads the message records after you unlock it with your PIN. Without the PIN it shows only how many replies are held.
- The legacy dashboard's Insights tab reads the agent's insight summaries.
- Every phone request is signed by a key that never leaves the phone, and the server accepts signed requests only on a short list of addresses. The same "trimmed answer for the phone" pattern has shipped three times this week.

## What's new

- Two short-list entries, owner's phone only, with their own small rate limit.
- **Messages to you** shows the headline the console shows ("2 replies are held on this machine"), the stuck replies grouped by conversation with the reason in words and how long they have waited, how many expired, whether message recording is fully set up, and how many replies are held on your other machines. It never sends message text, record ids, chat ids or account details.
- **Insights** shows each page's headline, its supporting lines and next steps, and its numbers, from this machine and your other machines that answer. The link into a dashboard tab is dropped.
- **Phones**: the owner's phone can remove another phone paired with the same machine. Removing the phone you are holding needs a clear extra warning, and the app then forgets that agent.

## The safeguards, plainly

- Only the owner's phone (or the agent itself) can read the new answers. A helper's phone, a removed or revoked phone, an unsigned or tampered request, and the notification-only token are refused.
- Only an active owner phone can remove another phone. A helper's phone or a phone still waiting to be confirmed can still remove only itself. Every removal is recorded.
- Shown text goes through the same secret scrubber the other phone screens use and is cut to a fixed length. Insight text is shown as plain text and never treated as an instruction.
- If one part can't be read, it says "can't tell" and the rest still shows; failures are logged.

## What you need to decide

Nothing new. The request (every feature native in the app) is Justin's from 2026-11-03, and his plan names list-and-remove for Phones. The new answers show no more than the owner already sees in the console. Removing a phone from the owner's phone is what the console already allows. To undo it, revert the change: the screens then say "update the agent to see this here", and a phone removed in the meantime can simply be paired again.
