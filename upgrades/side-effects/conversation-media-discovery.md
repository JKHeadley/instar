# Attachment discovery side-effects review

Status: draft for independent review. The Tier 2 spec is awaiting convergence and approval. This document does not attest to a completed trace.

## Scope

This review covers the 19-path staged server and test patch with SHA-256 `4a65c533e63d5f6dbf4e3b3918e3601a26482181bb66e79a3f262ac3146fb957`. The patch adds 1,433 lines and removes 18. It adds local App attachment browsing and exact-content reads behind an explicit opt-in. It includes neither browser sheet rendering nor search and preview delivery.

## Decision points and impact

- The route requires enabled App conversations, native media and attachment browsing. Browser and device allowlists recognize the two GET shapes. Live route admission still requires the owner. Older deployments or disabled features can return unavailable, which the client must handle without implying that a conversation is empty.
- Browse uses the current conversation and attachment references within a bounded scan. Cursors are scoped to the request. Captionless media can appear. Purged or inaccessible entries must disappear. An incomplete scan can omit older attachments.
- Exact content rechecks current authority and the exact reference before exposing bytes or range metadata. Revocation, conversation deletion, and reference purge during the asynchronous read boundary must return unavailable. The range policy supports valid partial responses and rejects unsatisfiable ranges after authorization.
- Only the exact GET shape receives the media timeout floor. This can retain a request longer than the general timeout. Exact reads use the media-read limiter, and content is served with shared media response headers. Review these integrations alongside the admission path.
- The slice uses existing local data and signing. It introduces no schema migration, peer transfer or preference migration. Remove the explicit opt-in to disable the new routes. No data cleanup is required by the setting change.

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

The independent second pass flagged the local-replica wording and a size-bearing 416 before descriptor verification. The staged correction places the 416 after verification and the final authorization recheck. The regression simulates unavailable bytes for an otherwise authorized out-of-bounds range and expects 404 with no size. All 13 targeted integration cases passed in the configured dry-run admission posture. Concurrence on the revised patch is pending.
