# The organization admin steps get their own speed limit (ELI16)

## What was wrong

The phone app talks to the agent with signed requests, and every kind of request has a speed limit so a stolen or buggy device can't hammer the agent. The organization screens share these limits in groups called buckets. The steps that confirm members, bring keepers back and handle a recovery copy were in the same bucket as publishing the policy, which allows five requests a minute.

When the merge line checked this pull request, the recovery test publishes the policy several times and then does the recovery steps. Together they ran past five a minute, so the agent answered "too many requests" (429) and the test failed. A real admin cleaning up after a recovery could hit the same wall.

## What changed

Those admin steps now have their own bucket, called org-admin, with ten requests a minute. Publishing keeps its own five. Nothing else about the limits changed.

The test also had a gap the 429 had been hiding: it expected a member's agent to hold version 5 of the policy, but never ran the member's update check. It now runs it (and accepts the update when it is held for the person), the same way the join test does.

## Evidence

tests/integration/org-recovery-copy.test.ts passes (1 of 1).
