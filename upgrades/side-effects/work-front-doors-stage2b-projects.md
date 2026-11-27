# Side-Effects Review — Work front doors, stage 2b step 1: Chief of Staff projects offered as Conversations suggestions

**Version / slug:** `work-front-doors-stage2b-projects`
**Date:** `2026-11-16`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Spec docs/specs/work-front-doors.md §3.1 maps each Chief of Staff bound project to an effort (the Project in Conversations); cards then sit under it (later steps). The graph admits `create-effort` and `set-front-door` only from the owner, so the mapping is the owner's Accept, never an import (agreed with the Chief of Staff session 2026-11-16 07:31; plan .instar/lanes/work-front-doors-1114/stage2b-plan.md).
- `ConversationGraphSuggestionService` takes an optional `projects()` source. Each bound project becomes a stored, deterministic suggestion (no model call): "Project: <title>", members = the project conversation plus its Chief of Staff tree children, `frontDoorKey` = the project conversation. Its id is per project (`projectSuggestionId`), so a rejection or an accept holds as children change; a project mid-Accept keeps its members. Project conversations are left out of the model's grouping. A model rebuild keeps project suggestions.
- `offerableSuggestions`: a project is offered while its own conversation is unassigned (one member allowed); a child placed elsewhere is left out of the offer, not a reason to withdraw it.
- AgentServer supplies `projects()` from the Chief of Staff loop (`projectsSummary` + `tree`), Telegram and app keys only.
- Console: the suggestions model admits a one-member project with its front door (which must be a member); Accept runs the same owner steps (create, name, move each, preview first) and then `set-front-door` for the project conversation once it sits in the effort (skipped if the owner had placed it elsewhere). "Accept all N projects" runs the same per-project owner path one at a time; a stop leaves Continue on the rest, so a partial and a later accept both work.
- Awareness: the work-projects entry says only the owner's Accept organizes projects.

## Decision-point inventory
No new authority. Every graph write is the existing owner change, one per step, each owner-proved and committed on every machine before the next. The suggestion is advice.

## 1. Over-block
A project whose conversation is Slack (or another key kind) is not offered; the owner can still organize it by hand.

## 2. Under-block
A project child's title is the projection's title when visible; while an Accept is in progress a moved member shows its stored title (the placeholder "Conversation" for a child), which is what Continue works through.

## 3. Level-of-abstraction fit
Uses the existing suggestion service and accept path; no second organizer.

## 4. Signal vs authority compliance
Advice only (docs/signal-vs-authority.md); the owner's tap holds the authority.

## 5. Interactions
- The model's build excludes project conversations (`busy` includes project members), so the two never compete for the same conversation.
- `syncProjects` writes the state file only when a project suggestion changes; it runs on view and refresh.
- A Chief of Staff source that throws reports a degradation and offers the rest.

## 6. External surfaces
Conversations' "Review suggestions" page gains project suggestions and an "Accept all N projects" button.

## 6b. Operator-surface quality

1. Leads with its primary action: with two or more projects, "Accept all N projects" is the first control on the page (a primary button); each project card's primary button is Accept (Continue after a stop).
2. No raw internals as primary content: a card shows "Project: <name>", one plain reason line ("A project the Chief of Staff tracks. Its conversation becomes the project's front door.") and the member conversations by title; progress reads "Creating the effort…", "Moving conversation 1 of 2…", "Making its conversation the front door…". No ids or keys.
3. Destructive de-emphasized: Reject is the quiet button; nothing here deletes anything (Reject only stops offering it).
4. Plain language at phone width: the cards reuse the existing suggestion card layout (already used on the phone-width console). Not yet seen with projects at 390x844: the live proof of this step loads the review page at 1280x728 and 390x844 on a throwaway with bound projects before the Chief of Staff is told it is live.

## 7. Multi-machine posture
Suggestion state is machine-local, as today (advice; the accept's owner changes replicate through the graph). The Chief of Staff tree replicates through its journal union, so every machine offers the same projects.

## 8. Rollback cost
Revert the commit. Efforts already created by an owner's Accept stay (they are ordinary owner changes).

## Evidence
- Unit: `tests/unit/conversation-graph-suggestions.test.ts` (offered with front door, one member, never sent to the model, child placed elsewhere left out, rejection holds as children change, accepted not offered, a throwing source), `tests/unit/console-conversation-suggestions.test.ts` (accept sets the front door through the owner path; no front door when the owner placed it elsewhere; the model's admission rules).
- E2E: `tests/e2e/conversation-graph-suggestions-alive.test.ts` (the production composition stores the Chief of Staff project with its front door and child).

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Opus 5.5). **Independent read: concern.**
1. A stopped project Accept could not be continued after a reload: once the project conversation moved into the effort it was no longer unassigned, so the item lost its front door (Continue would skip it and still mark it accepted), and with under two members `suggestionsModel` refused the whole list.
2. "Accept all" could create an empty effort: a stale card for a project whose conversation another project's Accept had just moved would still create and name an effort, then skip everything.
3. Stored project suggestions were never pruned: an unbound project stayed offered and its members stayed out of the model's grouping for good.
4. Checked correct: no graph write without an owner action; front-door heads taken from the right nodes after the move; same-tab resume; stable ids; key mapping and nodeKey equality.
5. The note's §2 claim and missing tests.

### Resolution (author)
- 1: while an Accept is in progress the service keeps every member and the front door (`inProgress` in `view`). Unit test: a reload after the project conversation moved still offers it with its front door and both members.
- 2: Accept now checks first, before creating anything, that the project conversation is not already inside something; if it is, nothing is created and the card says "Its conversation is already inside another project, so nothing was created." "Accept all" moves on to the next. Unit test: no `start` and no change call.
- 3: `syncProjects` drops project suggestions the Chief of Staff no longer tracks (unless an Accept is in progress). Unit test.
- 5: §2 is superseded by 1's fix (in-progress members are always shown).

**Re-check after fixes: concern** (same reviewer). Findings 1-3 fixed as described. New: step 0 ran on a Continue from another tab, browser or the phone (no local progress, but the Accept already started on the server): it saw the project conversation inside this suggestion's own effort, said "already inside another project", and left the card stuck on Continue.

**Author:** step 0 now skips when the server says an Accept is in progress (`s.accepting`, which survives a tab change); step 1 then resumes the same create request and lands on the same effort. Unit test: accepting on the server, empty local progress, the conversation already in the effort → finishes, sets the front door, records the accept.

**Final: concur** (same reviewer): step 0 runs only with a front door, no local progress and no Accept in progress on the server; a Continue from another tab, browser or the phone goes to step 1 and finishes on the same effort; the new test covers it.
