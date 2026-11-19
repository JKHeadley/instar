# Work Board cards actually appear (plain-English overview)

## What is wrong today

Echo has a Work Board: a page on the dashboard and the phone where each thing the agent needs from Justin is a card, with what is needed, a recommendation, a checklist for "done", and buttons. It is switched on, and it has never held a single card. Every time a session needs Justin, it asks in Telegram instead. The Chief of Staff, which tracks Echo's projects, already knows that seven projects are waiting on Justin right now, but it only says so in its own daily note and in the "Needs you" list. So the board's "Waiting on you" lane is empty while "Needs you" is full.

## What changes

1. **The Chief of Staff opens a card for each project that waits on Justin.** One card per project. It says what the last check saw, the project's goal and checklist, a recommendation (for example "reply in the project's conversation with your decision"), and why it needs Justin and not the agent. When the wait goes away, because Justin answered, confirmed the project done or paused it, the next check notices and the card closes itself, saying which check showed it. If the check cannot tell, the card stays. If the project waits again later, the same card opens again.

2. **Sessions write a card instead of a chat question** when they need Justin's decision or sign-off on work. Every card the agent writes must now carry a recommendation and a "why you" line, or the board refuses it. This is the rule Luna uses on her board. A card that asks Justin to do something can only be finished by his own "Confirm done", so the agent can never open and close an ask he never saw.

3. **Cards that only ask Justin to act no longer need an Approve tap first.** Approve exists so the agent cannot start work Justin has not agreed to. A card where Justin is the one who acts, and nothing goes outside the team, has no agent work to approve, so making him approve a request to himself was a wasted tap. If the agent later takes the card over, approval is needed again. Cards that send something outside the team or spend money still always need Approve. This is the smallest part of the approval rule Justin already chose ("C").

4. **Each need shows once.** A card can say which "Needs you" item it is about (a waiting project, a plan, or a pull request; nothing about passwords, permissions, money, health or promises). "Needs you" then shows that item in its own words and with its own button, plus a link to its card. For the Chief of Staff's own cards the card is not listed a second time; a card a session wrote keeps its own line too, so an agent can never make an ask harder to see. Promises, permissions, passwords, plans and project sign-offs keep their own pages and their own approve buttons; they are never turned into cards.

5. **A wait card's detail is readable (amended 2026-11-18).** The card's text no longer shows backslashes before brackets, a "(wait c5c23e80)" code, or a raw "2026-11-17 22:15:31 UTC" time, and a checklist line no longer reads "item.: not known". Each card also carries a structured `brief`: one plain sentence of what Justin is being asked, the goal, each done-when item with its state, the Chief of Staff's own words, and when the wait started (as a time the app formats in his own zone). The apps can lay the card out from those fields; older apps keep reading the text. The brief changes no approval and reopens nothing.

## What it does not change

Only Justin's own tap approves anything. A card never finishes or pauses a project. No new messages are sent: cards do not notify on their own, so nothing new arrives at night. The daily limit on agent cards and the soft limit on how many cards wait at once still apply; when the soft limit is reached, the Chief of Staff's own line in "Needs you" still shows the wait.

## What Echo would see today

Seven cards in the board's "Waiting on you" lane, one per waiting project. "Needs you" still shows the seven project lines once each, now each linked to its card, not fourteen lines. The apps should show the new "why you" line under the recommendation.

## Risks and how they are handled

A machine on an older version shows these cards without the new lines, may show a need twice, and may show them asking for Approve, until it updates. If the Chief of Staff's history is incomplete, a card is never closed just because a project is missing from what it read. If two machines briefly both think they run the Chief of Staff, the one whose information is older writes nothing. The cards can be switched off on their own with one setting, which is the way to roll them back.

## Change approved on 2026-11-18: one line per waiting project

Justin asked for Needs you to be the one list, with each thing in it once. A project's line and its Chief of Staff card are now merged into a single line. The line uses the card's title ("… looks done and needs your OK"), tapping it opens the card, and the project's conversation is linked under it. Only the Chief of Staff's own cards can do this, because only the server writes them. A card that an agent session writes still only adds a link to a plan or pull-request line. It never changes that line's words or where its button goes.
