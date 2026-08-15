# Side-Effects Review — operator replies claim the interactive spawn reserve

**Version / slug:** `tone-gate-interactive-lane`
**Date:** `2026-08-15`
**Author:** `Instar-echo`
**Tier:** 1 (one derived field on one existing call; no new capability, no new authority)
**Approval:** operator-approved via Observer 1 relay, and deliberately split out of the
Window 17 enrolment/swap build so the relief can merge and deploy on its own.

## Summary of the change

`MessagingToneGate` claims the host spawn cap's reserved *interactive* lane only when
its context carries BOTH `recipientClass === 'operator'` AND `synchronousReply === true`.

The reply route already computed and passed `recipientClass`. **Nothing anywhere ever
set `synchronousReply`** — so `interactiveLane` was permanently false, the reserved
slots were never claimed, and operator replies competed with background work for the
general cap.

This derives it at the one place that already knows:

```ts
synchronousReply: (options.messageKind ?? 'reply') === 'reply',
```

Absent means `'reply'` — this file's own existing convention (`kindForSignals` resolves
it identically, and the route documents "absent → 'reply'"), and it is the common case:
an ordinary conversational reply carries no explicit kind.

## Why it matters (observed, not theorised)

Degraded background calls each hold one of 8 host spawn slots until timeout. With the
lane unclaimed, the outbound gate is just another background competitor — and it fails
CLOSED when it cannot get a slot. During a live operator demo, sends were refused **12
times in ~15 minutes**, with the limiter reporting `interactivePriority {enabled: true,
ri: 2, rb: 2}` and `liveInteractive: 0` throughout: two slots reserved, zero used.

## Decision-point inventory

- **Spawn-cap lane selection** — *now reachable*. The mechanism, its allowlist and its
  reserve already existed and were enabled; this supplies the missing input.
- **Tone verdict / message allow-or-hold** — *untouched*. Lane is capacity routing. The
  review, its verdict, and every fail-direction rule are unchanged.
- **Authorization** — *untouched*. Nothing here grants a permission.

---

## 1. Over-block

None. Nothing is newly refused. The change can only move a review from a contended
queue to a reserved one; a review that would have passed still passes.

## 2. Under-block

- **A reserve of 2 is not immunity.** Three simultaneous operator replies still contend.
  This removes a structural starvation, not queueing in general.
- **It does not fix the underlying degradation.** Background calls still hold slots for
  their full timeout; that is what the Window 17 build addresses. This protects the
  operator path while that lands.
- **`messageKind` is caller-supplied.** A caller could label a proactive send `'reply'`
  and claim the reserve. Bounded by the pre-existing allowlist (only two components may
  claim it at all) and by `recipientClass`, which is derived from the verified-operator
  store rather than from the request.

## 3. Level-of-abstraction fit

Correct layer. The route already classifies `messageKind` and already resolves
`recipientClass`; the derivation sits beside them. Adding a parameter would push the
classification onto every caller and make the unsafe value the easy default — here the
safe value (background) is what every other path gets for free.

## 4. Signal vs authority

Pure capacity routing. It holds no blocking authority and changes no verdict.

## 5. Interactions

- The interactive allowlist (`MessagingToneGate`, `MessageSentinel`) is unchanged, so a
  stray `lane:'interactive'` elsewhere is still downgraded to background.
- The reserve is symmetric (`ri`/`rb`): interactive claims cannot starve background —
  background keeps its own reserved share.
- No interaction with the advisory-migration or fail-closed paths; those read the
  verdict, not the lane.

## 6. Multi-machine posture

**Machine-local by design.** The spawn cap is a host-local semaphore over processes on
one box. Nothing replicates, nothing is proxied on read, no generated URL, nothing to
strand on topic transfer. Each machine protects its own operator path.

## 7. Failure modes

- Interactive priority disabled on the semaphore → `resolveLane` returns background;
  byte-identical to today.
- `messageKind` absent → treated as `'reply'` (the documented convention).
- Non-operator recipient → background, whatever the kind.

## 8. Rollback cost

Delete one line. No config key, no data, no schema, no migration, no agent state.

## Evidence

4 integration tests driving the REAL route through the REAL gate — deliberately the
integration tier, because the unit tier cannot see this defect: the gate's lane logic
was already correct and already tested, and what was broken was the WIRING.

- an operator reply is marked `lane: 'interactive'`;
- **CONTROL** — an `automated` send is NOT (else the reserve would be meaningless);
- **CONTROL** — a non-operator recipient is NOT, even for a reply;
- the message still sends (the lane is routing, not a verdict).

**Shown capable of failing:** forcing `synchronousReply: false` — the exact pre-fix
behaviour — fails precisely the one assertion that the reserve is claimed, and leaves
the three guard tests passing.

**A defect this test caught in its own fix:** the first implementation used
`messageKind === 'reply'`, which silently excluded the common case where an ordinary
reply carries no explicit kind. The integration test failed on it. A gate-level unit
test would have passed.

**Still to prove empirically at deploy:** `liveInteractive` non-zero on the running
server. Merged is not running — that measurement is reported separately, from the box.
