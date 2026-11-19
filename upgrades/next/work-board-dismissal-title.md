# A "not important" reason stays with the title the person closed

<!-- bump: patch -->

## What Changed

SEC-122. A Work Board dismissal lesson paired the person's "not important" reason with the card's current title. A card retitled after the close therefore showed the reason against text the person never judged. The fold now keeps the title each close was about (`CloseoutState.title`). That is the title matching the hash the person's screen sent with the tap, or the fold's title at the tap when no hash was sent. A missing hash, or one that matches no title, marks the close `titleUnconfirmed`. Lessons report the closed title, and add the current one (`cardTitleNow`, `retitledAfterClose`) when it changed. The card JSON's close-out carries the closed title too.

## What to Tell Your User

- **Your "not important" reasons stay accurate**: "When you close a card as not important, I keep your reason with the title you actually saw, even if the card is renamed later."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Dismissal lessons keep the closed title | Automatic |

## Evidence

- `tests/unit/work-card-closeout.test.ts`:
  - A card retitled after its dismissal keeps the closed title on its lesson, with the new title beside it.
  - A card that was not retitled has no current-title field.
  - An edit landing before the tap does not take over: the screen's title wins.
  - An unknown hash is marked unconfirmed.
  - Close, reopen, retitle, close again: the lesson carries the second close's title.
