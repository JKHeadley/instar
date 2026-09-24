# The job checker can finally check something — plain-English overview

## What Changed

The scheduled-job checker asks one question after every job runs: did this job
actually do what it promised, or did it quietly do nothing and report success?
To answer that, it can look at the job's printed output, and it can check
whether a file the job promised to update really changed while the job ran.

The second check is the strong one. But no job had ever named a file, so on
this machine the checker ran 363 times in a day and could use the strong check
zero times. It answered "can't tell" on 92% of runs. That is the honest answer
to a question we had made unanswerable — it says nothing about the checker.

## Why the obvious fix would have made things worse

The obvious repair is "just name the files". I started to, and stopped, because
on this machine it would have produced the wrong kind of evidence:

- The jobs that always write a file are all switched off, so naming their
  files changes nothing.
- The jobs that actually run only write a file when there is something to
  write. The memory job writes only if it found a learning; the commitment
  job updates its bookmark only if it processed new messages. A quiet run is
  a correct run.

Naming those files would have marked every correct quiet run as a failure.
That would have made the checker's judgement look wrong for a mistake that was
entirely ours in how we set it up.

## What's new

The job now says what it did, and the checker verifies the claim.

A job can name a file as a *conditional* effect — one it produces only when it
did work. When the job does that work, it prints one line: `EFFECT:` followed
by the file. The checker then verifies that file really changed during the
run. A run that prints no such line is treated as a quiet run, which is fine.
A run that claims it updated a file that is missing or untouched is the
clearest possible sign of a job reporting success it did not earn — and
that is exactly the case the checker was built to catch, which until now it
could not see at all.

A job can only claim a file it declared up front. Printing other file names
does nothing except get counted, so a job cannot talk its way into looking
productive.

Two of the built-in jobs now declare their effect this way: the memory
reflection job (the memory file) and the commitment detector (its bookmark).

## Safeguards, in plain terms

- The checker still decides nothing. It records what it found; nothing is
  blocked, retried, or alerted.
- Uncertainty resolves in the job's favour. No claim means "quiet run", never
  "failed".
- The file paths are locked to the agent's own folder, exactly as before.
- Removing the declaration from a job returns it to today's behaviour. Nothing
  else changes.

## What to decide

Nothing blocks on you. The change is observe-only and reversible by deleting a
few lines. After it lands, the job trial restarts on a fresh clock so its
results are not mixed with the three days it could not judge anything.
