# Plain-English overview — Consumer Evidence for Applied Learnings

## What this is, in one breath

When I learn a lesson, I write it down and later mark it "applied." Right now,
marking a lesson applied requires nothing more than naming something I applied
it to. This change says: if the lesson *claims something about how the system
behaves* — "this job can't use Bash", "this guard blocks that", "this saves 200
slots" — then before I can mark it applied I have to record where I went and
looked to check, and what I actually saw there.

## The problem, told as what actually happened

I have a recurring blind spot. I change something at one end and treat the
change itself as proof the effect landed at the other end. Editing a file is not
the same as the file being read. Writing a rule into a config is not the same as
the rule being enforced.

Four of my own recorded lessons hit this. The worst one, LRN-001, concluded that
certain scheduled jobs "cannot run commands, so they produce nothing." I reached
that conclusion by reading a job's settings file and a log line that said the
restriction had been applied. Both were real. Neither told me what the job
actually did when it ran. I marked the lesson applied and fed it into an
improvement proposal.

Months later I finally looked at a running job's actual process and found it
holding every tool it supposedly couldn't have. The restriction was written down
everywhere and enforced nowhere. The false lesson had already been inherited by
everything downstream of it, and unwinding it cost three days of work fixing a
problem that never existed.

A second version of the same mistake wears a statistic. I measured that 19% of
my memory rows were duplicates and treated that as a big win waiting to happen.
But almost all those duplicates sat in the part of memory nothing ever reads.
Cleaning them all up would free 7 slots out of 200 — about 3%. The number was
true about the whole store and irrelevant to the part actually being used.

## What's new

Two optional pieces of information on a lesson:

- **A flag** the author sets when the lesson claims a behavioral consequence.
- **The evidence**: which consuming end was inspected (a running process, a
  rendered output, the part of a list that's actually visible) and what was
  observed there.

Then one rule: if a lesson claims a consequence and carries no such evidence,
marking it applied is refused, with a message saying exactly what's missing.

## How it decides whether a lesson "claims a consequence"

Two ways, in order:

1. **The author says so.** Setting the flag to true means yes; setting it to
   false means no, and that "no" is always honored.
2. **If the author said nothing**, a simple word check looks for
   consequence-shaped phrasing — "cannot", "prevents", "guarantees", "reclaims",
   "has no effect", and so on.

The word check is deliberately dumb, and that's fine, because it can never have
the last word. If it's wrong, the author sets the flag to false and moves on.
The point isn't to catch every case perfectly; it's to make skipping the
verification trip a deliberate act instead of the default.

## Which way it errs, and why

When it's unsure, it asks for evidence. That's the cheap direction. Being asked
for evidence you didn't strictly need costs one trip to go look at something.
Not being asked when you needed it cost three days. Those aren't close.

## The safeguards, in plain terms

- **Nothing existing breaks.** Every lesson already recorded stays exactly as it
  is. Lessons that don't claim a consequence work exactly as before.
- **It can't block real work.** This only gates my own note-taking — whether I'm
  allowed to call a lesson verified. It doesn't stop a job, block a message, or
  constrain anything a person is trying to do.
- **The author can always override it.** A word-matcher is not allowed to be an
  unappealable judge.
- **Nothing is rewritten.** Lessons already marked applied are left alone,
  including the wrong ones. Erasing them would destroy the record of how the
  bad claims got in, which is the most useful thing about them.
- **One-line rollback.** The new fields are optional additions. Undoing it
  restores the old behavior with no migration and no data loss.

## What you actually need to decide

Whether making the verification trip *mandatory* — rather than a habit I'm
supposed to remember — is worth a small amount of friction on every lesson that
makes a claim about behavior.

The argument for: I've now demonstrated four times that I won't reliably make
that trip on my own, because the cheap evidence is always sitting right there
and it looks convincing. A rule I have to remember is a wish. A refusal at the
moment I try to write the claim down is a guarantee.

The argument against: it adds a step to something that used to be free, and the
word-matcher will sometimes ask for evidence on a lesson that didn't need it.

There is no fleet-wide risk here and nothing ships to users — this is entirely
about the honesty of my own records.
