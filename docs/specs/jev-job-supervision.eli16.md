# Does each scheduled job actually do its job? — plain-English overview

## What Changed

Instar runs many scheduled jobs (syncs, checks, reports). Today, a job counts
as "successful" if its program simply finished without crashing — nobody
checks whether it actually did the thing it exists for. We have four
documented cases of jobs that "succeeded" for days while doing nothing.

This design adds a checker built on Jev, the very cheap, very fast decision
model we measured last week (it caught 8 out of 8 "claimed success but did
nothing" cases at about a tenth of a cent each). It works in two steps:

1. **The moment a job finishes**, a small snapshot is saved: what the job was
   supposed to do, what it printed (up to 8 KB, secrets stripped), and — if
   the job declares which files it should have produced — whether those files
   actually exist and were freshly written.
2. **A few times a day**, a batch pass shows each snapshot to Jev with fixed
   yes/no questions like "does this output show the promised work was done?"
   and writes the answers down. A free, dumb check (do the declared files
   exist?) is recorded alongside, so we can measure whether Jev adds anything
   beyond it.

Crucially, **it acts on nothing**. No job is blocked, no alert is sent, no
behavior changes. It only writes records, so we can later look at a few days
of them and decide — as a separate decision — whether to let it raise a hand
when a job is faking success.

## What to Tell Your User

Nothing changes for you yet. This adds a silent record-keeper that checks
whether my scheduled background jobs really did what they claim. If the trial
shows it's reliable, I'll propose letting it alert us when a job quietly
stops doing its work — that would be a separate decision for you.

## Summary of New Capabilities

- Every finished job leaves an evidence snapshot (kept on this machine only,
  auto-deleted after 14 days, never uploaded anywhere except the one
  measurement call).
- A batch pass asks Jev whether each job's evidence shows real work, under a
  hard daily spending cap.
- A results log that can be audited later: every verdict keeps the evidence
  it was based on.
- Jobs can declare the files they promise to produce, which gives the checker
  something solid to verify.

## The safeguards, in plain terms

- Switched off by default; turning it on is your explicit decision, because
  job output (which can contain private content) is sent to one outside
  service (TypeSafe, under the agreement you authorized).
- The checker can never slow down or change a job — the moment-of-completion
  work is a tiny snapshot; all the judging happens later, in batch.
- Its verdicts hold no power. The ten review rounds specifically stripped out
  anything that could quietly grow into power: it isn't even named
  "supervisor," because it isn't one yet.
- Everything has a stated limit: spending per day, file sizes, retries,
  storage, retention.

## What you actually need to decide

1. Whether to build it (the design went through ten review rounds, including
   two outside models; the architecture has been stable since round 8, with
   the last rounds only tightening bookkeeping).
2. When it's built: whether to switch on the trial, knowing job output goes
   to TypeSafe during it.
3. After the trial: whether its measured results justify giving it a voice
   (a separate design you'd approve).
