## What Changed

- The home screen now asks each machine only for its open alerts instead of its whole history, which was over a megabyte on one machine and made that machine miss the time limit.
- The dashboard home screen no longer says "part of the list could not be checked" when one machine misses a single refresh. For up to two minutes it shows that machine's last answer while it asks again; a machine that stays silent longer is reported as before.

## What to Tell Your User

The "part of the list could not be checked" message now only appears when one of my machines is really unreachable, not every time one is briefly slow.

## Evidence

- On a live agent the full pooled read missed the Laptop in 2 of 10 tries (it sent 1.5 MB of mostly closed alerts). Asking for open alerts only cut that to 140 KB and the read to 0.1–0.7 s. Unit tests cover the merge, the two-minute limit, and failures that name no machine.

## Summary of New Capabilities

None. This makes an existing message less noisy.
