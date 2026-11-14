# A switched-off feature gets an owner and a review date, in plain words

Instar features start switched off and climb a ladder (test agent, then development agent, then everyone) before they go live. What kept going wrong was that the review that should move a feature up had no owner and no date, so features stayed off for months. The tools built to notice that were switched off too.

This change adds clause (h) to the constitution's Maturation Path article. The next rung of a feature's ladder names an owner and a review-due date when the feature ships, and each later rung gets them when the rung below it is reached, written on the feature's ladder entry. A reminder can also come back as a message, but the ladder entry is the record. A rung waiting for review is a promise put off: it gets closed with evidence, moved to a new date with a reason, or taken to the operator, and it never just lapses. And before a rung's clock starts on the agent running the trial, the tools that notice a stalled feature have to be shown to work, using a check whose answer is already known.

Nothing checks either half yet, and the article says so. The owner-and-date half shares an existing deadline. The tools-awake half has its own. Both deadlines are 21 December 2026, and if either passes with nothing built, builds start failing.
