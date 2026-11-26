# ELI16 — the feedback sorter stopped after one slow answer

## The problem

Feedback reports pile up, and a model decides which of them are ready to become work.
The operator approved that model with a PIN. Two things then went wrong.

The first time it ran, one report title contained the word "execute" (it was naming a
setting). A safety check looks for words like that, in case someone hides instructions
inside a report. The check worked, but it then sent all 50 reports in the batch to a
human and never asked the model. So the run "decided" 50 reports and made none ready.

On the second run the model was asked. It needed more than the 20 seconds it was given,
so the call timed out. The system treated that one timeout like the model breaking the
rules, and switched the sorter off for good. Nothing has been sorted since.

A third problem was waiting. The approval was tied to a counter that goes up every time
the server restarts on the same computer. After any restart the approval would look
stale, and the operator would have had to approve again after every update.

## What this change does

- Only the report with the suspicious title goes to a human. The other 49 go to the model.
- The model gets 60 seconds. A timeout is tried again 15 minutes later. Only three
  failures in a row switch the sorter off. Real rule-breaking (a different model
  answering, or an answer in the wrong shape) still switches it off straight away.
- The approval belongs to the computer. Restarts on that computer keep it. If another
  computer ran the sorter, or the data was restored from a backup, a new approval is
  still required.

## What you need to do

Approve the sorter once more on the dashboard's Feedback Drain tab. The old version
already switched itself off, and only you can switch it back on. After that, restarts
won't need a new approval.
