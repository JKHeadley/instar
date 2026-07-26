# A reviewer that never ran reported a perfect score — Plain-English Overview

> The one-line version: the health check for the reviewers that vet my outgoing messages
> gave a never-executed reviewer a flawless pass rate and a clean bill of health, so
> "nothing has happened here" was impossible to tell apart from "everything is fine."

## The problem in one breath

Before a message of mine goes out, a set of reviewers can look at it. There is a health
page for those reviewers. If a reviewer had never actually run — not once — that page
reported it as scoring one hundred percent and being healthy. Not a blank, not a zero, but
a perfect score, invented from no data at all. Anyone opening that page to ask "is this
working?" got a confident yes from something that had never done anything.

## What already exists

- **The reviewers** — a set of checks that read a finished message and give an opinion.
  On most installs, including this one, they are switched off entirely.
- **The health page** — shows, per reviewer, how often it passed and whether it looks
  healthy. This is what had the problem.
- **A second, similar page** — the same numbers in a slightly different shape, for a
  dashboard. It had the same problem, with a twist described below.
- **A counter elsewhere in the same file** that already tracked "has this reviewer actually
  run?" as a simple yes/no. The information needed to avoid the whole problem was already
  being calculated a hundred lines away. The health pages just never looked at it.

## What this adds

A score is now reported as *nothing* when there is nothing to score, instead of as a number
that reads like good news. The count of observations always travels beside the score, so a
reader can see what it was calculated from. And a reviewer only gets called healthy once
there is enough evidence to say so — five observations — with a new fourth state,
"unobserved," for everything below that.

The important asymmetry: the evidence requirement only holds back **good** news. A reviewer
that failed on both of its only two attempts is still reported as failing. Requiring
evidence before believing something is fine is prudent; requiring evidence before admitting
something is broken would just be the same bug facing the other way.

## The new pieces

- **"Unobserved"** — a fourth answer alongside healthy, degraded and failing. It is
  deliberately not an alarm. It means nothing is wrong and nothing is known yet, which is
  a different and more useful thing to say than either "fine" or "broken."
- **An evidence floor** — five observations before the word "healthy" is used. This is not
  a new rule invented for this fix. Another part of the system computes the very same kind
  of score and already refuses to act on it below a hundred observations. That guard is
  precisely why the identical line of arithmetic is harmless there and was a bug here. So
  this is one place being brought in line with a habit the codebase already keeps.

## The safeguards

The second page had the same defect pointing in **both** directions at once: the same
quantity defaulted to zero in one place and to a perfect one in the other, about a hundred
lines apart in a single file — and it also claimed flawless formatting from a reviewer that
had never read a single response. Two opposite defaults for one number is the sign that
neither was thought about, so both were fixed together rather than one being tidied while
its twin was left.

Nothing here can block, delay or change a message. These are read-only displays, and the
only thing that consumes them is the page that shows them — checked, not assumed. An
earlier claim that this surface controlled whether the reviewers get switched from watching
to blocking was **wrong**, and was withdrawn once the connection was actually looked for.

## Why the tests mattered more than the code

Two existing tests were changed, and the reason is the more interesting half of this.

One honestly said "reports healthy status when no reviews have run" — and asserted it. The
bug was pinned in place as intended behaviour, so it could never be noticed by running the
suite.

The other was named "detects degraded status when error rate is high." Its own comment
promised to simulate a high error rate by adjusting the numbers. **That simulation was
never written.** The test created a fresh reviewer and asserted it was healthy. So the two
paths it was named after had no coverage at all, while a green test carrying their name sat
in the suite looking like proof they worked.

That is the same shape as the original bug, one level up: a passing test named for a check
is indistinguishable from that check actually being verified. The test now performs the
simulation its comment described, and the previously untested paths are covered.
