## What Changed

- The dashboard home screen no longer says "part of the list could not be checked" when one machine misses a single refresh. For up to two minutes it shows that machine's last answer while it asks again; a machine that stays silent longer is reported as before.

## What to Tell Your User

The "part of the list could not be checked" message now only appears when one of my machines is really unreachable, not every time one is briefly slow.

## Evidence

- On a live agent every machine answered the pooled read in under a second, so the message came from single missed reads. Checked on the preview by forcing one refresh to come back incomplete: Home kept the full list and did not show the warning. Unit tests cover the merge, the two-minute limit, and failures that name no machine.

## Summary of New Capabilities

None. This makes an existing message less noisy.
