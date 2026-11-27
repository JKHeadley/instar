# Planned restart admission evidence

Tier 1 dark read-only checkpoint. The coordinator reuses the existing verified continuity file and exact last confirmed nonce. This requires a matching request, current holder/epoch, and sufficient remaining window. Role-change requests cannot present admission evidence here. No supervisor consumes it and no lease is extended by reading it. The future supervisor must authenticate and revalidate the exact current request and server boot immediately before shutdown.

## Class-Closure Declaration

- `unbounded-self-action` is not applicable. The checkpoint only reads evidence when called and initiates no restart or renewal.

The supervisor has an optional fail-closed evidence provider. When supplied, it runs at restart request consumption, after existing verification and expiry checks. The provider must authenticate the outgoing server and determine preferred-holder eligibility from current authority. Role-change and explicit bypass keep their original path. The integration substitutes a local provider and exercises the actual flag consumption path. No installed provider or config activation is added.

The installed provider is enabled explicitly with `multiMachine.takeoverReadyPool.plannedRestartLeaseContinuity.admissionEnabled`. The provider calls loopback with existing bearer and Lifeline proof. The route is read-only and returns the exact request identity. The supervisor re-reads the saved bytes after the bounded HTTP call. Unknown holder on the preferred machine fails closed, while a known different holder is not subject to the guard. Production config is untouched.

## Corrective revision, tier 2

Both restart consumers use the same lease decision. The foreground watcher calls it directly and the supervisor uses the authenticated local route. The consumers wait for confirmation before a guarded restart and report a failed admission after 15 minutes. The timeout retires the stale request while the server continues running. An operator may have to reissue an update or restart. Local Verify holds still take precedence.

The lease authority checks the exact request identity and nonce, rejects an invalid expiry, and requires time for the slower of the current and previous measured boots plus 30 seconds for shutdown and peer reconfirmation. It requires at least 60 seconds even after a fast boot. A different request observed on disk opens its own continuity episode. An acknowledgement that belongs to the superseded episode cannot confirm the replacement.

Lease evidence is an input to the restart decision. It confers no new serving authority and the local admission route cannot initiate a restart. In production, the existing opt-in determines whether this decision applies. Forced and role-change restarts retain their existing behavior.

The previous full review dissented because the foreground watcher could bypass the supervisor hold. The corrective revision has focused unit, integration and lifecycle evidence. The timeout is bound to the request contents and leaves the shared path intact. The server reports the timeout and the pending-status readers let a new request proceed.

## Second-pass review

**Reviewer:** Independent Codex reviewer restart_review

Concur with the corrected revision after re-review. The digest-keyed marker cannot overwrite another request's timeout status. The consumers and pending-status readers recognize terminal requests. The measured window and acknowledgement guards address the earlier findings. This was a read-only review. Local verification ran separately.

## Write-domain declaration

The local admission route now declares its read-only behavior for the write-domain conformance check. The declaration changes no runtime behavior or restart authority.
