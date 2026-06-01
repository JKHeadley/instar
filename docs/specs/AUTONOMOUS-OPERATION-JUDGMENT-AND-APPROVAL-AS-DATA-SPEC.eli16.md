# ELI16 — Stop Reason Is the Work · Approval-as-Data · Constitutional Traceability

## The one-sentence version

When the agent is working on its own and feels like quitting because "I need a
decision from you" or "this needs real engineering," that feeling is the next
*task*, not a reason to quit; the times you say "approved" get counted so the agent
can eventually approve the easy stuff itself; and **no work is allowed to ship
unless it clearly fits one of our written constitutional rules.**

## Pillar 1 — "The Stop Reason Is the Work" (P13)

Echo keeps ending long autonomous sessions early, always with one of two excuses:

1. **"I need you to make a judgment call."** — Usually means *we never wrote down
   the rule for this situation.* The fix isn't to wake Justin — it's for the agent
   to work out the missing rule from rules it already has, write it down, keep
   going, and just flag "ratify this when you can." Work never stops.
2. **"This needs real engineering, so I'll hand it back."** — Not a reason to stop
   at all. The agent has the spec process, worktrees, the safety gate, tests. Build
   it and hand over something *finished to look at*, not a to-do list.

There are already rules that say "don't tell the user something's *impossible*
without checking your tools" and "don't hand a human a task you could do yourself."
This adds the missing sibling: **don't end an autonomous run for those reasons
either.**

**How it's actually enforced (the important correction):** the strongest place to
enforce this is *the moment the run tries to stop*, not a chat message. Instar
already has that surface — the autonomous-stop hook asks a server evaluator "is this
run really allowed to end?" and tells the agent to keep going if not. So the
*primary* enforcement teaches that evaluator: if the agent is stopping for
"judgment" or "engineering," it must first show a derived rule, a built thing (a
PR/commit), or a genuinely human-only leftover — otherwise "keep going." A
*secondary* check in the outgoing-message gate (rule **B18**) catches stop-announcing
messages, as a backup. (The earlier draft only had the message check; review caught
that a silent stop would slip past it — fixed.)

## Pillar 2 — Approval-as-Data

Right now "approved" vanishes the moment Justin says it. This adds a signed little
ledger that records, per spec: approved *as-is*, or *with a change*? If a change,
*why* (missing rule? safety? scope?). Then:

- We can see, per kind of work, how often it's "approved as-is" — a score.
- When a change-reason keeps repeating, it becomes a new design rule so the next
  spec already includes it, and the score climbs.
- Once a *safe* kind of work scores high enough for long enough (say 85%, 10 in a
  row), the agent can try auto-approving that kind — but **a smart full-context
  check still makes the actual call**; the score only decides whether to consult it.
  (A bare "85%" number is never allowed to be the thing that approves — that's our
  "signal vs authority" rule.)

Safety-critical work (credentials, money, the lease that picks the in-charge
machine, anything destructive, and this very spec's category) is **never**
auto-approved, no matter the score. Justin is the authority on whether his own
approval was "as-is" or "with changes" (the agent can't grade that for him), and any
auto-approval opens a "review this later" reminder and can be revoked instantly.

## Pillar 3 — Constitutional Traceability (Justin's keystone)

Every piece of work must point to a written constitutional rule it serves, with an
*indisputable* fit — and this is enforced by infrastructure, not willpower. If a
spec can't name a rule it clearly fits, the commit is **blocked**, and instead of
quietly giving up, the system raises a decision: *either improve the constitution to
cover this work, or admit the work is unconstitutional and don't ship it.* We
already have a reviewer that reads the constitution; today it only advises — this
makes it block, and adds the "improve-or-reject" fork. It's the "every rule needs a
parent rule, or it's a smell" idea turned into a hard gate.

## Why it's safe

- No safety check is removed. Risky things still need Justin.
- Ships in stages, off by default. Stage 1 = the rules + the gates. Stage 2 = just
  *recording* approvals (changes nothing). Stage 3 (auto-approval) stays dark until
  Justin turns it on for a specific safe category, and even then a smart check makes
  the real decision.
- Everything is additive and reversible: gates fail-open if unsure, auto-approval is
  a per-category off-switch, and the traceability block can only be bypassed with an
  audited, logged override.

## The big picture

Justin's words: the point is to "extract my knowledge and my judgments into
infrastructure" so the agent runs without him. These three pillars are that
extraction — turning his *judgment* into rules the agent derives itself, his
*approvals* into data that trends toward self-approval of safe work, and his
*authority over what's legitimate* into a gate that keeps all work anchored to the
constitution.
