# Side-effects review — iMessage connectedAt is recorded, not synthesised

**Change:** `IMessageAdapter.getConnectionInfo().connectedAt` returned
`started ? new Date().toISOString() : undefined` — the time of the READ, never the time of the
connection. It now returns a value captured once at connect and cleared on stop.

**Decision point touched?** No. Status reporting only; nothing gates on this field.

---

## 1. Over-block

None — nothing is rejected or blocked. The only behavioural change is that a value which was always
populated-while-running can now be `undefined` in one new case: an adapter whose `started` flag is
true but which has not passed through `start()` in this process (not reachable through the public
API, since `start()` is what sets `started`).

## 2. Under-block

The field is now accurate about connect time but still says nothing about connection QUALITY — a
long-lived connection that has been failing to deliver reports the same timestamp as a healthy one.
Unchanged by this and not claimed.

Also unchanged: `lastError` and `reconnectAttempts` in the same object are still hardcoded
`undefined` / `0`. They are the same class of defect — fields that look informative and carry no
information — and are deliberately NOT fixed here, because inventing values for them would repeat
the error this change corrects. Named rather than silently left.

## 3. Level-of-abstraction fit

Correct: the adapter is the only thing that knows when it connected, so it is the only place the
instant can be recorded honestly. Nothing downstream can reconstruct it.

## 4. Signal vs authority compliance

Pure signal, unchanged in authority. It makes an existing signal truthful rather than adding one.

## 5. Interactions

No production consumer reads `connectedAt` — verified by grep across `src/`; the only references are
comments in `userChannels.ts` and `routes.ts` explaining why the channel-registry row deliberately
does NOT use it. Those comments remain accurate: the row is built on `state`, which is the right
liveness signal regardless of this fix.

`ConnectionInfo.connectedAt` is already optional in the type, so returning `undefined` when not
connected requires no type change.

## 6. External surfaces

None directly. The value appears in whatever surfaces render `getConnectionInfo()`. Anything that was
displaying it was displaying fiction; it will now show a real instant or nothing.

## 7. Multi-machine posture

Machine-local by design and inherently so: the adapter and its backend run on one host, and a
connection instant is a fact about THIS process. There is no state to replicate and a cross-machine
view would be meaningless — another machine's connect time says nothing about this one's.

## 8. Rollback cost

Trivial: restore the inline expression and drop the field. No persisted state, no schema, no
migration. Rolling back restores a fabricated timestamp, so it should carry a reason.
