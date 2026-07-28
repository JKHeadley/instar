# Codex task-ledger self-continuation — plain-English overview

Right now, Codex can finish a response while the larger assignment is still unfinished. The files stay safe, but nothing presses “continue,” so the work waits for another message.

Instar already has a trusted end-of-turn hook that keeps autonomous jobs going. This design reuses that hook for ordinary interactive work, but only when the agent has written a real checklist for the current topic.

This directly serves Instar's constitutional principle “The Agent Carries the Loop”: once the user assigns bounded work, the agent—not another user nudge—must carry it through its explicit remaining steps.

At the end of each turn, the hook asks a small local controller: “Does this exact session still own a checklist with an unchecked box?” If yes, the hook asks Codex to take another turn. If the list is empty or fully checked, Codex stops normally. The controller never guesses new tasks from conversation text and never creates busywork.

There are four independent brakes:

1. A configuration switch disables the feature immediately.
2. An operator stop always wins, even if a hook decision is racing at the same moment.
3. Every run has a wall-clock deadline.
4. Every run has a maximum number of continuation turns.

Every decision is recorded without storing the task text. If the audit record cannot be written, the system stops instead of continuing invisibly.

The first rollout is dark by default and enabled only for the development agent. A real Codex test must prove all four important behaviors: it continues an open list, stops on an empty list, obeys an operator stop, and obeys both ceilings.
