# A helper machine's test result is signed, and its pass on main only goes so far

<!-- bump: patch -->

## What Changed

SEC-113. When Local Verify hands a verify to a peer machine, the peer now signs its answer with its machine key, over the request it ran and the result. The coordinator checks the signature against the key it has pinned for that peer, at its own receive time, on the raw answer and after the existing field checks. An answer that fails is refused and the verify runs on the coordinator; a peer with no pinned key is never sent work. This applies to PR and main verifies on peers.

A peer's green on main now has bounded authority (this part rides the existing `monitoring.localVerify.mainOnPeers` switch, off by default). It never becomes the isolation baseline and never writes flaky history. A second "not verified on this machine" clock that peers cannot move turns main suspect at most three hours after the first merge the coordinator has not verified itself. Main is routed back to the coordinator before that, at a refresh age derived from its own measured main durations, and a coordinator with no local green of its own keeps main local. If the coordinator's own run fails twice on the exact commit a peer called green, that peer stops getting main; a third machine is asked once, and only if it cannot settle it is the owner told, with a Clear button on the console.

## What to Tell Your User

- **Helper machines can't fake a passing test run**: "When another of my machines runs tests for me, it now signs the result, and I check the signature before I believe it. Even a signed pass on the main code only counts for a while before I check it myself."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Signed peer verify results | Automatic wherever peers are configured |
| Bounded authority for a peer's main green | Automatic with `mainOnPeers` on |
| Clear a helper machine kept off main | Console: Work, then Development, card "A helper machine no longer tests main" |
| Peer trust status | `GET /local-verify` → `peers.trust` |

## Evidence

- `tests/unit/local-verify-peer-signature.test.ts` (10): every refusal reason, a request loosened in transit, a key revoked before receipt, fields edited after signing, the signing module inside the verifier-version graph.
- `tests/unit/local-verify-peer-trust.test.ts` (12): holding continuity (restart keeps, gap of 2 resets, unreadable skips, null epochs), refresh age and routing, persistence.
- `tests/unit/localVerify/peerVerifier.test.ts` (115): signed import end to end with a real key; unsigned, wrong-machine, tampered and unpinned refused; version skew not counted against the peer; peer greens never become the baseline; the 3 h bound; the local corroboration run; same-head disagreement, arbitration and the owner clear; restart vs lease loss.
- `tests/unit/localVerify/quarantineClearRoute.test.ts` (6): operator session required, Bearer alone refused, 503 without the check, 409 on a standby.
