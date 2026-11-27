# A release note for the safer agent-removal change

Every change that affects running agents must carry a short release note. Without one, the change merges but never ships to anyone, because the publishing step skips a release that has no note. The push check caught that this change had none.

The note explains the change in plain words. Removing one agent no longer stops another agent whose name starts the same way. When the removal is unclear, it stops before changing anything and says why. Every failure is reported honestly instead of always saying "removed".

The note also tells each agent how to explain this to its user in one sentence, and lists the new option for stopping exactly the sessions that the removal listed as unclear.

What needs deciding: nothing. It is documentation only; it changes nothing that runs.
