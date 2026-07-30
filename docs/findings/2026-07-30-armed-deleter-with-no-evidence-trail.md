---
title: "An armed deleter has run for seven weeks and nothing records what it deleted"
date: 2026-07-30
author: echo
machine: Laptop (mac.lan)
severity: high
status: open
kind: finding
relates:
  - "docs/specs/agent-worktree-reaper.md"
  - "docs/specs/worktree-read-path-eventloop-safety.md"
  - "docs/STANDARDS-REGISTRY.md"
---

# An armed deleter has run for seven weeks and nothing records what it deleted

**Deliberately not folded into the event-loop change.** That change is about a frozen
event loop. This is about an irreversible action with no evidence trail. Folding the
second into the first buries it, and it is the more serious of the two.

## The finding

`AgentWorktreeReaper` emits a `reaped` event when it removes a worktree:

```ts
this.deps.removeWorktree(info.path);
reaped.push(info.path);
this.emit('reaped', info);
```

**Nothing listens to it.** The construction site in `src/commands/server.ts` builds the
reaper, calls `start()`, logs one line if it is enabled, and registers no handler. There
is no `.on('reaped', …)` anywhere in the tree. There is no audit file, no log line, no
attention item, and no entry in the reap-log (that log is for *sessions*, a different
subsystem).

So the reaper can delete a worktree and leave **no record that it did**.

## Why this is the headline and not a footnote

It sat alongside two fail-open gates found the same day. It is worse than both, for a
structural reason rather than a severity-scoring one:

- A fail-open gate is a **bounded risk**. You can reason about its trigger, measure
  whether the trigger occurs, and calculate what it could cost.
- No evidence trail is **an unanswerable question**. It does not raise the probability
  of harm; it removes the ability to determine whether harm occurred.

This was demonstrated rather than argued. A peer asked a reasonable question — *has this
reaper actually removed anything on that machine?* — and the honest answer is that the
system structurally cannot answer it. Everything below is the best evidence obtainable,
and it is not sufficient.

It is also the purest instance of a defect class we hit repeatedly on 2026-07-29/30: **a
claim with no mechanism behind it.** A health endpoint reporting `ok` it never computed;
an exemption comment asserting a safety property that had silently stopped being true; a
test certifying a property the shipped code violated. This is the same shape with an
irreversible consequence instead of a merely misleading one.

## Evidence gathered (2026-07-30, Laptop)

**Armed, and for longer than assumed.** `GET /worktrees/agent-reaper` reports
`enabled: true, dryRun: false`. `logs/guard-posture.jsonl`:

| When | Transition |
| --- | --- |
| 2026-06-06T07:17:03Z | `monitoring.agentWorktreeReaper.enabled` → **enabled** |
| 2026-06-07T16:49:22Z | disabled, in the batch load-shed (9 guards at once) |
| 2026-06-07T18:12:42Z | **re-enabled** |

≈7.5 weeks armed with a 24h cadence, plus a 15-minute post-boot initial pass.

**Enumeration works here.** 49 worktrees evaluated on the live snapshot — so the reaper
has had real candidates to consider on every pass, unlike a machine where enumeration
fails and the reaper is inert by accident.

**No partial-removal signature.** 50 registered worktrees, 59 directories on disk, and
**zero** registered-but-missing directories. A `git worktree remove` takes both the
directory and the registration, so an interrupted removal would show as a registered
worktree with no directory. None exists. The nine extra directories are the opposite
shape — untracked leftovers, not deletion residue.

**Nothing is currently eligible.** 35 `uncommitted-changes`, 14 `unmerged`, **0
reclaimable**. Both of those gates fail closed correctly.

**The most recent pass removed nothing.** `lastPassAt` 2026-07-30 05:48 local,
`reapedLastPass: 0`.

## The honest limit

**Absence of a signature is not proof of absence of deletions.** Every item above is
consistent with "it never deleted anything" and equally consistent with "it deleted
things cleanly and left no trace" — which is precisely what a successful
`git worktree remove` does. The only artefact that would distinguish them is the record
that does not exist.

What can be said with confidence: the most recent pass removed nothing, nothing is
eligible right now, and there is no evidence of a deletion. What cannot be said: that
none occurred in the preceding seven weeks.

## Recommendation

1. **Add a listener and a durable record before anything else.** Every `reaped` event
   should append to an audit file with the worktree path, branch, head SHA, the verdict
   reasons that authorised it, and the timestamp. This is small, and until it exists
   every future question of this kind has the same non-answer.
2. **Treat the record as a precondition for arming, not a nice-to-have.** A guard that
   performs irreversible actions should not be armable without one. That is the
   *Structure beats Willpower* form of this finding: the record should not depend on
   whoever wires it remembering to.
3. **Register the reaper as a self-triggered destructive controller.** It is absent from
   the self-action registry despite firing on a timer and deleting on a heuristic. Its
   `maxReapsPerPass` cap bounds one pass, never the loop — the exact distinction the
   *Capacity Safety — No Unbounded Self-Action* standard draws. Today produced three
   independent arguments for this: the heuristic delete with a per-pass-only cap; seven
   weeks armed on one machine while the guard manifest classified it differently on
   another; and no instrumentation and no deletion record at all.

## Scope note

Items 1 and 2 are not in the event-loop PR and should not be. That change is confined to
execution strategy; this is a foundation gap. Smuggling a foundation change into a
performance fix is how a change stops being reviewable — and it would land in the same PR
where a delete-unsafe path was just found.
