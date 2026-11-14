# Three switched-off features now keep a record (ELI16 overview)

## What this is

Instar decides whether a new feature is ready by reading a log of what that feature actually did. Three features had no such record, so the review could only say "no data" about them, forever:

- **Benchmark divergence**, which compares how models really perform with what our benchmark predicted.
- **Dynamic MCP**, which loads and drops heavy tools for a session on demand.
- **Collaboration re-drive**, which nudges another agent that has gone quiet on shared work.

This change makes each one write a row when it acts, holds back or fails. Nothing about what the features do changes.

## What gets recorded

- **Benchmark:** one row per analysis pass. It reads "fired" if the comparison was usable and "held" if the benchmark data is out of date or a machine did not answer. The row names the data's date and the models compared. A crash writes "error".
- **Dynamic MCP:** "fired" when a load or drop completes, "error" when one was tried and did not finish. A request that changes nothing, or one waiting for approval, writes nothing.
- **Re-drive:** "fired" when a nudge goes to the relay, "error" when it could not be sent, and "held" at most once a day per reason when a cap or check stops one. The message text is never stored.

## Why the rows are limited

The review works out error rates by dividing errors by all of a feature's rows. If a harmless condition wrote a row every five minutes, a real 20% failure rate could look like 0.1%. So routine skips write nothing and repeating conditions write once a day.

## What this does not do

It does not turn anything on or move any feature forward. Dynamic MCP and re-drive stay off. Benchmark rows will not appear on Echo until its daily analysis job is switched on, and they will read "held" until someone refreshes the benchmark data, which is from July.

## Why it's safe

Writing a row can never break the feature, because a failed write only costs one sample. To undo this, revert the commit. Nothing needs cleaning up.

## What you need to decide

Nothing. It is recording only.
