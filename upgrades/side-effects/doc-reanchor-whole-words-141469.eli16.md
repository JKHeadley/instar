# Reworded passages show whole words, in plain English

Instar Documents is the page where you read a document your agent wrote and comment on parts of it, by highlighting some words and typing a note. When the agent writes a new version, the page looks for each comment's passage again. If the passage was reworded rather than removed, the comment card shows the new wording on a line that starts "Now reads:".

The problem: that search scores candidate text by how few letters have to change. When the agent changed "first business day of each month" to "second business day of each month", the cheapest match was "econd business day of each month", without the first letter. Dropping the "s" costs fewer letter changes than keeping it, so the card showed a word cut in half. The end-to-end browser test caught it today.

What changes: when the words you highlighted started at the beginning of a word, the new match is widened back to the beginning of the word it landed in. The same goes for the end. If you highlighted from the middle of a word, nothing is widened, because your selection never started on a word edge. The widening is capped at 64 characters, and the same inputs always give the same result, so every machine shows the comment in the same place.

The test script for the end-to-end proof is also brought up to date. Two changes from last week (a phone opens the app instead of showing a code to scan, and the "Not in this version" heading) had made 8 of its checks fail even though the page was right. It also gains a check that a real touchscreen phone is offered the app and is never sent a link code.

What does not change: how comments are stored, who can see them, sending, sharing, or anything outside documents. Documents are still switched on only for development agents. Undoing this is a single revert.

Nothing to decide.
