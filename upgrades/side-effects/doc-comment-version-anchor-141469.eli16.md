# Comments that stay on their own version, in plain English

Instar Documents is the page where you read a document an agent wrote and leave comments on parts of it, by highlighting some words and typing a note. Documents get new versions as the agent revises them.

The problem Justin hit: he highlighted a passage on version 1 and commented on it. The agent then wrote version 2, where that passage was gone. But the same few words happened to appear in a completely different section of version 2, and the comment jumped there. Worse, the comment card then quoted the new section's text, so it looked as if he had commented on something he never read.

Why it happened: when a new version arrives, the page tries to find each comment's passage again. If the highlighted words appeared exactly once anywhere in the new version, that spot was accepted without checking that it was the same passage. The page also replaced the comment's quote with whatever text it landed on.

What changes:

- A comment belongs to the version it was made on. Reading that version, you see the highlight exactly where it was made, every time.
- On another version, a comment is highlighted only if the same passage is clearly still there: either the edits moved it to exactly that spot, or the words around it still match. The same words somewhere else no longer count.
- The comment card always shows the words you actually highlighted. If the passage was only reworded, a separate "Now reads: …" line shows the new wording.
- When reading a different version, the card says "Made on version 1". If the passage is not in the version you are reading, the card sits under "Not in this version" with a button that opens the version it was made on.
- A small layout fix: on a computer screen, those "Not in this version" cards used to hang off the bottom of the page behind the Send bar. They now sit in the list like any other card.

What does not change: how comments are stored, who can see them, sending comments to the agent, and how you leave a new comment (still on the newest version). Nothing is migrated; the placement is worked out each time the page loads, so old comments benefit immediately.

Nothing to decide: this is a correctness fix for a feature that is still switched on only for development agents. Undoing it is a single revert.
