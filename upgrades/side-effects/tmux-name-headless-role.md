# Side effects: headless spawns name their tmux session by their own job/topic

## Summary of the change
`spawnSession` (headless) asked `tmuxNameFor` for a name with an empty role (`plannedTmuxSessionName(options.name)`), while its session record carries `jobSlug` (and possibly `topicId`). A relaunch of the same job under the same name therefore saw the earlier record as a DIFFERENT role and got a numbered name (`<name>-2`). Found by tests/unit/session-manager-threadline-mcp-spawn.test.ts (PR 3426 run 21:24Z). Fix: `plannedTmuxSessionName(name, role = {})` and `spawnSession` passes `{ jobSlug, topicId }` from its own options. Callers that only predict a name (feedback executor) still pass no role and spawn with no job/topic, so prediction and spawn still match.

## Decision-point inventory
- tmux name role for headless spawns — modify (role now supplied).

## 1. Over-block
None; fewer numbered names.
## 2. Under-block
A headless job relaunched under the same name now reuses the name, which was the behaviour before §E.
## 3. Level-of-abstraction fit
One call site plus an optional parameter.
## 4. Signal vs authority compliance
Not a gate.
## 5. Interactions
Feedback executor name prediction unchanged (no role either side).
## 6. External surfaces
None beyond tmux names.
## 7. Multi-machine posture
Machine-local tmux names (hardware-bound-resource); unchanged.
## 8. Rollback cost
Revert the commit.

## Tests
Sweep of every unit file that mentions new-session / spawnSession / spawnInteractiveSession / spawnTriageSession / plannedTmuxSessionName / chooseTmuxName on the merge with main: 92 files, 19 runs of 5, 2,244 tests passed, 0 failed (incl. session-manager-threadline-mcp-spawn). tsc clean.
