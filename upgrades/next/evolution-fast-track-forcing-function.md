# A slipped commitment now meets you at session start

## What Changed

An action item with a `dueBy` that passes has always been *detected* — the 4-hourly
`evolution-overdue-check` job reads `/evolution/actions/overdue` and can complete, cancel or
escalate it. What that job cannot do is put the item in front of the session that could
actually resolve it: it runs out of band, and anything it cancels on its own judgment leaves
the queue without the working agent ever seeing it. There was also no lane at all for the
half before the deadline — that job's `len(overdue) > 0` gate cannot reach it.

- `GET /evolution/session-brief` returns the fast-track lane with its surfacing text already
  rendered, so a hook needs no formatting logic of its own.
- The session-start hook prints that text before any work begins, every session, until the
  item is resolved or cancelled with a reason.
- **Overdue rows are auto-enrolled.** No tag is needed: a missed deadline earns the nag by
  itself. This is a deliberate departure from the original proposal, which surfaced only
  tagged items — a lane that depends on someone remembering to mark things is empty exactly
  when it matters, and an empty lane is indistinguishable from a dead one.
- **`fast-track`-tagged rows surface before their deadline too** — the opt-in "nag me before
  it slips" mark. Set `tags: ['fast-track']` and `dueBy` at creation; put the reason it
  cannot wait in `source.context` and the nag will say it.
- The brief reports **deadline follow-through**: how many completed, dated actions actually
  met their deadline. It is `null` until something dated completes, rather than a 0% or 100%
  computed from an empty denominator.
- `datedPendingCount` separates "nothing is overdue" from "nothing has a deadline, so this
  lane could never fire" — a zero that means never-attempted.
- Silent when the lane is empty. A block that prints "all clear" every session teaches you
  to skip it.

No schema change: the lane rides the existing `ActionItem` fields (`dueBy`, `tags`,
`source.context`), so it composes with existing storage and with the replicated
action-record store.

## What to Tell Your User

If a commitment with a deadline slips, they will now see it at the top of the next session
instead of only in a 4-hourly background job's report. If they want something nagged *before*
it slips, create the action with the fast-track tag. The follow-through percentage is worth
watching: a rate that sits at 100% over many items usually means deadlines are being set to
be trivially met, not that the lane is working.

## Summary of New Capabilities

- `GET /evolution/session-brief` — the fast-track lane plus rendered surfacing lines.
- `EvolutionManager.getFastTrackItems()` / `getSessionBrief()`.
- Session-start surfacing of overdue and fast-track-marked action items, with OVERDUE
  escalation that repeats until the item is resolved.

## Evidence

Three tiers, all green on this branch (`tsc --noEmit`: 0 errors):

- `tests/unit/evolution-fast-track-lane.test.ts` — 17 tests. Both sides of every boundary:
  auto-enrolment of an untagged overdue row; an untagged in-window row staying out; a tagged
  in-window row coming in; completed/cancelled rows leaving; undated rows ignored (that
  population belongs to `UndatedActionResurfacer`); an unparseable `dueBy` skipped rather
  than reported as `NaN` hours; ordering (longest-ignored first, then soonest deadline);
  `blocking` carried or omitted but never invented; the printed rows capped at five while the
  counts stay whole and the output names where the rest are; follow-through `null` before any
  dated completion, and a deadline met on the dot counted as met.
- `tests/integration/evolution-session-brief-route.test.ts` — 6 tests over the real HTTP
  pipeline, including a 200-with-empty-brief for an agent that has no evolution system (a 503
  there would make the hook noisy) and the sibling `/evolution/actions/overdue` still
  answering.
- `tests/e2e/evolution-session-brief-alive.test.ts` — 8 tests on the real `AgentServer`:
  alive on the production path (200, not 503), Bearer-gated, a commitment created through the
  production POST route surfacing in the brief, the row **re-surfacing after a restart** (the
  forcing function outliving the process that noticed it), and leaving the lane once resolved
  through the production PATCH route.
- Two of those e2e cases **execute the hook script itself** against a live listening server
  and assert the slipped commitment reaches stdout — including the hook as `instar init`
  actually generates it (`PostUpdateMigrator.getHookContent('session-start')`), not only the
  template file. A string assertion on the template would prove the text exists; only running
  it proves the surfacing fires.

Regression surface: every test file that reads a session-start hook (19 files) and every file
touching `EvolutionManager` or the evolution routes (34 files) was run individually — all
green. Ten of those files initially failed on an unloadable `better-sqlite3` binary; that was
confirmed pre-existing by reproducing it on a checkout without these changes, then repaired
with `npm rebuild better-sqlite3`, after which they pass.

Cross-pollinated from Dawn's `prop-fast-track.py` (PROP-969). Dawn's own instance of this gap
cost six weeks on a correctly-diagnosed one-session fix while it sat in a 280-item queue.
