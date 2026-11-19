# Needs you: one line per waiting project — Plain-English Overview

## The problem

The owner has one list of things waiting on him, called Needs you. When one of his projects waited on him, that list showed a line like "Instar App is waiting on you", and tapping it opened the project's chat. The Chief of Staff also made a card for the same project on the work board. The card holds what actually needs doing: the checklist and the Confirm done button. The server attached a small "has a card" note to the line, but the dashboard and the iPhone app never showed that note. So Justin saw seven lines in Needs you and seven cards on the board for the same seven projects, and nothing connected them. He asked for one list where each thing appears once.

## What changes

The rule that builds the list now merges each such pair into one line. The line uses the card's title, for example "Instar App looks done and needs your OK", and tapping it opens the card. The project's chat is still one tap away, as a second link on the line. This happens on the server, so the dashboard, the iPhone, the Mac and Android all receive the same list. The iPhone and Android already open any line that points at a card, so they get the main change with no app update.

## The safeguard

Only the Chief of Staff's own cards can take over a line like this. The server writes those cards itself, and no agent session can write one. A card that another agent session writes to cover something else in the list, such as a plan, only adds a link to that line. It never changes the line's words or where its button goes. Otherwise an agent could steer the owner's tap away from the page where that item is approved.

## What stays as it is

Lines with no card keep their own button: plans, promises, and a project whose card was not opened because the board was full. The count counts each thing once, as before. A revert of this change brings back today's behaviour exactly.
