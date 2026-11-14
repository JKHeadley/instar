# Your agent offers the outside services that would help it, once, without being asked

## What this is

An agent benefits from a few outside services: a private address (Tailscale), a password vault (Bitwarden), a private backup of itself (GitHub), a fast second opinion for small judgments (Jev). Until now each of these could only be set up if you knew to ask for it. This change makes the agent offer them to you itself: one short message, once, after it has delivered its first real result to you. Each row says what you get, what leaves your machine and to whom, what it costs, whose account it needs, and what the agent falls back on if you say no. Nothing happens until you say yes.

## How you answer

- **Yes:** the same page you use today, with your PIN. The message carries the link. The one exception is an address service when the agent has no address yet (there is no page to open), so Tailscale gets a Yes button that only the owner can press.
- **No:** a button under the message. A no is final: the agent will not ask again unless there is a real reason, and it will say what the reason is.
- **Nothing:** that is fine. The list stays on the agent's dashboard, marked "Offered, not answered", and the agent does not send it again.

## What keeps it polite and honest

- **Sent once.** The agent writes each offer down as "pending" before sending and as "offered" only once Telegram confirms the message. An offer that never reached you is sent again later; one that did is not repeated. A crash or a move to another machine at exactly the wrong moment can repeat a list at worst once.
- **At most one list a week.** A service that becomes available later joins the next list, not a fresh message.
- **Already in use is not offered.** If a service is already working on the machine (you set it up yourself), the agent notes that and leaves it out. That note is a fact about the machine, never a choice on your behalf.
- **A kill switch.** The whole thing is off unless the switch is on. Turning it on later never resends offers that already went out.
- **Who can press what.** Anyone in the conversation can press No (less action, undoable on the page), at most ten times an hour. Only the owner can press a Yes button, and only for an address service.
- **Existing agents are not included yet.** This list goes to new agents first; agents that already exist get theirs in a later step, after their old answers are carried over.

## What you need to decide

Whether the switch goes on for your agent. It ships off. It was proven on a test agent first; the development agent is next; then new agents everywhere.
