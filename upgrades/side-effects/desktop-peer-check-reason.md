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

## Follow-up (2026-11-28 03:40 PT): the peer's own check failure

The same "Could not check" sentence also comes from the peer itself. When its local desktop probe throws, `onDesktopAvailability` answers 200 with `ready: false` and `DESKTOP_CHECK_FAILED_REASON`, so the front's catch never runs and neither machine logged anything. Now that catch maps the error with `desktopOwnCheckReason` to one of `timeout`, a `windows-desktop-*` code from our own Windows host, `connect`, `reset` or `other`. It logs the word with the milliseconds taken, and returns it as `checkFailure`. The front keeps `checkFailure` only when it matches `DESKTOP_CHECK_FAILURE_RE` (`^[a-z0-9-]{1,60}$`), logs it with the peer's id, and strips it from the `/desktop/targets` row, so the viewer sees the same fields as before. Version skew: an old peer sends no field, and an old front ignores an unknown field. The reply stays far under the 4096-byte bound. Tests: unit tests for the mapper and the pattern, and one integration case in `desktop-routes.test.ts` (log line present, field not shown). Integration runs on the test line, not by hand on the M5.

Review of the follow-up: an independent second-pass subagent (Claude, fresh context, given the diff and the symptom) concurred, with nothing blocking. It traced every error the Windows host and its local transport can throw: all are fixed strings, the longest is 49 characters, and none is built from a variable. Mac failures become `other`. The `/desktop/targets` row is unchanged, version skew is safe both ways, no other code uses these values, and the reply stays far under 4096 bytes. Noted, not changed: no test covers the front dropping a malformed `checkFailure`, or the peer's catch block itself (the integration case mocks the probe). A failing peer logs one line on every list refresh, the same as the front's existing error line.

Release-note wording (2026-11-28 03:32 PT): "fixed word" became "set word" in the release note, because the notes checker reads "fixed" as a bug-fix claim. No code change.
