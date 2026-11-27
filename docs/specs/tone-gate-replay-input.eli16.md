# Tone gate replay input: the plain version

## What this is

Every message I send to a person first passes the tone gate (the MessagingToneGate). A fast model reads the draft and decides whether it goes out or comes back to me. It is the most frequent model decision I make, about 90 a day on the Studio alone. Justin's benchmark plan asks us to capture each such decision in full, replay it exactly, and have the strongest models grade it, so we can tell when a wrong call was the prompt's fault and when it was the model's.

Today that cannot be done for the tone gate. Each decision row in the local decision log keeps only a fingerprint of the draft and some counts. The prompt also contains up to ten recent messages and a random marker string, and neither is kept, so even with the draft in hand the exact prompt cannot be rebuilt.

## What already exists

The local decision log already writes one row per tone-gate decision (up to 500 a day are kept). It already has a special field, `_contentFull`, that stays on this machine only: it is removed before anything is shown over the API and is never copied to other machines. The stop check started keeping its replay input in that field yesterday (CMT-2204), and this change follows the same pattern. The row also keeps the first part of the model's answer, which holds its pass or block verdict.

## What is new

On development agents, each tone-gate row now also keeps the parts the prompt is built from: the draft, the recent messages, the signal sections and the random marker, all in the machine-local field. Before storing, secrets (keys, tokens, passwords in links) are scrubbed out of the stored copy only, by the same scrubber the tone gate already uses for message bodies. The model still sees exactly what it saw before. The visible part of the row gains a fingerprint of the exact prompt, a fingerprint of the prompt rebuilt from the stored parts, and a yes/no saying whether the scrub changed anything. A helper rebuilds the prompt from a stored row and checks the fingerprint. A row that was cut short or does not match is marked "not replayable" instead of being quietly used.

## Safeguards

- Off on the fleet, so fleet rows are exactly as before.
- The prompt, model, parsing and the pass/block verdict do not change at all; tests compare verdicts and prompts with the switch on and off.
- The stored text stays on this machine and is never served over the API (a test checks that). Each capture is at most 40,000 bytes, and rows are deleted after 14 days.

## What you need to decide

Nothing. The replay and the two-judge grading are analysis on the stored rows and report back in the benchmark topic.
