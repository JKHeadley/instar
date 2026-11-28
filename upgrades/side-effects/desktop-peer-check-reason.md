# Side-Effects Review — Remote Desktop: the front logs why it could not check a peer

**Version / slug:** `desktop-peer-check-reason`
**Date:** `2026-11-27`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent review, 2026-11-27 21:37 PT — concur`
**Reviewer:** independent second-pass subagent (fresh context, given the code and the symptom); verdict concur, nothing blocking

## Summary of the change

Tier 1: 3 source files, 1 test file, about 25 lines. On 2026-11-27 the Studio front listed the Mama PC as "Could not check this machine's desktop" on every load. Meanwhile the Mama PC's own diagnostics said ready in 0.1 s, the Tailscale path was direct (Stewardship, 21:33 PT), and the Studio log had no line at all for the failure. The `/desktop/targets` catch in `routes.ts` now writes one `console.warn` per failed peer: the machine id, a fixed reason from the new `desktopPeerCheckReason` (`desktopPeerRopeFetch.ts`), and the milliseconds taken. `AgentServer.desktopProbePeer` now attaches the HTTP status to its existing `desktop-peer-unavailable` error, without changing the message. The reason is one of: `timeout` (TimeoutError or AbortError), `http-<100..599>`, the suffix of a `desktop-peer-*` code, `starting` (the peer says it is still booting), `reply-invalid` (an unreadable JSON reply), `connect` (a connect-class failure), `reset` (a socket reset or an undici header or body timeout), or `other`. Raw error text never reaches the log.

## Decision-point inventory

None. It is a log line on a path that already returned the same refusal.

## 1. Over-block

None. The returned row and its text are unchanged.

## 2. Under-block

None.

## 3. Level-of-abstraction fit

The reason mapping lives beside the rope fetch that throws these codes. The log line sits at the one catch that turns them into the user-facing sentence.

## 4. Signal vs authority compliance

A log line only. It decides nothing.

## 5. Interactions

`DesktopMeshBroker` matches on the message `desktop-peer-unreachable`, and that message is unchanged. The unavailable error keeps its message and only gains a `status` property. At most one line per peer (7 at most) per target-list load.

## 6. External surfaces

The server log only. No route, response or viewer text changes.

## 6b. Operator-surface quality

No operator surface changes. The list text stays "Could not check this machine's desktop. Select Check again to retry."

## 7. Multi-machine posture

Front-only: it logs the front's own view of each peer.

## 8. Rollback cost

A git revert. No state.

## Class-Closure Declaration

unbounded-self-action: closure n/a (negative declaration). A log line on a failure path a person triggers by loading the list. It adds no action, loop or retry.

## Second-pass review

**Reviewer:** an independent second-pass subagent (Claude, fresh context, given the code and the symptom) traced every throw site; verdict concur, nothing blocking.

An independent reviewer traced every throw site from routes.ts through fetchDesktopPeerOverRopes, poolPeerFetch and the reply parsing. The only consumer that matches on these messages, DesktopMeshBroker, is untouched. Every message the `desktop-peer-` pattern can match is a fixed string in our own code, and `status` is limited to an integer from 100 to 599. Verdict: concur. Taken from review: `starting` for PoolPeerBootingError, `reply-invalid` for a JSON parse failure, and `reset` for socket resets and undici header or body timeouts, which would otherwise have logged `other`. Accepted as is: a budget that runs out during connect checks logs `unreachable`, and the elapsed ms near 3000 tells it apart.
