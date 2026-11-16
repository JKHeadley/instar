# Side-Effects Review — Work front doors, stage 2a (Projects on the Work door)

**Version / slug:** `work-front-doors-stage2a`
**Date:** `2026-11-16`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

A read-only server read, `GET /work/projects` (bearer) and `GET /mobile/work/projects` (device rule, own rate bucket, team tier guest), returns every project the Chief of Staff tracks: where it stands in plain words (the server owns the words), its done list with each item's state, and the work-board cards that belong to it. A card belongs to a project when its existing `projectKey` equals the project's conversation key; other cards are listed apart. The console Work page shows it as a Projects section right after the "Waiting on you" lane (a page leads with the need), with Finished projects and Cards in no project folded below; it also shows when the board is switched off. A new `ChiefOfStaffLoop.projectsOverview()` reads every project and its done list from one journal read (`projectDetail` reads the journal once per project). `ownerPause()` reads an owner pause record (`pausedBy {who, at, quote, messageRef}`, on the binding state or the binding) when the Chief of Staff's pause route writes one; it is built separately (brief `cos-owner-pause-record.md`, session echo-137342). Until then nothing reads "paused". Capability entry `workProjects`.

Driven by docs/specs/work-front-doors.md §7 stage 2 (approved with the spec, Justin 2026-11-15), slice order in `.instar/lanes/work-front-doors-1114/stage2-plan.md`; Projects first because Justin described exactly this on 2026-11-15 23:10 PT (topic 141385, relayed by the Chief of Staff session).

## Decision-point inventory

- **Who gets project names:** the owner (bearer, owner phone). Any other resolved person (member, guest, shared-machine user) gets an empty, complete answer; an unknown device is refused 403. This is a privacy filter (spec §4.4), enforced in the handler; the device rule only admits the call.
- **State words:** a pure mapping from the Chief of Staff's verdict and its loop-parked flag. Parked is shown as "I stopped retrying: needs a look", never as an owner pause; an owner pause only from the owner's own logged words.
- No new authority: nothing is blocked, approved, restarted or written.

## 1. Over-block

A member or guest who could read a card's conversation does not see that card under Projects (they still see it on the board as today). Intended for 2a: project names stay owner-only until the stage 2 tree defines viewer-filtered project labels.

## 2. Under-block

The owner's list includes every bound project, including ones with sensitive titles; that is the owner's own data on their own surfaces, the same as `GET /chief-of-staff` today. A card's title appears under its project only for the owner (the board itself already filters per viewer for others).

## 3. Level-of-abstraction fit

Composition at the read layer, as the Needs-you read does: no new store, the Chief of Staff and the board stay the sources of truth. The state words live on the server so the console, both phone apps and the Mac app say the same thing.

## 4. Signal vs authority compliance

Read-only. No decision with blocking authority is added (docs/signal-vs-authority.md).

## 4b. Judgment-point check

The verdict itself is the Chief of Staff's existing LLM-judged result; this only displays it. "Not known yet" is shown for an unknown or never-checked verdict instead of guessing.

## 5. Interactions

- Uses stage 1's `exposeBoardRead` to read the board as the same caller; a board that is starting reads as could-not-check, a board switched off as off.
- `projectsOverview()` loads the Chief of Staff union once per build; builds are shared for 10 s.
- The console Work page now makes two reads in parallel (`/work-board`, `/work/projects`); the Done-lane pages skip the projects read.
- The needs-first-screen test still passes: Projects sits after the lead lane.

## 6. External surfaces

New routes `/work/projects` and `/mobile/work/projects` (capability index `workProjects`). The phone apps do not call it yet (iPhone, Android and Mac follow in this slice's app work); an older server answers the phone 404 or 403 device-not-allowed, which the apps must read as "not on this agent yet" (the stage 1 strip already does this for the Needs-you read).

## 6b. Operator-surface quality

The section names what could not be checked ("Could not check the projects, so this may not be everything.") and says "No projects are being tracked yet." only on a complete read. Rows open in place (44 px targets), each card links to its card and its conversation, and each project to its own conversation.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Proxied-on-read by composition.** The Chief of Staff's bindings and checks replicate through its journal union; the board replicates. Any machine answers from its own replicas. No new durable state, no notices. Links are console hashes, valid on any machine.

## 8. Rollback cost

Revert the commit: two routes, one console section, one read method. No data, no migration, no config.

## Conclusion

Ship behind the existing gates (Chief of Staff and board dev-gated as today). Read-only, owner-only names, honest gaps.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Opus 5.5)

**Independent read of the artifact: concern**
1. Privacy: no leak (needsViewer admits only the owner; non-owners answered before the cache; the 10 s cache is filled only on the owner path).
2. Card lists silently incomplete: the board read cuts "Waiting on you" at softOpenCards and Done at 20, so cards past the cut dropped out of their project while the answer said complete.
3. Chief of Staff off read as "No projects are being tracked yet", a fact never checked.
4. The pause comment described code that does not exist (BindingState has no pausedBy yet); ownerPause does not check that `who` is the owner.
5. The rest checks out (archived skip, join, caps, order, starting board as failed, textContent everywhere, Projects after the waiting lane, renders when the board is off or fails).
6. Untracked files to stage; this note missed the awareness entry, the release note, findings 2-3, and this review.

### Resolution of the second-pass findings (author)
- 2: `boardJson` takes `full: true` (no lane cut) and the Projects read asks for it (`workBoardReadAs(req, { full: true })`); the board page keeps its cut lanes. If a lane still arrives cut (`more` > 0 or `total` above the cards shown), the read names "every card on the work board" in couldNotCheck. Unit-tested.
- 3: Chief of Staff off reads "Project tracking (the Chief of Staff) is not switched on for this agent." and never "no projects". Unit-tested.
- 4: comment corrected (nothing writes the pause yet; the Chief of Staff's owner-pause route, built separately by echo-137342, checks the owner's message reference). Accepted that the reader trusts a complete record: only that gated route writes it, and the binding is the Chief of Staff's own replicated record.
- 6: everything staged; this note now names the awareness entry (`src/data/awareness/work-projects.md`, which also tells agents to set `projectKey` on cards for a tracked project) and the release note (`upgrades/next/work-front-doors-stage2a.md`).

## Evidence pointers

- Unit: `tests/unit/work-projects-read.test.ts` (state mapping, owner pause, composition, honest gaps, caps, routes, console model).
- Integration: `tests/integration/team-access-routes.test.ts` (owner phone gets names; member and msp phones get none, through the real device middleware).
- E2E: `tests/e2e/work-projects-alive.test.ts` (production boot answers the owner; the console page ships).

**Re-check after fixes: concur** (independent reviewer subagent, Opus 5.5). `full` reaches `boardJson` only through the Projects read, which asks for it only for the owner; the board page and the Needs-you read pass no options and keep their cut lanes; the per-viewer filter still runs first. A full read is not flagged as cut; a cut lane names "every card on the work board". Off is said as off. The pause comment is accurate; trusting a complete record written only by the gated route is recorded. Noted, accepted: the owner's done lane is unbounded in this read (builds shared for 10 s).

**Author, browser check (02:15 PT):** rendered the Work page on a rig of this branch at 1280x728 and 390x844 with a Projects answer composed by this code from Echo's real 22 projects and board. Two fixes: the state dots used class names the console does not define (all looked "ok"; now the console's own `dot attn/bad/unknown`, plus a muted `dot quiet`), and "0 of 3 done" showed for done lists nobody had checked yet (now "3 to finish, not checked yet"; unit-tested). No horizontal scroll at either size.

**Author, Chief of Staff's ask (02:40 PT):** a project with no verdict ("Not known yet", 15 of Echo's 22) now carries `why`: the tracker's newest check note that says something (carried-forward "no new evidence" notes are skipped), on one line, at most 160 characters at a word boundary; a bare internal code reads "The tracker's last check could not run." Shown only for "Not known yet" rows, in the row body as "Why it's not known: …". Checked against Echo's real notes: plain sentences, no paths or secrets. Unit-tested. The tracker gap itself (no evaluator can pass a prose done item) is fb-e9d75715-316.
