# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

The feedback executor now finishes a confined command at its wall-clock or output limit even if a test child retains an output pipe. It kills the original process group, closes the local pipes, and records the limit failure. The related-test gate can run for 45 minutes; other individual test and gate commands keep their 20-minute limit. Native Windows execution remains unsupported.

## What to Tell Your User

A feedback fix that changes a central file can need a longer related-test run. That check now has a 45-minute limit. If it times out, the worker records a failure promptly instead of staying stuck in verification. Review and merge requirements still apply.

## Summary of New Capabilities

- Related tests have a bounded 45-minute window.
- Timeout and output-limit failures return promptly even when a test child keeps an output pipe open.

## Evidence

- A live SecretStore attempt reached the old 20-minute limit, but its child tests kept the executor stuck in verification until they were stopped separately.
- Focused executor tests passed 154/154, including ordinary and detached child pipe holders. Integration route tests passed 9/9 and E2E executor lifecycle tests passed 2/2.
- Independent review concurred after the resource-limit spec and escaped-child behavior were clarified. Full exact-head suite and CI remain required for merge.
