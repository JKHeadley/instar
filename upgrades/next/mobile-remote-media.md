## What Changed

Adds owner-only downloads of Slack attachments held by another registered machine through the existing mobile media route. Both machines need this release. Sends and uploads are unchanged.

## What to Tell Your User

Your phone can open files in a Slack conversation that lives on another of your machines. Both machines need this update. Sending files there still needs that machine.

## Summary of New Capabilities

The owner's phone downloads a Slack file through the machine it is connected to, from the machine that holds it. Download only, whole file, owner only.

## Evidence

Before this fragment correction, exact commit fc8217683 had clean typecheck, 38 unit tests, 22 integration tests and one alive E2E test reported passing. Local Verify later returned to pending, so its earlier success is not a standing gate. Rerun required validation on the final commit after the admission dependency lands and the branch is rebased.
