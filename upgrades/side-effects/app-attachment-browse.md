# Attachment discovery side-effects review

Tier 2. The narrowed attachment browse spec is converged and approved. This review describes the staged server slice.

## Scope

This review covers the 24-path staged server and test patch with SHA-256 `4bf5d1ba932dcfbd57f31ea768a5c1e2094109e190b51e54a4aea65e4caa45ae`. The patch adds 2,019 lines and removes 40. It adds local App attachment browsing and exact-content reads behind an explicit opt-in. It includes neither browser sheet rendering nor search and preview delivery.

## Decision points and impact

- The route requires enabled App conversations, native media and attachment browsing. Browser and device allowlists recognize the two GET shapes. Live route admission still requires the owner. Older deployments or disabled features can return unavailable, which the client must handle without implying that a conversation is empty.
- Browse uses the current conversation and attachment references within a bounded scan. Cursors are scoped to the request. Captionless media can appear. Purged or inaccessible entries must disappear. An incomplete scan can omit older attachments.
- Exact content rechecks current authority and the exact reference before exposing bytes or range metadata. Revocation, conversation deletion, and reference purge during the asynchronous read boundary must return unavailable. The range policy supports valid partial responses and rejects unsatisfiable ranges after authorization.
- Only the exact GET shape receives the media timeout floor. This can retain a request longer than the general timeout. Exact reads use the media-read limiter, and content is served with shared media response headers. Review these integrations alongside the admission path.
- The slice uses existing local data and signing. It adds the derived `attachment_index_gaps` SQLite table through the existing idempotent schema setup. No conversation log is transformed and operators have no migration step. It introduces no peer transfer or preference migration. Remove the explicit opt-in to disable the new routes. No data cleanup is required by the setting change. Disabling browse does not undo the synchronous legacy catch-up reader’s bounded allocation and oversized-frame skips. Legacy catch-up can record gap markers with browse off.

## Verification and remaining review

The corrected targeted integration run passed 13 browse and exact-content cases, including revocation, deletion and purge during lookup. Real Chrome passed one disposable signed transport and decode case with the feature initially off. The Chrome harness did not drive an attachment sheet, and the earlier lifecycle suite predates the final range correction. Full verification is pending.

The independent pass should review signed admission, authorization before metadata and streaming, timeout and limiter scope, and rollback with staged dependencies. Record the result after review. Generate the gate trace only when the spec and review prerequisites are satisfied and the artifact and exact implementation paths are staged together.

## Over-block and resource bounds

Browse and exact content each admit one request per device and four per server. Saturated legitimate owners can receive 429. Browse can time out after two seconds and content after 120 seconds of handler work. Work that exceeds its response deadline retains its slot until cleanup. An unreturned OS open can therefore occupy a slot beyond the deadline. The separate 330-second middleware floor applies to the exact GET shape.

## Under-block and rollback

Signed device admission charges existing quotas before owner checks and the handler switch. Browse shares the general signed read quota. Exact content shares the ordinary media-read bucket, including its 120-per-minute limit. The allowlists, rate charges, exact GET timeout override and ordinary media header refactor remain when opt-in is removed. After the server observes the disabled setting, new responses stop. A stream whose headers were published before revocation or opt-out can continue until completion or its deadline. Reverting the patch removes these integration effects. Access denied for a non-owner and unavailable after deletion or purge retain distinct response statuses.

## Authority and machine routing

Existing live owner admission and the exact conversation and reference checks determine whether to return authorized metadata or bytes. A cursor or media hash is a selector. Neither is proof of authority. The routes read the connected server’s local replicated view and descriptor. Admission does not establish that the server is the current conversation holder. This slice adds no replicated cache, peer read path or new storage. A local server without an available blob returns unavailable, and the client must preserve that distinction.

## Review disposition

An artifact reviewer traced the staged authorization and raised the pre-handler off-state effects and permit cleanup findings above. They helped author the runtime, so an independent implementation concurrence is still outstanding. These findings change the draft review only.

The independent second pass flagged the local-replica wording and a size-bearing 416 before descriptor verification. The staged correction places the 416 after verification and the final authorization recheck. The regression simulates unavailable bytes for an otherwise authorized out-of-bounds range and expects 404 with no size. All 13 targeted integration cases passed in the configured dry-run admission posture. Independent second-pass concurrence was recorded for this staged digest. It covers the server slice and does not attest to browser sheet, updated lifecycle or full verification.

## Signed tokens and maintenance

The current slice requires the listed replica binding and an authenticated encrypted token for the exact selected occurrence before opening bytes. Both bindings are ephemeral and scoped to the live signed owner and chat. A restart invalidates them. Current admission and exact reference checks remain authoritative. A changed page is withheld. A retryable open deadline preserves the opportunity to retry without implying the file is gone.

The opt-in maintenance tick runs one background reconciliation operation per store with 1 MiB and 50-frame batch ceilings and a two-second stop-scheduling deadline. A pending operation retains ownership through cleanup. The readiness check does not run repairs. A new append on an opted-in store refuses an unreconciled tail so it cannot hide a gap. Legacy startup repair remains separate. The worker holds only offsets and file identity between oversized-frame batches. It advances the durable index and reports the skipped frame only when the terminating newline is found. A changed file or offset invalidates discard progress. Unfinished or unmeasurable data stays pending. Switching off the option suppresses future ticks and routes. A started operation remains bounded by its own batch and descriptor cleanup.

The earlier independent concurrence covered the earlier 19-path patch. The latest independent reviewer concurred with server digest `4bf5d1ba932dcfbd57f31ea768a5c1e2094109e190b51e54a4aea65e4caa45ae` after confirming exact Open readiness, reservation preflight, resumable discard and conservative incomplete coverage. The lifecycle and browser evidence have their own scope. The earlier Chrome transport evidence predates the current wire contract. Browser sheet, activation benchmarks and full verification are pending.

The exact Open path checks lag before opening and again before producing any range metadata or bytes. A pending durable purge or tombstone cannot be ignored by a token minted earlier. Reservation-based writes check for an unindexed tail before enqueuing replication. A skipped frame leaves a conservative durable coverage marker keyed by local log name, even when offsets are caught up. The marker contains no content. Rebuilding the same index retains that marker.

The revised server patch passed 32 focused unit cases, 17 signed HTTP cases and 8 production lifecycle cases under the configured dry-run admission posture. Regression coverage includes a multi-batch oversized frame, replay of an existing attachment token while a purge is waiting to be indexed, and rejection before replication reservation when the local index is behind.

## Full-verifier repair

The full verifier reproduced one failure in each of the maturation and mobile route inventory files. Register the approved default-off attachment preference with a named maturation entry and list both signed GET paths in the existing owner-only and conversation-reference test inventories. This repair changes neither the authorization rules nor the routes. The registry entry declares that aggregate evidence is still needed and leaves advancement under owner control. The exact merge tree used in verification reproduced all three failures before the repair and passed all 90 cases across the same files afterward.
