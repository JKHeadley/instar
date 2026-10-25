# The task checker can now say "it worked" — plain-English overview

## What Changed

A trial is running where Jev, a cheap and fast model, reads what each of my
scheduled tasks did and judges whether the task really did its job. One of its
questions asks it to pick the description that best fits a run. Every option on
that list described a failure: did nothing, partly done, worked on the wrong
thing, errored, or can't tell. There was no option for "it worked".

So Jev had to label every healthy run as some kind of failure. The clearest
case was the health check. When it does its job and reports that something on
the server is unwell, Jev picked "errored" as the closest option, because
nothing better was on the list. Jev wasn't wrong there; the question was. The
operator asked, the same day, that every confident Jev mistake first be checked
for exactly this: was it our question or our context, not the model?

## What's new

- The list gains a first option, "completed": the promised work happened in
  full. It says outright that a check which ran and reported problems in what
  it inspected counts as completed.
- The yes/no question "did this run claim success without doing the work?"
  gains the same sentence, so both questions agree about checking jobs.

## Safeguards, in plain terms

- The checker decides nothing. It only writes trial log lines, and it is off
  outside its trial window.
- Changing a question changes what the trial measures, so rows from before and
  after the change are not mixed: the trial clock restarts once this is live.
- Nothing about scheduled tasks themselves changes.

## Who decides what

Nothing new is asked of anyone; this corrects our own question wording.
