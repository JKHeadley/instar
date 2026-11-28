# Which rules belong in "The Substrate" — a recorded reading and an admission check

## What this is about

The rules registry groups its rules into families. One family, "The Substrate", is meant only for truths about the AI model itself. These are things you cannot see by reading the code, like "an insight not written down now is lost, because the next instance won't have the context". Since 8 August the family has had an admission rule. An article belongs there only if it passes three tests:
1. It is about the model, not the software.
2. It looks the same from outside whether or not the agent holds it.
3. A good engineer could not work it out by reading the code.

Two things were missing, and the registry said so. Nobody had ever checked the members against those tests. And nothing stopped a new article that fails them from being filed in the family. That gap carries a deadline of 21 December, and when it passes, every commit in the project stops.

## What changes

- **The reading.** An independent reviewer judged every one of the 27 articles in the family against all three tests, quoting the text as evidence. The result is recorded in `docs/audits/substrate-membership-sweep-2026-11-27.md`: 9 pass all three, 13 fail at least one (most are engineering habits, and would fit the "Building" family better), and 5 are borderline. **Nothing is moved.** Moving an article out of the family is Justin's decision, as it was in August. The 13 go to him as one decision later.
- **The check.** A new check on every commit fails if an article filed in this family has no "Admission" line saying how it passes test 1, test 2 and test 3. The 27 articles already read sit on a list that can only shrink.
- **Not in this change: the registry text.** Marking the deadline met, and correcting the family's article count from 26 to 27 (one joined on 22 August and the number was never updated), go into one later registry change, together with the other December closures, so that Justin approves them once.

## What it cannot see

Whether an article's stated reasons are true. Judging that is a reading, not a pattern match, so it stays with human and family review. The check makes sure the claim is written down where a reviewer will see it.
