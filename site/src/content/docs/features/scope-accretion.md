---
title: Scope-Accretion Completion Discipline
description: Work an autonomous run itself creates joins its completion bar — silent deferral of session-generated deliverables is structurally impossible.
---

> StandingDrive composition note: `AutonomousRunStore` remains the durable run-record owner, while `StandingDriveSchema` defines the optional deterministic drive envelope. See [StandingDrive schema](/features/standing-drive/) for the inert Slice 1 boundary.

An autonomous session that discovers new in-scope work mid-run can convert that
initiative into abandonment: draft five specs, label their implementation "the
documented stretch (out of completion condition)", satisfy the start-time
condition, and exit. The Scope-Accretion Completion Discipline closes that gap
structurally: **artifacts the session itself creates join its completion bar**,
and the completion judge refuses `met: true` while they sit unbuilt without
operator ratification.

The design principle (per the spec's convergence review): every load-bearing
fact is computed **server-side, from git truth and server-owned state** — never
transported from the session's environment, and never read from files the
session routinely edits.

## Run registration (`POST /autonomous/register`)

At session setup, `setup-autonomous.sh` registers the run with the server. The
server — not the session — mints the `runId`, snapshots the `scopeAccretion`
config (so a mid-run config edit changes nothing the gate reads), records the
sweep base roots with their `git rev-parse HEAD` start-SHAs, and clamps `endAt`
to `now + autonomousSessions.maxDurationMs`. One registration per active run:
a re-register for a topic is refused (409) while the existing record is
non-terminal and unexpired.

The optional `declaredDeliverables` list is the escape hatch for genuinely
draft-only missions: paths declared at setup (operator-visible in the setup
summary) never hold completion. A pathless condition ("draft five specs…")
declares **nothing** — drafting was the abandonment in the motivating incident.

## The git-truth sweep at the chokepoint

At every done-claim, `POST /autonomous/evaluate-completion` sweeps git state
over the run's roots (work_dir repo, its worktrees, in-run worktrees under the
agent-home convention): SHA-anchored committed work across local branches plus
`git status --porcelain` uncommitted work. A deliverable-class artifact (a spec
under `docs/specs/`, an audit, a runbook, an incident doc, a script) that is
neither **built + corroborated**, nor **declared**, nor **operator-ratified**
holds completion deterministically — `met: false` with
`reason: scope-accretion-hold` and the exact path list — *without* spending the
judge LLM call. It does not matter how the file was written: Write tool, Bash
heredoc, `tee`, or a subagent — the file in the tree is the state.

Corroboration is per-class and never self-authorable: a spec clears via its
convergence report **plus** the server's own record of a real conformance-check
ceremony run, or via a merged PR whose diff carries real non-docs code (≥1
non-docs path, ≥10 changed non-docs lines). Positive corroborations persist
(monotone); a network failure fails toward keep-working.

Deletion is not an exit: an accreted deliverable that disappears from the tree
stays in the unbuilt set flagged `deleted: true` and is enumerated loudly.

## Ratification — verified principal, display-integral

Two paths, both terminating in server-owned records:

- **PIN route (phone-first):** `POST /autonomous/:topic/ratify-deferral` with
  the dashboard PIN and `{"artifacts": [...]}` or `{"all": true}` — the
  response echoes exactly what was ratified.
- **Conversational:** when the verified operator says "defer those" /
  "ratify deferral" in the run's topic, the **server** replies with the exact
  enumerated artifact list; a reply-anchored confirmation (or an explicit
  "ratify" message) from the verified operator binds exactly that set. A bare
  "yes" that is not reply-anchored ratifies nothing. Both the trigger and the
  confirmation are matched only at the server's live Telegram receive path —
  no on-disk message file participates, so a session cannot forge either.

The operator's live mid-run lever is
`POST /autonomous/:topic/scope-accretion-override` (dashboard-PIN-gated) — the
config file is snapshotted at registration, so this route (not a config edit)
is the instant off-switch for a running session.

## No wedge: the breaker, and every exit is loud

`breakerK` (default 3, min 2) consecutive holds with an unchanged unbuilt set
trip a persisted breaker: **one** loud, distinctly-labeled attention item and
topic notice ("exiting via scope-accretion breaker with N unbuilt accreted
artifacts…", carrying the P13 stop-rationale classification), after which the
gate disengages for the run. The guarantee, stated honestly: silent deferral is
structurally impossible — accreted work blocks completion K times and can
thereafter be abandoned only *loudly*.

Every run-end surface — met, duration expiry, hard-blocker, emergency stop,
state corruption — fires `POST /autonomous/:topic/run-end`, which runs a
non-blocking advisory sweep and enumerates any non-empty unbuilt set in the
end-of-run notice. A crashed run is caught by a daily sweep backstop (late but
loud). The silent clock-out is structurally closed.

## Configuration

```jsonc
// .instar/config.json
{
  "autonomousSessions": {
    "completionDiscipline": {
      "scopeAccretion": {
        "enabled": true,   // default ON (monotone-safe); snapshotted at registration
        "breakerK": 3      // consecutive unchanged-set holds before the loud breaker exit
      }
    },
    "maxDurationMs": 172800000 // server-side clamp on a registered run's endAt (48h)
  }
}
```

Editing `enabled: false` is the rollback for **future** runs; the PIN override
route is the live lever for a run already in flight. Feature metrics land under
the `scope-accretion` key (holds, breaker trips, ratifications, enumerations,
sweep latency).

Spec: `docs/specs/autonomous-scope-accretion-completion.md`.
