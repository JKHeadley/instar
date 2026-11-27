---
title: "Owner phone opens a Slack file held by another machine"
slug: "mobile-remote-media"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "docs/specs/mobile-remote-media.eli16.md"
approved: true
approved-by: "echo, assigned by coordinator session for topic 137342 under Justin's approval of Conversations build through deploy (2026-11-05 00:37 and 00:58 PST)"
review-convergence: "2026-11-06T02:13:26.755Z"
review-iterations: 3
review-completed-at: "2026-11-06T02:13:26.755Z"
review-report: "docs/specs/reports/mobile-remote-media-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Owner phone opens a Slack file held by another machine

## Problem statement

PR 2799 lets the owner's phone read a Slack conversation held by another machine, but a file in that conversation still fails. The row names a blob on the holder's disk, and `GET /mobile/media/:sha256` on the machine the phone is paired with answers only for what it holds.

## Proposed design

Same route, same device allowlist rule, no new route. An optional `machine` query is added, covered by the device signature.

On the machine that answered the phone, when `machine` names another machine:

1. Only a `slack:` ref and a valid hash go further; anything else is 404.
2. `mobileOwnerDeviceAdmission` (from the signature that admitted this request) must answer, else 403 `owner-only` with no dial. An MSP phone or a bearer token never dials.
3. A `Range` header is refused with 416 `range-unsupported`.
4. `buildMediaHolderStream`: holder by exact machine id from `resolvePeerUrls` (409 `wrong-machine` if unknown), `isPeerUrlAllowedForCredentials`, at most 6 streams at once and 2 per holder, separate from the history read's slots. When full, it answers the 202 `fetching` wait the app already polls, with a 5 s retry, not a failure. After 60 s of that the phone says "Still copying from another machine. Tap to retry.", which is inexact for this case. File downloads count in their own 120-a-minute `media-read` bucket, so waiting files cannot use up chat reads.
5. `poolPeerFetch` with the agent bearer, `redirect: 'manual'`, GET, carrying `holderHop=1` and the exact ref and machine. `isCurrent()` runs inside the fetch, so before every rope dial.
6. After 60 s blocked on a phone that is not draining, a stream is classed waiting-on-phone. That is not proof the phone is idle or of any byte progress: a server cannot see into the kernel's buffers, and on macOS loopback a phone reading steadily at 8 KB/s showed no drain and no change in the write queue for 47 s, the same as a suspended one. The stream is not cut. It takes a quiet slot before giving up its runnable one; with no quiet slot free it keeps the runnable one and tries again. Quiet slots are 2 in all and 1 per holder, across every device, so at most 8 streams are open in all and 3 per holder, each counted until it ends. Past that the phone gets the busy 202 answer. A stream keeps a quiet slot until it ends, even if the phone resumes. A file that needs more than 300 s is not supported: it fails at the deadline, and the phone starts again from the beginning, up to its three tries, then says "The agent could not be reached. Tap to retry." Three MiB at 8 KiB/s, about 384 s, is such a file. A longer deadline or resume needs its own review. A limit that ends the stream while it waits on the phone is not reported against the holder, and a phone hanging up or being revoked is never recorded as a failed road to it.
6a. Limits: 15 s to the first byte, 20 s between holder bytes, 300 s overall, with the route's own timeout set past that to 330 s, `MAX_FILE_BYTES` (50 MiB) whether or not a length was declared.
7. Bytes stream through with backpressure: one chunk is deliberately withheld, on top of the transport's own bounded buffers, and the file is never held whole. `isCurrent()` is read before the first byte, immediately before every write to the phone, on a 200 ms timer throughout, whether bytes are moving or not (a stalled holder or a phone that stopped reading included), and again before the last chunk. A check that fails or throws aborts the holder read and breaks the phone's connection. An empty chunk from the holder is skipped: it neither counts as progress for the idle limit nor takes the withheld chunk's place. The last chunk is held until the running sha256 matches the requested hash and any declared length matches, so a bad, short or revoked stream ends as a broken connection and never as a complete response.
8. Type and file name are recomputed here (`isInlineSafe`, `safeFileName`) and the fixed security headers set; nothing else from the holder passes. Refusals map to fixed codes.

On the holder, `holderHop=1` is honored only for the agent's own bearer (`bearerMatches`), a request naming this machine, and a `slack:` ref. It then runs the ordinary checks: the conversation is held here and this hash is referenced by that exact conversation. It never reaches the remote branch, so a holder cannot forward the request again. When the blob is absent, the ordinary path runs `rep.canFetch` and may run `rep.want`, answering 202: this is cache hydration, a scoped side effect of the download under the existing quota, reference and purge controls. The hop is therefore not a pure read, and this design does not promise no replication. `Range` is refused. After the last byte of a hop reaches its kernel, the holder keeps that socket open for up to 330 s instead of its 5 s keep-alive, because a slow phone may still be reading the tail through the near machine; only hops get this, only on a server that keeps idle sockets at all (keepAliveTimeout above 0; anything else leaves the policy alone), and only while no later response owns the socket (a pipelined response queued behind a hop keeps its own timeout), and a global timeout change would touch every route. The response carries `x-instar-holder-media: 1`; an older holder answers 403 and the phone is told it needs updating.

This widens what the agent bearer reaches: before, a bearer could not download from this route; with `holderHop=1` it reads any file a Slack conversation held here references. The bearer on the holder is accepted, by coordinator decision, as peer authorization: it proves a trusted agent machine, not a phone or a human owner. The holder cannot tell whether an owner phone is behind a hop. The bearer is already the agent's full peer credential, including the Slack history hop.

The holder's checks are static: they run once at request start and are not re-read before or during the bytes. All live owner gating is on the near machine. A revocation reaches the holder only when the near machine aborts and the response closes. This design makes no claim of containment if the near machine is compromised, and the holder has no independent owner stop.

Limit: when the holder declares no length, the near machine ends the response by chunked encoding. An HTTP/1.0 client has no chunked encoding, so for it the end of a broken stream looks like the end of the file. The app speaks HTTP/1.1 or later and checks the hash itself.

A 403 on a hop reads as `holder-outdated`. It can also mean a stale peer address reached a different machine, so that wording may mislead in that one case.

Naming this machine, or naming none, is the existing local path, Range included.

The app passes `ChatTarget.machine` through `AttachmentView` to `MediaRequest`, signs the exact query on its paired host, asks for the whole file, and caches under a name derived from agent, holder, ref and hash. It never resumes a holder download; anything short of a hash-verified file leaves nothing behind. Slack rows held locally take this same whole-file path and lose resume, because the app knows the row's machine but not which machine its paired host is.

## Decision points touched

| Decision point | Classification | Why |
|---|---|---|
| Forward only for a current owner device | invariant | Authority must not depend on judgment. Reread before every dial, the first byte, during the stream and before the last chunk. |
| Holder chosen from the trusted peer list | invariant | No request input can name a URL. |
| Holder honors a hop only for its own bearer, naming itself, on a Slack ref | invariant | Fixed rule; failing it is the normal device gate's refusal. |
| Exact ref and hash on the holder | invariant | The existing download check, unchanged, runs before any byte. |
| Hash and length must match before completion | invariant | A fixed integrity check; failure breaks the connection. |

## Verify the state, not its symbol

- Symbol: `x-instar-holder-media: 1`. State claimed: the holder is new enough to have applied the hop rule. It is a compatibility mark from a trusted peer, not proof; the rule rests on the trusted holder's code and the two-server tests. Unmeasurable (missing header): refused as `holder-outdated`.
- Symbol: `isCurrent()`. State claimed: this phone is the owner's now. Corroboration: it rereads the device store, key ledger and person record, and compares them to the identity from this request's signature. 200 ms is the nominal polling interval, subject to scheduling and buffered bytes. Bytes already written are not recalled. The last check before the final chunk is the completion authorization point: a revocation after it, while that chunk drains, is not covered, the same as a local download.
- Symbol: a complete response. State claimed: this is the file. Corroboration: sha256 over every byte, on the proxy and again on the phone. This proves content, not which authorization checks ran.

## Multi-machine posture

Proxied-on-read through the trusted peer list. The feature exists to cross machines. No state is added and nothing is stored on the proxy.

## Maturation plan

No flag, by design: an existing route answers one more case for the owner's phone only, and a revert is the whole rollback.

- **test-agent-live:** the integration suite here runs two real servers with real blobs, and the e2e test boots a real AgentServer.
- **dev-agent-live:** after release, open a Slack file held by another of Echo's machines from a device-signed request and record PASS or FAIL, with a health check beside it. Coordinator 137342 owns activation.
- **fleet:** rides `mobilePairing.enabled` and media; both machines need this version, and an older holder answers `holder-outdated`.
- **graduation criterion:** one week after release, `MobileMediaHolderProxy.stream` degradation reports show only real outages, and Justin has opened a remote Slack file on the phone.
- **dark-window:** none: the route is live on release.
- **ladder:** mobilePairing

## Frontloaded Decisions

- Streaming through was chosen over pulling the blob through the replicator and serving it locally. That would give Range and a hash check before the first byte, but it stores a copy of a conversation's file on a machine that does not hold the conversation. The coordinator set streaming.
- Range is refused for now, as the coordinator set. Cheap to change after; the app sends none. Large files therefore restart from the beginning if cut.
- MSP phones with a Slack grant stay local-only, matching the history route.
- Uploads and sends to a remote row are out of scope and stay refused.

## Open questions

None.
