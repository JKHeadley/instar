# Side-Effects Review — Team access for one-machine agents (step 2a)

**Version / slug:** `team-2a`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `required before the PR opens`

## Summary of the change

Builds step 2a of docs/specs/team-roles-and-access.md §4.1 in pieces, with the invite route last, so team access cannot be turned on until every guard exists. So far: the role map, event validators, the signed access log and confined list, the `team` phone role, route tiers, and the conversation check by operation. No team phone can exist yet, so owner and `msp` behaviour is unchanged.

## Decision-point inventory

`mayDoAsTeam`, the fold's standing check, and the confined list: invariant, per the spec's decision table.

## 1. Over-block

None in this piece: nothing is wired.

## 2. Under-block

None in this piece.

## 3. Level-of-abstraction fit

A pure role map in `src/permissions`, the store in `src/core`, beside the other signed stores.

## 4. Signal vs authority compliance

Authorization is deterministic by design, per the spec. No brittle check holds judgment authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

Invariants, classified in the spec.

## 5. Interactions

None yet.

## 6. External surfaces

None yet.

## 6b. Operator-surface quality

None yet.

## 7. Multi-machine posture (Cross-Machine Coherence)

2a is one machine by decision (spec §4.1). The row format is built for 2b's replication.

## 8. Rollback cost

A plain revert: nothing reads these files yet.

## Class-Closure Declaration (display-only mirror)

No self-triggered action in this piece.

## Second-pass review

Pending, before the PR opens.

## Conclusion

Foundation only.

- Added: confined list reader, per-topic reply guard, spawn refusal, intercept skip, scoped stop, confined inbox for app context and files, stored speaker names.

- Added: Team routes: owner-only invites, grants and people changes store the phone's signed request; the agent token can only lower; attention and session filters, join refusal, conversation lock and reshape are in.

- Added: Tests: status table across all allowlist routes, route tests with both sides of each role check, full journey on a real AgentServer. Added team access awareness to the template and migrator, and the scheduled-jobs disclosure to the invite and first-use answers.

- Added: Live run on a test agent found Activity showing 'Someone was removed' after a removal; names now come from the log.

- Added: Spec wording: attention filtering reads contextTopicIds only; the journey test now checks the history by name.

- Added: Spec wording: attention filtering reads contextTopicIds only; the journey test now checks the history by name.

## Independent code review, 2026-11-06
Nine findings, all confirmed by reading the code, all fixed: non-digit topic paths reached any topic (gate matched fewer paths than the allow rule; now both the gate and the handler check); the conversation list showed every topic; a person's own conversation was never confined (now confined at creation, with `conversation-own`); `/sessions?scope=pool` skipped the mask; last-good was never written (now after each append and confine); `lower` could answer ok having done part of a request; removal missed a person's own sessions; admin role was open and unnamed routes defaulted to admin (now refused in 2a, default owner per §3.7); a write could answer ok with no effect, or carry `team-off` past Face ID (rows now checked before writing, events bound to their route). Also: an unplaced row reads as unreadable; team-off refuses on an unreadable log; the Slack send route is mapped.
Each fix was removed in turn to confirm its test goes red.

- Added: Review fixes with guard tests from both sides.

## Second independent review, 2026-11-06
Eight findings, all fixed: a confined session could plant a link in its inbox and make the unsandboxed server overwrite a file the owner can write (now a checked real folder, an unguessable name and an exclusive write, for media, context and long-message files alike); a member's sentinel stop paused the whole queue (scoped, in both handlers); a resume binding could outlive an audience change (dropped under the lock); same-named files failed and a media-path failure was unhandled; job posts to a confined topic (re-checked before posting); held pushes reached removed people; each append refolded the whole log (now one row); a create recovered after a crash skipped confinement (now confined, and retried if the log is not ready). No route sets a job's topic, so the run-time checks are what apply there.

- Added: Second review fixes with tests; each removal checked to turn its test red.

## Third independent review, 2026-11-06
Fixed: a confined session could report a flag-shaped session id on the hook route, which reached `--resume` at the next launch (a scoped session now speaks only for itself on that route, ids are validated where stored, and every `--resume` sink checks them); on Linux `.curlrc` was written through a planted link (now a staged write and a rename, with a linked folder set aside); session completion skipped the digest filter the periodic scan applies; job reflection read a topic before the confined check (the check now runs first); a member's words could feed owner corrections; a file planted as `inbox` broke dispatch (set aside). The first two exist on main for any confined session, independent of team access.
Accepted, stated in the PR: `/app/media-path` copies are uncapped, but a session can already fill its own folder; a confined session can send `/feedback` under the agent's name.

- Added: Third review fixes with tests; each removal checked to turn its test red.

## Framework generality
The resume id check sits in the launch abstraction and applies to every framework that resumes: claude-code, codex-cli and gemini-cli. It is correct for each: Claude and Codex ids are UUIDs, and Gemini resumes by `latest` or a number, all of which pass. It rejects only a leading dash, a slash, a dot, a space or an overlong value, none of which any framework's id contains. An id that fails is dropped and the session starts fresh, the same as having no id. The launch tests for each framework pass unchanged.

## Fourth independent review, 2026-11-06
No sandbox escape on a default install. Fixed: the crash-recovery confinement was wired only on a path production does not use (now set where every path passes, and it blocks until pairing is ready); a scoped session's hook events could name file paths that optional consumers read on the server (those fields are now removed for a scoped session); the resume dropper depended on the scheduler being on; a late-landing file skipped the session inbox; a row that could not be placed yet stayed unfolded until restart.

- Added: Fourth review fixes with tests.

- Added: Moved setAsideUnlessRealFolder so no new file enters the certified set.

## Fifth independent review, 2026-11-06
No escape and no way to gain access. Fixed: on an ordinary agent invites worked while team-off, restore and memory privacy were refused, because those hung on a separate switch and the console PIN (they now answer to the same conditions as invites, an invite needs Face ID set up on the owner's phone, and enrolment works wherever native conversations do); `teamOn` read false when no log could open (now on when there are signs of a team); removing a person left their phones active and re-adding the key would revive them (phones are revoked on removal and team-off, and a used key cannot be added again).

- Added: Fifth review fixes with tests.

## Outside-family code review (Codex), 2026-11-07
The first review of the code by another model family. Fixed: restore rebuilt the confined list without reading the log, so a read-only grant could drop out (it now reads what the log shows as ever shared or owned); an access change was written after the session's lock was released, so a replacement session could start under the old access (the row is now written while every affected lock is held, in sorted order). Its third point, a folder swapped between check and write, is a stated limit in the spec.

- Added: Outside-family review fixes.

An invite carries exactly one person, so a used key cannot hide behind a new one.

## Outside-family code review, second pass, 2026-11-07
Confirmed the earlier fixes on the real code. Fixed: with no list left at all, restore now confines every conversation, because a log cannot prove it lost nothing (a lost last row leaves no gap); access changes now run one at a time, so a check is still true when its row is written; restore ends every session first, under the locks. Over-block, accepted: a restore with no list locks every conversation to its audience and ends every session. It is a rare repair and fails in the strict direction.
