# Plain-English overview — Cross-model review through codex (Step B)

## What "cross-model review" is

Before I'm allowed to change instar's own source code, every design spec has to survive a
panel of reviewers — like getting a paper read by several people who each look for a
different kind of mistake. Five of those reviewers are versions of me (Claude) wearing
different hats: a security reviewer, a scalability reviewer, an adversarial "how could this
be abused" reviewer, an integration reviewer, and a "does this break a lesson we already
learned" reviewer. But there's a catch with using only me: if my whole model family shares
a blind spot, all five of my hats miss it together. So the panel also includes a
**cross-model** reviewer — a *different* AI (a GPT-family model), specifically because it
thinks differently and catches the things I'd never think to question.

## The problem this fixes

That cross-model reviewer was never actually built. The skill that runs the panel just said
the external reviewer would happen "via the /crossreview pattern" — but there was no
`/crossreview`: no code, no script, nothing that actually sends the spec to a non-Claude
model. It was a placeholder. So in practice the "outside opinion" either got skipped or
faked. That's the gap Step B closes.

## What we're moving it onto, and why

Instead of relying on some third-party AI API (a new account, a new API key, a new thing to
keep paid-up and secure), we route the outside review through the **codex CLI** — the GPT-
powered command-line tool the agent **already has installed and logged in**. instar already
uses codex for lots of small "make a judgment call" tasks, through a hardened, well-tested
path. Step B reuses that exact same path for spec reviews: it hands codex the reviewer
instructions plus the spec, codex (running as a GPT model) reads it and writes back a
verdict and a list of concerns, and those get folded into the panel's findings. No new
credential, no new network service — it rides the agent's own `codex login`. And it runs
codex in a locked-down, read-only scratch space so a review can only *read and judge*, never
write to the repo or accidentally boot the whole agent.

## The "no codex" fallback (the important safety choice)

What if codex isn't installed, or isn't logged in? We do **not** block. Blocking would mean
"you can't review any spec until you install another tool" — which would grind development
to a halt. Justin approved this rule directly. Instead, the review just runs with the
internal Claude reviewers only, and it stamps a loud, impossible-to-miss flag on the spec
and in the review report: **`cross-model-review: unavailable`**. That way, when Justin reads
the report and decides whether to approve, he can clearly see "this spec got the internal
panel but NOT the outside second opinion, because no external reviewer was installed." It's a
*disclosed* reduction in confidence, not a silent one. The one reviewer that can *never* be
skipped — the lessons-aware reviewer — still runs no matter what, because it's our defense
against approving something that quietly contradicts a hard-won lesson.

There are a few other ways the outside opinion can come up short, and **every one of them
gets the same loud warning banner** — none of them is allowed to quietly look like a clean
pass. If codex was there but every single review attempt failed (it timed out or hit a usage
limit on each round), the spec ends up flagged **`degraded-all-rounds`** — meaning it
converged without ever actually getting a real outside opinion, which is just as serious as
having no reviewer at all. And if the author deliberately took the fast path and skipped the
outside review to save cost, that gets a loud banner too (**skipped**), not a quiet footnote
— "I chose to skip the second opinion" should be just as visible to the person approving as
"no second opinion was available." Only one banner has no warning mark on it: the one that
says a real outside review genuinely ran. One more detail under the hood: when the outside
reviewer is run, the spec and its supporting documents are pasted directly into the request
(codex can't open files itself), and if there's too much to fit, the least-important
documents are dropped in a fixed, predictable order — and the request says exactly which
documents were trimmed, so the reviewer always knows what it couldn't see.

## Built to grow

codex is the *first* supported outside reviewer, but it won't be the last. There's a little
registry — a list — where future tools (like a Gemini CLI) can be plugged in later by adding
one entry. The review skill doesn't need to change to add a new reviewer; the list is the one
place that knows about them.

## What changes for a person

For an end user: nothing visible — this is all internal to how I safely develop instar
itself. For Justin (who approves specs): the review reports now actually contain a real
outside opinion when codex is available, and a clear "no outside opinion this time" banner
when it isn't — so approval is always an informed decision. For me: the "outside reviewer"
step stops being a placeholder and becomes a real, grounded check that genuinely catches my
own blind spots before code gets written.
