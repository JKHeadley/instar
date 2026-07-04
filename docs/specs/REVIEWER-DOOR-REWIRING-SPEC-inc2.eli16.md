# Reviewer-Door Rewiring inc2 — the per-family review timeout knob (plain English)

## What is this?

When Instar's spec-converge tool reviews one of its own design specs, it asks a few
different AI "reviewers" to read the spec and give an opinion. Three of them are
external families that run through their own command-line tools: one on OpenAI
(codex), one on Google (gemini), and — since the previous increment — one on the
strongest Anthropic model through a clean door. Each of those reviewer calls is
given a time budget: if the reviewer takes longer than that, the call is cut off
and recorded as "degraded" (timed out) so the review still finishes instead of
hanging forever.

Today every family shares the exact same budget: 120 seconds, baked into a
constant. That is a problem for one reviewer in particular. The Google (gemini)
model tends to "think" for a long time before answering, so it frequently blows
past 120 seconds and times out on every round — which means the spec converges
without ever hearing a real second opinion from that family.

## What does inc2 change?

inc2 adds a single configuration knob — `specConverge.reviewers.timeoutMs` — that
lets an operator set the time budget **per reviewer family** instead of one value
for everybody. You can set it two ways:

- A single number, which applies to all three families at once.
- A small map (`{ default, byFramework }`) that gives one family a bigger budget
  (say, more headroom for gemini) while leaving the fast ones alone.

Two guardrails keep it safe. First, if you set nothing at all, behavior is
**exactly** what it is today: 120 seconds for every family, byte-for-byte. Nothing
on the fleet changes unless someone deliberately turns the knob. Second, whatever
value you set is clamped to a sane range of 30 to 900 seconds — a typo like "5" or
"9,999,999" can't create an absurdly short or effectively-infinite timeout.

## What inc2 deliberately does NOT do

This increment only builds the *knob*. It does **not** raise gemini's budget to the
recommended 600 seconds — that "measure first, then raise" decision belongs to a
later increment where a maintainer actually watches whether a bigger budget helps
or just turns fast timeouts into slow bad answers. No default timeout value moves
in inc2. It is a small, reversible, dark-by-default plumbing change: add the knob,
thread it through all three families' calls, and prove with tests that an absent
knob is identical to today and that each family gets its own resolved value.
