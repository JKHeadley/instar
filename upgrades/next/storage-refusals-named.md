<!-- bump: patch -->

## What Changed
Disk-space and storage errors now identify the machine by its nickname. This covers app and platform attachments, upload staging, cross-machine copies, paste limits, install/browser disk preflight, existing health checks, ledger and notification storage notices, workspace disk limits, and shared filesystem/database error reporting. If a machine has not been enrolled or its registry cannot be read, errors use its host name. Existing thresholds, retries, error codes and notification deduplication are unchanged.

## What to Tell Your User
A storage refusal now says which computer needs attention, for example “Mac Studio is nearly out of disk space, so the file wasn't stored.”

## Summary of New Capabilities
No new capability or scheduled job. Existing storage diagnostics now name their machine.

## Evidence
Regression tests cover the original paired-phone refusal through AgentServer, named capacity errors, paste and state-directory errors, nickname changes, unreadable registry fallback, health-script output, shared degradation records and generic HTTP errors without raw-path leakage.

Final verification covers main's new skill-learning forwarding and recovery setup routes. Local storage failures name the failing computer; recovery keeps sanitized codes and private exception details, and forwarded peer errors keep their origin.
Storage names also cover signed-phone team-action failures and assembled session-creation error replies. Private exception details and signed approval requirements are preserved.
