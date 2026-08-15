# Grok Build Integration — Plain-English Overview

## What this actually is

We're teaching instar to drive a fifth AI coding tool: xAI's Grok Build.
Instar already knows how to run Claude Code, OpenAI's Codex, Google's
Gemini CLI, and pi. Each of those is a "framework" — a command-line program
that talks to an AI model, which instar wraps so agents can run sessions,
schedule jobs, and review each other's work on it. This change adds Grok
Build to that list, wired the same way pi was: nothing turns on unless an
operator explicitly enables it.

## Why we're doing it

Two reasons. First, spec review: before instar code ships, specs get
attacked by reviewers from *different* model families, because models from
one family share blind spots. Today we have exactly two outside families —
GPT and Gemini. Grok is a genuinely independent third, so every future spec
gets one more pair of unrelated eyes. Second — and this is the part that
changed after review — we deliberately do NOT claim an economic win. Grok
Build runs on a $30/month subscription rather than pay-per-token billing, and
the tool REPORTS its costs at 17% of the public API price. But "what the tool
reports" is not "what your account is charged", and we could not prove which
account is charged at all. So we treat every run as if it were metered and
count our own tokens. The reason for using the command-line tool rather than
the API is not price: it signs in with your subscription and holds no API key,
which lets the review door refuse key-based sign-in as a matter of structure
rather than policy; the spending caps are ours and local rather than a vendor
meter we cannot read; and only this path can give you an agent that actually
RUNS on Grok, which is the larger goal.

## What we verified before building (and how)

We didn't take the vendor's word for anything important. We installed the
tool, logged in with a phone-approved device code, and probed it: the login
genuinely grants command-line access; every run reports exact token counts
and a cost figure; and the cost figure's basis was solved by running 22
varied workloads and doing the algebra — it fits a uniform 17%-of-list rate
card to zero error. One thing we could NOT verify: the weekly usage
allowance is invisible. We deliberately burned 1.3 million tokens and the
account's usage meter never moved off 0%. So we cannot see the wall before
we hit it.

## The safeguards, in plain terms

- **It ships off.** Nothing changes for any agent unless an operator adds
  `grok-build` to their enabled frameworks. Update migrations deliberately
  never flip that switch.
- **It can't silently spend money.** The adapter refuses to run if a
  pay-per-token API key is anywhere in the environment — even alongside a
  valid subscription login — because a key is a path to silent metered
  billing. A login that has run out and cannot renew itself is refused rather
  than risked — but one that CAN renew is allowed through, because refusing it
  was what kept it dead: the tool only renews when something actually asks it to
  work, so the refusal blocked its own cure.
- **It can't drain the invisible allowance in the background.** Because we
  can't see remaining quota, grok is banned from the automatic background
  routing that sentinels and gates use. Only deliberate, bounded,
  per-call use is allowed. Quota is reported as "unknown," never
  pretended healthy.
- **Prompts don't leak.** Prompt text goes to the tool through a private
  file, never through command-line arguments that any process on the
  machine could read.
- **Reviews are confined.** When Grok reviews a spec, it runs with all its
  tools disabled and web access off — it reads text and returns text.
- **We only claim what we probed.** The tool has an interactive
  session protocol we haven't characterized yet, so we deliberately do NOT
  declare support for it. Interactive sessions use the ordinary terminal
  path all frameworks use.

## What the review process changed

The draft went through twelve review rounds — six internal reviewers each
round plus an outside model family, and eventually Grok itself. That process
is most of the story, so here is what it actually caught.

The biggest early catch: a draft claimed subscription billing was "verified"
when it was only inferred. The spec now classifies every run as
billing-sink-unknown and budgets as if it were metered until a billing-side
observation settles it. Reviews also forced file-based prompts (an argv leak
caught live), treating an empty result as a failure rather than a quiet
success, and keeping grok out of automatic routing entirely.

The later rounds caught a different class, and it is worth naming because it
recurred: **a claim whose carrier does not exist.** Several times the spec
described a property no code implemented — a rule about which account gets
picked, a migration said to reach existing agents, a promise that an operator
would be told something. Each read as design and governed nothing. Related:
**a value the types allow but a runtime list refuses** — a framework name
accepted by the type system while a hand-written list one layer down silently
dropped it, so the feature was a no-op wearing a green typecheck. That shipped
three times in different registries.

The most consequential single find: the agent built to run on Grok would have
run on Claude. The function that reads "which framework is this agent on" could
not return the new value at all.

Two findings were defects in earlier FIXES: a test written to prove a fix
worked could not have failed, and a fix for "this never reaches existing
agents" would itself have made every unrelated agent do a one-time piece of
work it should not have. And one review round found that this spec could not
have passed its own commit gate — a companion-document check was looking in the
wrong directory.

Grok's own review raised the sharpest architectural objection: that a narrower
design (a review-only helper, with no session or account plumbing) would have
avoided most of these defects. That is recorded honestly in the spec. It is
rejected because the goal is an agent that RUNS on Grok, which needs the
plumbing — but the defect count is the real cost of that goal, not a footnote.

## What is proven to work, and what is not

Proven live, not asserted: the real adapter ran a real completion under the new
agent's own configuration and returned proper token accounting; the same build
refuses to register Grok at all for an agent that has not opted in; and Grok
reviewed this spec end-to-end as a third reviewer family.

Not shipped: background jobs on Grok (that lane refuses by design until more
wiring lands), interactive sessions without a second, separate opt-in, and
automatic routing of any kind. The usage ceiling remains genuinely invisible —
we spent real allowance trying to make the vendor's meter move and it did not —
so the safety net is our own token counting, plus a daily cap on review use.

## One more thing found by watching it run

The log line that announces a session is ready said "Claude ready" — even when
the session was Grok. The line above it said Grok; this one said Claude. If you
read the second line and trusted it, you'd conclude the whole Grok deployment had
failed. I nearly did.

It was never really about Grok. That line has been wrong for every non-Claude
framework instar supports, for as long as they've existed — nobody noticed
because nobody had a reason to read it closely until now. The check it belongs to
doesn't actually know which framework it's watching; it just waits for the screen
to settle. So the fix is to stop naming a framework rather than to teach it one:
a sentence that can't know something shouldn't claim it.

Worth saying that the first attempt only fixed the one message I'd seen. There
were five, and three of the others were ERROR messages — the ones you'd be
reading when something had already gone wrong, which makes them the more
important half.

## And one that turned out to be bigger than it looked

Background jobs don't run on a Grok-only agent — that was known and written down,
along with the fact that it makes 33 scheduled jobs fail. What wasn't traced is
that the same closed door blocks something else: **other agents can't reach it
either.** A message sent to the Grok agent was accepted, queued, and then never
handled. The sender sees it as sent and waits for a reply that cannot come.

The first refusal in the log was ordinary memory pressure, which made it look like
a temporary hiccup. Every attempt after that hit the real wall. That's worth
noticing on its own — the transient-looking cause was sitting on top of the
permanent one.

The point isn't the second example. It's that the written blast radius said
"scheduled jobs" because scheduled jobs were what we happened to see first. The
true scope is everything that reaches the agent through that door, and both
examples so far were found by running it rather than by reasoning about it. So the
honest statement is that the list is incomplete — not a longer list I'd be
guessing at.

## What you're deciding

Whether instar ships a fifth, dark-by-default framework whose billing sink is
UNPROVEN (so every run is budgeted as if metered), whose main risk is an
invisible usage ceiling (mitigated by keeping it out of anything automatic and
by our own local token caps), and whose integration mirrors the pi pattern
that's already in production.
