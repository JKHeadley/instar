<!-- bump: patch -->
## What Changed

Placement Step 2. On development agents (`multiMachine.placement.agentSessions.topicBound`), work the agent starts for a conversation can now start on a less-loaded machine in its pool, like a person's new conversation already does.

**When it applies.** All of these must hold:
- the request asks for `placement: "auto"` with a topic;
- nobody is running that topic yet;
- this machine holds the pool lease and is busy;
- a peer with room advertises that it understands the hand-over.

**How it works.** The task description is copied to every pool machine first. It then travels to the peer as that conversation's first message. The peer starts it as a fresh agent task, not as something a person said. If the outcome is unclear, the conversation stays claimed and a person is told; the work is never started twice.

**With the setting on, no second copy.** Every request to start work in a conversation another machine is already running is refused with a clear answer naming that machine.

## What to Tell Your User

Nothing yet: this runs only on development agents for now. When it reaches everyone, a busy computer will hand the agent's own longer tasks to a less busy one automatically.

## Summary of New Capabilities

- Agent-started conversation work can be placed on a less-loaded pool machine (development agents only).
- Task descriptions for placed work are replicated to every pool machine.
- With the setting on, no topic-bound spawn starts a second session in a conversation another machine owns.

## Evidence

- `tests/unit/topic-spawn-placement.test.ts`: 40 pass. It covers both sides of every eligibility rule, the 409, refused or oversize brief emits, the fallback claim, and the authorship check.
- Existing placement, journal, ladder, dev-gate and wiring suites pass.
- Integration and e2e cases are added for Local Verify.
