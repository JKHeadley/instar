# ELI16 — Catching "the merge call is yours" for my own PR

## The problem

I built a PR (#1040 — the thing that auto-heals a stalled session), watched the
CI go all-green, and then told the operator: "it's core monitoring code, so the
merge call is yours." He pushed back, hard and clearly: **"the merge call should
never be mine, at least not for PRs you authored. Please change this permanently
moving forward so it is never a blocker."**

He's right. A PR I wrote, that passed every gate and went green, is *mine* to
merge. Handing that decision back to him does nothing but stall the work and make
him a bottleneck on my own output. It's a polite-looking version of not finishing
the job.

And the deeper point, which he's made before about other habits: he keeps catching
me doing this and I keep answering with "understood, I'll do better." A promise is
willpower. This project's founding rule is **Structure > Willpower** — if a
behavior matters, put it in code, not in a vow.

## What already exists

I already have a `deferral-detector` hook. It scans messages I'm about to send and,
if it sees me punting work ("queue for next session", "it's late, I'll wrap up",
"needs a human"), it injects a checklist that re-grounds me before the message goes
out. It already has four categories: can't-do-it claims, orphan TODOs, false
"needs a human" blockers, and (added earlier today) time/fatigue deferral.

There's also a rule in my instar-dev build skill — Phase 7, "Auto-merge on green" —
that says when my PR is green I merge it and don't ask. But that rule only governs
the formal build flow. It didn't stop me from *typing* "the merge call is yours"
in a normal chat message. That gap is exactly what bit here.

## What's new

I added a fifth thing the detector looks for: **merge-deferral** — handing the
merge of a PR I authored back to the operator. It catches two shapes:

- **Explicitly giving him the call:** "the merge call is yours", "your call to
  merge", "leave the merge to you", "merge is your decision".
- **Asking permission to merge my own PR:** "want me to merge?", "should I merge
  it?", "ready to merge?".

When it sees that, it injects a sharp reminder before the message sends:

- If it's my PR and CI is green, **merge it myself now** — green CI means
  mergeable. (It even names the command: `safe-merge.mjs … --squash --admin`, or
  `gh pr merge`.)
- Asking to merge my own green PR is redundant ceremony that stalls delivery, and
  the operator directed it must **never** be a blocker handed to him.
- Having *tracked* the PR does **not** make handing its merge back okay — so this
  check is **not** silenced by the "I tracked it" escape hatch, same as the
  time/fatigue check.
- The only real reasons not to merge: CI is genuinely **red on this change** (fix
  it and re-run), or it's **someone else's** PR (then asking is fine).

## The safeguards in plain terms

- **Signal, not a block.** Like the rest of the deferral-detector, this never
  blocks a message — it injects a checklist so I re-ground before sending. A
  brittle keyword check shouldn't have the power to hard-block; that stays with
  the smart gates. So a false positive (like me asking about *your* PR) just adds
  a reminder I can disregard, never eats a message.
- **Ships to every agent.** The hook's source lives in one place and re-deploys to
  every agent on update, so this isn't a me-only patch.
- **Additive.** It only adds a new detection; it can't reduce the existing four.

## What you need to decide

Nothing — it's a signal-only hook extension that ships as a normal patch. The
point is simply that the next time I finish my own PR, watch it go green, and
reach for "want me to merge?", the structure catches it and reminds me to just
merge it — instead of relying on me to remember the lesson and making you the
bottleneck on my own work.
