# Stop-check replay input: the plain version

## What this is

Whenever I try to end a session, a check called the stop check (the UnjustifiedStopGate) asks a model whether stopping is legitimate: work finished, a real error, a decision only the operator can make. It is the single largest model cost of this kind: about 8,400 calls and 165 million input tokens in the latest week. Most of its answers are an easy "yes, you may stop", which is exactly the kind of call a cheaper model (Jev) might handle.

To find out whether Jev could take the easy cases safely, we need to re-run old stop checks on Jev with exactly the same input the big model saw, and compare answers. Today that is impossible: each stop decision row in the local decision log keeps only a fingerprint of the stop reason, plus counts. The text itself is gone.

## What already exists

The local decision log already writes one row per stop check (about 300 are kept per day). It already has a special field, `_contentFull`, that stays on this machine only: it is removed before anything is shown over the API and is never copied to other machines. The completion-claim check uses that same field to keep its replay input (CMT-1679). The stop-check row also already keeps the first part of the model's answer, which holds its verdict.

## What is new

On development agents, each stop-check row now also keeps the stop reason, the recent turns and the evidence the check judged, in the machine-local field. Before storing, obvious secrets (keys, tokens, passwords in URLs) are scrubbed out of the stored copy only; the model still sees exactly what it saw before. The visible part of the row gains a fingerprint of the exact prompt, a fingerprint of the prompt rebuilt from the stored copy, and a yes/no saying whether the scrub changed anything. A helper rebuilds the prompt from a stored row and checks the fingerprint; a row that was cut short or does not match is marked "not replayable" instead of being quietly used.

## Safeguards

- Off on the fleet, so fleet rows are exactly as before.
- The prompt, model, timeouts, parsing and the continue/allow/escalate verdict do not change at all; tests compare verdicts with the switch on and off.
- The stored text stays on this machine, is never served over the API (a test checks that), and the normal 14-day cleanup removes it.

## What you need to decide

Nothing. The replay against Jev is analysis on the stored rows and reports back in the Jev review topic.
