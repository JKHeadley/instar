# The work board card, made easy to read (ELI16)

## What was wrong

When the Chief of Staff (the part of the agent that watches projects) needs Justin to decide something, it puts a card on the work board. Opening that card showed one long block of grey text: a goal with odd backslashes in it, a checklist written as plain dashes ending in ": not known", a quote buried in the middle, a timestamp in UTC with an internal id after it, then the recommendation and the buttons at the very end. The board itself listed each card as a title over three grey lines and two identical outline buttons. Justin said it plainly: "The UI is pretty terrible."

## What changed

The opened card now reads top to bottom the way a person decides:

1. Who it is from and how long it has waited, as two small chips ("From the Chief of Staff", "Waiting on you · since yesterday 2:15 PM").
2. The title in large type, and under it, in one sentence, what is being asked.
3. Why it is you, as a quiet line.
4. The recommendation in a highlighted box, with the main button right under it: Done is filled, Not important is outlined, and Put on hold and Remove for good are small text links.
5. The checklist with a coloured mark per item: a tick for passes, an amber dot for needs you, an empty circle for not known yet, a cross for fails.
6. The goal, the Chief of Staff's own words and the full record, folded under Details.
7. The conversation as a real chat on the right on a wide screen (below on a phone), with a link to reply in the full conversation.

The board's cards are now a status chip, the title, the ask in one line, how long it has waited, and one main button.

## Where the words come from

The server is starting to send each card's ask, goal and checklist as separate fields. Until it does, the page reads them out of today's card text with a small tested function, so it works on every card now. Cards written by other parts of the agent keep their text as it is.

## What did not change

What every button does, the confirm step, the PIN, and the server's checks. Nothing is stored differently. Undoing it is a revert.
