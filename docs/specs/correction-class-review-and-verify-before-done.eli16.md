# Corrections that actually change the system, and not claiming "done" before it's true — in plain words

## The one-line version

Two habits, built into structure instead of hoped-for: **(1)** when the user corrects
me, that correction has to *change something durable* — a rule, a process, or a tracked
fix — not just get patched once and forgotten. **(2)** I shouldn't tell you something is
"done / sent / handed off" until I've actually checked it happened.

## Why this exists

Justin gave me a meta-rule: *every time you're corrected, before you fix the one thing in
front of you, ask two bigger questions — what STANDARD is missing that let this class of
mistake through, and what in our DEV PROCESS would have caught it? Fix the class first,
then the instance.* Otherwise I fix the same shape of mistake over and over.

When I actually looked at the live system, I found something important — and it corrected
my own team's assumption. We thought corrections were vanishing at capture (that the
"learn from corrections" machinery recorded nothing). Not true: it records them fine —
there are 24 recorded right now, including the three notes Justin gave me this week. The
real problem is they just **sit there forever**. Nothing turns a recorded correction into
a rule change, a process change, or even a tracked to-do. It's captured and then abandoned.
So the fix isn't "start capturing" — it's "build the part that drains captured corrections
into real outcomes."

## Mechanism 1 — the class-review loop

When a correction lands, a small reasoning step runs two questions (what standard is
missing? what process gap let this through?) and writes down a durable *class-review*
record with two proposals: a possible rule change and a possible process change. Crucially,
it can only **propose** — it drafts a proposal for the operator to approve and opens a
tracked build item. It can NEVER quietly rewrite the rulebook, my memory, or my own policy.
That guard is the same one the existing correction pipeline already uses. And the actual
one-off fix is *blocked* until the class-review exists — so "think about the whole class
first" isn't willpower, it's a gate.

## Mechanism 2 — verify before you claim "done"

Earlier in this very drive, I told the operator I was "getting Codey his assignment now"
before I'd checked the channel to Codey even worked. Classic over-claim. There's already a
rule ("don't say it's fixed until you've verified it stops failing") but it only covers
"fixed / wired / working" — not the everyday "done / sent / handed off / deployed." This
mechanism watches for a completed-action claim at the end of a turn and checks it against
the turn's own evidence: *did a tool actually run that would have done this, and did it
succeed?* If not, it's a quiet flag (a signal, never a block, in the first version) so I
learn to check before I claim.

There's an honest catch: a tool running isn't *proof* the real-world thing happened (a
message getting sent to a terminal isn't proof the other agent read it). So this is a
gentle nudge that leans toward *not* accusing when unsure — a false nag is worse than a
missed one. And there's a neat twist: this second mechanism is literally the *first thing
the first mechanism produces* when you feed it my "getting Codey his assignment" slip. The
loop dogfoods itself.

## What ships, and how carefully

Both start **off for the wider fleet and on only for the development agent, in dry-run
first** — meaning they *log what they would do* without doing it, so we can watch them be
right (or wrong) before they touch anything real. Nothing here can block a message or
rewrite a rule on its own. The riskiest new power — a gate that blocks creating a one-off
fix until the class-review exists — ships in "would-block, just log it" mode first, and the
decision to make it really block is the operator's, on evidence.

Class reviews follow the agent across its machines, while completion evidence stays on the
machine that produced that turn and is shown to the pool only through a scrubbed read view.

## The honest limits

- The completion-check runs on Claude Code (it reads that harness's session transcript for
  the tool-call evidence); on other engines it's a declared no-op until we extend it.
- "Corroborated by a tool call" is a judgment, not proof — so it's a signal, tuned to avoid
  false accusations, with its false-positive rate measured before it's ever allowed to block.
- It builds ON the existing correction pipeline; the pipeline's own recurrence-gate (which
  suppresses noise by only acting on repeated patterns) stays exactly as it is — this adds a
  parallel, un-gated "every correction gets a durable outcome" path beside it, it doesn't
  weaken the noise filter.
