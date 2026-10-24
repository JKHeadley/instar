<!-- bump: patch -->
## What Changed

- **The passkey health digest no longer posts when nothing needs a person.** The digest lists passkey cells that need a human, pending revokes, Chrome gate failures and a suspension. It also appended a line naming peers the pool could not read. When that peer line was the only content, the digest still counted as non-empty, so every change in peer reachability (a laptop going to sleep, a partitioned PC) re-posted a "Passkey health: 0 cell(s) need attention" item into the Attention topic. On the dev agent that was 147 of 341 Attention posts in three days. A digest whose only content is the peer line is now empty: nothing posts, and an already-open item resolves silently. When something real is listed, the peer line still appears beside it, as before.

## What to Tell Your User

The Attention topic stops getting "Passkey health: 0 need attention" messages. You'll only hear about passkeys when one actually needs you. Whether your other machines are reachable is still shown on the Machines dashboard tab.

## Summary of New Capabilities

None. This removes a noisy notification; no new capability.

## Evidence

- Dev agent (Mac Studio, Attention topic, 2026-10-20 to 2026-10-23): 147 of 341 Attention-topic posts carried `Source: passkey-health`, and the visible ones read "0 cell(s) need attention" with only the "Peers unobserved by the pool read path: Laptop (peer-offline), Mama PC (partitioned)" line.
- Cause: `buildPasskeyHealthDigest` set `body` non-empty whenever any line existed, including the unobserved-peer line, so `PasskeyDigestLedger.decide` returned `silent` (an upsert, which posts a message in the single Attention hub) on every peer change.
- New unit test in `tests/unit/passkey-cell-health.test.ts`: a peers-only digest is empty, decides `none` with no open item, and `resolve` when an item was open. File passes (11 tests).
