# Side effects: a session started without a topic keeps its tmux name when respawned for a topic

## Summary of the change
`chooseTmuxName` (src/core/SessionManager.ts, messages-reach-renamed-sessions §E) treated any session record of a different "role" as holding a tmux name. A record with no topic and no job was compared by topic only, so a session first spawned without a topic and then respawned for a topic (same name) was given a numbered name (`<name>-2`). The respawn then ran under a different tmux name than before; the e2e test `restores a worktree build context on respawn` watched the old name and timed out (failed PRs 3426 at 15:07Z and 3422 at 19:04Z).
Fix: a record with no topic and no job whose stored name (sanitized the same way the spawn paths do) equals this name counts as the same session line, not a competing role. Records with a topic or a job, or with a different stored name, behave exactly as before.

## Decision-point inventory
- chooseTmuxName's same-role rule — modify — one narrow case now counts as the same role.

## 1. Over-block
No block/allow surface. Fewer numbered names are produced; none are newly produced.

## 2. Under-block
A role-less session and a later topic session that deliberately reuse one name now share it. That was today's behaviour before §E (names were always `<project>-<name>`), and a role-less session is not a role that messages are addressed to, so no message can reach the wrong role.

## 3. Level-of-abstraction fit
The fix sits in the one pure function that decides names; no caller changes.

## 4. Signal vs authority compliance
Not a gate. Naming only.

## 5. Interactions
Message routing by topic (§A) uses the topic registry and records with topics; role-less records never carried a topic, so routing is unchanged.

## 6. External surfaces
tmux session names for this one case go back to the pre-§E name.

## 7. Multi-machine posture
Machine-local by design: tmux names are per machine (hardware-bound-resource); unchanged.

## 8. Rollback cost
Revert the commit; names return to the numbered form for this case.

## Tests
tests/unit/messages-reach-renamed-sessions.test.ts: new case (role-less same-name record keeps the name for a topic respawn; a different stored name still yields `-2`). 29/29 with session-name-sanitize. The e2e respawn test is the end-to-end check in the merge line.
