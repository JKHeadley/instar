# Exact App message link side effects

## Decision and authority

A locator and its history are private read projections. The current conversation and per-message access policy remain the decision authority. Each signed request starts with the identity authenticated for that request. Context scans recheck that identity, the boundary, returned messages and the look-ahead row before returning. The paired HTTPS address identifies a route and grants no permission. The response identifies the serving machine as provenance.

## Data and resource effects

Both reads are default-off. They perform indexed local reads with a bounded chunk size and a shared in-flight budget for context scans. They do not change messages, grants, replication, read positions or local data formats. The dashboard suppresses read reports and latest polling for the linked view. It writes to the clipboard only after a validated reading of the selected target.

## Rollback and verification

Set `mobilePairing.native.messageLinks.enabled` to false. An earlier server lacks both the versioned entry and the exact context endpoint. Ordinary history and legacy pin navigation still use their established paths. Focused store, browser, signed HTTP and production wiring tests are the evidence for this build. The denied fixture uses the router's ACL seam, and the missing fixture represents a target absent from the serving copy. Real Chrome compatibility, peak scan timing and full verification remain required before activation.

## Review

Chief of Staff ended design review after the seventh round and authorized a dark runtime build. That round's findings were resolved through a dedicated API route, documented held-history semantics and existing pin navigation with the feature off. A runtime review is still required for a final release disposition.

## 6b. Operator-surface quality

Copy Message Link is in the existing message options beside Pin. The linked view names its current state in plain language and offers a direct route back to the latest messages. A busy read preserves the current linked window and offers a retry. The interface displays no event IDs, cursor fields, access records or raw errors, and adds no destructive control. The copy action and context recovery use the same controls at phone width. Visual acceptance in real Chrome remains pending.

## Framework generality

The feature uses existing signed-device and agent bearer authentication and the shared App conversation store. It depends on no agent framework or model provider. Apple consumes the same exact history and locator responses as the dashboard.
