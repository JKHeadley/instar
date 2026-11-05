# Side effects: owner phone opens a Slack file held by another machine

Change: `GET /mobile/media/:sha256` takes an optional `machine` query. A named nonlocal machine streams the file for a current owner phone through `buildMediaHolderStream`; a bearer request with `holderHop=1` naming this machine is answered like a download.

1. Over-block: Range is refused for another machine's file, so a cut download restarts. An older holder is refused until it updates. MSP phones with a Slack grant stay local-only.
2. Under-block: bytes written before a revocation are not recalled, and about 200 ms of data can pass after it. A revocation after the last check, while the final chunk drains, is not covered, the same as a local download. The holder trusts a hop from any machine holding the agent bearer, the same trust every peer route has.
3. Level fit: the route owns the download checks, so the branch sits there. Transport stays in the pool fetch and URL guard. Owner admission is the shared helper, not a copy.
4. Signal vs authority: fixed owner, trust, ref and hash checks; no brittle judgment holds authority. See docs/signal-vs-authority.md.
5. Interactions: poolPeerFetch may try fallback ropes on a dead dial, each through the guard and the owner check. Slots are separate from the history read. The device rate limit on this route still applies. A holder without the file may answer 202 and start its normal copy.
6. External surfaces: new 403 `owner-only`, 409 `wrong-machine`, 416 `range-unsupported` and 502/503/504 holder codes on this route when `machine` names another machine. No change without `machine`. Slack rows in the new app download whole, local ones too.
7. Multi-machine posture: proxied-on-read through resolvePeerUrls; no state added.
8. Rollback: revert the commit; a remote file then fails as it does today.
