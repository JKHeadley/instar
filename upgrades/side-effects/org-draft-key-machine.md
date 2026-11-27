# Organization policy draft and publish placement

This Tier 2 correction implements the approved org-members-and-keepers “Multi-machine” section and org-pack-and-join §A. It touches two existing handlers in one source file and adds focused tests at three tiers. It introduces no routes or new trust relationships. The existing approved specification had six review rounds. The implementation has one local review pass.

## Decision and authority

An administrator prepares a draft with the agent bearer. An owner authorizes publishing through a signed device request. The publisher's current policy and signing key establish local ownership. A publication announcement or startup catch-up from a same-agent peer identifies the publishing computer on the receiving machine. A fresh installation with neither a local record nor a peer marker can draft and publish its first policy. This is deterministic application state under the signal-versus-authority principle in docs/signal-vs-authority.md.

## Over-block and under-block

A locally recovered publisher retains precedence over an older peer marker. A keeper who drafts a proposal from a remote organization's verified base still follows the keeper flow. A stale marker on a computer that lost its publishing peer can direct the person to an unavailable computer. Before the first peer publication announcement arrives, the local agent has no way to know where the new organization lives. The existing mesh startup catch-up supplies that information later.

## Interactions and placement

Both routes use the same placement decision. A bearer still receives 403 when trying to publish because the owner-device check happens before placement is disclosed. The publish check runs under the existing publish lock. It also applies to a still-valid draft saved before the publisher announcement. The existing read-back, recovered-policy and stale-base checks continue at the publisher.

## External and multi-machine effects

A peer returns 409 with org-key-elsewhere. It provides machineId and a human-readable direction when the marker contains an identifier. Older unnamed markers and a published record lacking its local key get a generic direction. No keys, request bodies or policies travel across the mesh in this correction.

## Rollback and verification

Revert this change to restore the earlier draft and publish handling. The change writes no new state format and needs no migration. Unit tests exercise a peer with an unnamed marker, an earlier draft and keeper mode. The two-server integration test covers the original publisher, a marked peer, signed publication, rejected bearer publication and a stale marker after key recovery. The production initialization E2E test hits the authenticated draft route on a marked peer.

## Independent review

The Easy Setup project owner reviewed the route diff and this artifact and concurred with the scoped placement decision. Preparing a keeper draft validates the remote base. The keeper's actual authority is checked when proposing the change. The ordinary first publish can still start on a new computer, a recovered local key wins, and a marked peer receives the direction to the publisher even when it has an earlier draft.
