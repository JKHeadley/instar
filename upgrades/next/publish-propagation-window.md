# npm publish check tolerates slow registry visibility

<!-- bump: patch -->

## What Changed

The post-publish smoke check now retries for up to 45 minutes while a newly published package becomes visible in npm, with a progress line about once a minute. It still clean-installs the exact published version and checks the CLI version before passing.

## What to Tell Your User

A slow npm registry should no longer make a successful Instar release look failed. The release check keeps retrying and shows its progress; no action is needed from you.

## Summary of New Capabilities

The release pipeline distinguishes a delayed registry listing from a failed package install for a longer bounded period.

## Evidence

The 1.3.1528 and 1.3.1529 publish jobs accepted their packages but hit the previous 15-minute visibility deadline. The smoke script syntax and focused test pass; the next publish workflow is the consumer check.
