# Work Board, phase 1: the plain-English version

## What this is

Today, if your agent needs something from you (a yes, an answer, a sign-off), that need can live in half a dozen places: an approvals page, a plans page, a promise, a note buried in a chat. There is no single place that says "here is everything waiting on you".

This adds one. It is a page called **Work**, and its first lane is **Waiting on you**. Everything on it is a **card**.

## What a card is

A card is a small written agreement about one piece of work:

- what is needed and why,
- what "done" means, as a short checklist,
- who is carrying it (you, a teammate, or the agent),
- who has to act next (that can be a different person),
- the agent's recommendation, links, and a due date.

Each card has its own chat, and that chat is a real Instar conversation. When you type on a card, the agent gets the message straight away, the same as in any conversation. Files and screenshots you add in the chat are the card's files. Nothing is copied between a "card chat" and a "real chat", because they are the same thing.

## The rules the system enforces

These are built into the code, not left to the agent to remember:

1. **Only a person can approve.** The agent can propose a card but can never approve it, and nothing typed in a card's chat counts as an approval. An approval comes from you, proven by your dashboard PIN or by Face ID on your phone.
2. **Approval follows who wrote the card.** If the agent wrote any important part of a card, it waits for your approval before it starts. If you wrote the whole card yourself, that was the instruction, and it starts. Work that sends something outside the team or spends money always needs its own approval.
3. **Your tap covers exactly what you saw.** The approval is tied to the card's wording, checklist, links and the question on screen. If any of that changes afterwards, the approval no longer counts and the card comes back to you. Fixing a typo in a part that does not matter does not ask again.
4. **You can always stop.** Hold, withdraw approval, reopen and archive are never refused, even if the card changed a second ago or another machine is behind.
5. **Nobody types a status.** "Waiting on you", "with the agent" and "done" are worked out from what actually happened, so a card cannot say something that is no longer true, and the agent cannot move a card out of your lane while it still needs you.
6. **A card finishes only with evidence** against every item on its checklist. Items you marked as yours to confirm wait for your tap. If the agent finishes a card on its own evidence, the card says so, and you can reopen it. Once you reopen a card, it needs your sign-off to finish again.
7. **You only see cards you are allowed to see.** A card is visible to exactly the people who can see its conversation, which the team owner controls. The agent cannot share a card, and it cannot archive one.
8. **Approved work does not get lost.** If no session is free when you approve, the card says "waiting for a free session" and keeps checking. If handing it over fails three times, the card comes back to you with the reason and a Try again button.

## What you will notice

- A **Work** page in the dashboard, and the Home count of things that need you now includes cards.
- When the agent needs you, it says so in the card's chat, and that message is the notification. The board sends no extra pings.
- On the phone, the card's chat shows up with your other conversations right away. A proper card screen with Approve buttons is built in the app as part of this phase.

## What is not in this first piece

Scheduled progress reports, cards that block other cards, several boards and groups, cards carried or approved by teammates other than the team owner (they can already see and discuss any card shared with them), handing a card to another agent, and cards a client can see. Those come in later phases, one at a time, and are tracked so they do not get forgotten.

## One choice for you

Should the agent wait for your approval on every card it writes, or only on cards that send something outside the team or spend money? The first is the rule you set on Luna's board and is the default here. The second means fewer taps for you and more trust in the agent. It is a setting you can change at any time, and changing it undoes nothing.

## How it rolls out

It is switched off for everyone at first. It gets proven on a throwaway test agent with an owner, a teammate and a guest, then runs for a week on Echo with real asks, and Luna has offered to run it against copies of her real cards. Only after that week's numbers are in does it turn on more widely. Switching it off again loses nothing: the cards are kept, and their chats stay ordinary conversations.
