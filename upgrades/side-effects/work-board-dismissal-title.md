# Side effects: a dismissal lesson keeps the title the person closed (SEC-122)

In plain words: when a person closes a Work Board card as "not important", their reason is shown to the agent next to the card's title, so the agent does not raise the same thing again. Until now that title was the card's current one. A card renamed later therefore showed the person's reason against words they never judged. Now the reason stays with the title the person closed, and the current title is shown beside it if it changed. (Below, "the fold" is the step that rebuilds a card's state from its stored records, in order.)

Tier 1. Size: 4 source files, 6 new unit cases. Effort: one build pass, independent review.

## What changes for running agents
- The Work Board fold records the title each close was about (`CloseoutState.title`). When the closing tap carries the hash of the title on the person's screen (the console sends it), that is the title matching the hash among the titles the card has had. Otherwise it is the fold's title at the tap, and the close is marked `titleUnconfirmed`, as it is when the hash matches no title. Nothing new is stored: it is all derived in the fold.
- The card JSON's `closeout` also carries `title`, so the console and the app can show what was dismissed.
- `dismissalLessons()` returns that title as `title`. When the card has been retitled since, it adds `currentTitle`. `GET /work-board/lessons` and the lessons in a create answer add `cardTitleNow` and `retitledAfterClose: true` only in that case, and `titleUnconfirmed: true` when the close's title could not be confirmed.
- A card that was never retitled reads exactly as before.
- No stored data, config or route changes. Older records fold the same way: the title in force at the tap is derived from the record order.

## Signal vs authority
The lessons are a signal the agent reads before raising a card. This change only stops a person's reason from being shown against a title they never judged. It decides nothing.

## Rollback
Revert the commit.

## Not covered here
- Other card fields edited around the close (the need, the recommendation) are not pinned to it. The lesson shows only the title and the reason.
- A close from a client that sends no title hash uses the fold's title at the tap and says so (`titleUnconfirmed`).

## Second-pass review
**Reviewer:** independent read-only review subagent (fresh context, ran the unit file). It concurred with no blocking findings and showed that the first version still had a race: an edit folded just before the tap became the closed title. Its notes were taken. The tap's title hash now picks the title the person's screen showed, or marks the close unconfirmed. The card JSON carries the closed title, the comments no longer overstate, and tests now cover the race, an unknown hash, and close/reopen/retitle/close.
