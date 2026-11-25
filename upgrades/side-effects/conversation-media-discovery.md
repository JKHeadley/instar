# Attachment discovery side-effects review

Status: draft for independent review. The Tier 2 spec is awaiting convergence and approval. This document does not attest to a completed trace.

## Scope

This review covers the 19-path staged server and test patch with SHA-256 `e0686d999222dc39d1f64b6d9a92f736309b03941656af611c9ffb9a614b1a93`. The patch adds 1,427 lines and removes 18. It adds local App attachment browsing and exact-content reads behind an explicit opt-in. It includes neither browser sheet rendering nor search and preview delivery.

## Decision points and impact

- The route requires enabled App conversations, native media and attachment browsing. Browser and device allowlists recognize the two GET shapes. Live route admission still requires the owner. Older deployments or disabled features can return unavailable, which the client must handle without implying that a conversation is empty.
- Browse uses the current conversation and attachment references within a bounded scan. Cursors are scoped to the request. Captionless media can appear. Purged or inaccessible entries must disappear. An incomplete scan can omit older attachments.
- Exact content rechecks current authority and the exact reference before exposing bytes or range metadata. Revocation, conversation deletion, and reference purge during the asynchronous read boundary must return unavailable. The range policy supports valid partial responses and rejects unsatisfiable ranges after authorization.
- Only the exact GET shape receives the media timeout floor. This can retain a request longer than the general timeout. Exact reads use the media-read limiter, and content is served with shared media response headers. Review these integrations alongside the admission path.
- The slice uses existing local data and signing. It introduces no schema migration, peer transfer or preference migration. Remove the explicit opt-in to disable the new routes. No data cleanup is required by the setting change.

## Verification and remaining review

The corrected targeted integration run passed 13 browse and exact-content cases, including revocation, deletion and purge during lookup. Real Chrome passed one disposable signed transport and decode case with the feature initially off. The Chrome harness did not drive an attachment sheet, and the earlier lifecycle suite predates the final range correction. Full verification is pending.

The independent pass should review signed admission, authorization before metadata and streaming, timeout and limiter scope, and rollback with staged dependencies. Record the result after review. Generate the gate trace only when the spec and review prerequisites are satisfied and the artifact and exact implementation paths are staged together.
