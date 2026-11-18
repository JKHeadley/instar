# Side-Effects Review — The restart census reads every machine (restart-lock-continuity A.4 follow-up)

**Version / slug:** `boot-census-pool`
**Date:** `2026-11-18`
**Author:** `echo (echo-machine-stewardship)`
**Second-pass reviewer:** `independent subagent (forwards an authenticated write to a peer)`

## Summary of the change

The spec names the stewardship job as the reader of every machine's census. The pool lists no peer addresses, so the job could not reach the other machines, and their census files could never be marked reviewed or pruned. This change fixes both:

- **`GET /sessions/boot-census?scope=pool`** returns this machine's census plus a `pool` block. The block reads each peer's own census through the existing bounded fan-out used by `/sessions/reaper`:
  - `readReaperPoolPeers`: a 5 s timeout, a 2 MB body cap, a depth cap, the credential URL allowlist, and every failed machine named;
  - `reaperPoolLimiter`: 6 per minute;
  - `reaperPoolHealth`.
  Without `scope` the route answers exactly as before.
- **`POST /sessions/boot-census/reviewed` with `machineId`** forwards the mark to that machine. It resolves the address the same way, refuses `url-rejected` and `no-known-url`, and relays the peer's answer. A mark is never applied locally for another machine. Without `machineId` (or with this machine's own id) the route behaves as before.

## Decision-point inventory

Forward a reviewed mark: invariant. It goes only to the named registered peer, at an address that passes the same credential allowlist the pool reads use. That peer applies its own `markReviewed`.

## 1. Over-block

None.

## 2. Under-block

A peer on an older build answers 404. The pool read reports it as `route-missing`, and a forwarded mark returns 404 with the reason.

## 3. Level-of-abstraction fit

The change reuses the existing pool fan-out helpers and address resolution. Nothing new for transport.

## 4. Signal vs authority compliance

Read-only, plus the one bounded write the spec already defines (marking reviewed), now applied by the machine that owns the file.

## 5. Interactions

The pool read shares `reaperPoolLimiter` with `/sessions/reaper?scope=pool`. The daily job makes one call.

## 6. External surfaces

- One query option.
- One optional body field.
- Peers receive an authenticated POST to their own existing route.

## 6b. Operator-surface quality

Not applicable: this surface is for the job.

## 7. Multi-machine posture

Proxied-on-read: the pool block is a merged read. Each machine's files stay machine-local, and marks are forwarded to the owning machine.

## 8. Rollback cost

Revert.

## Conclusion

A small follow-up. It closes the "every machine" reader the spec names.

## Second-pass review (if required)

Concur. No blocking defects. Its four minor notes are applied:
1. A forward that times out answers 504 `timeout`; any other fetch failure answers 502 `unreachable`.
2. A machine known to be offline is refused at once with 503 `offline`.
3. The pool-read callback has its own try/catch.
4. The test's allowlist parameter, which had no effect, is removed: plain http to 127.0.0.1 is a private host and allowed.

## Evidence pointers

- `tests/integration/boot-census-routes.test.ts`: 2 new cases.
  - A real local peer server answers the pool read, and a peer with no address is named `no-known-url`.
  - A mark for an unknown machine gets 404 and is not applied locally.
- Run in Local Verify only (the integration lane).
- `tsc` is clean.
