# Side-Effects Review — ASP classifier honours the direction flag

**Version / slug:** `asp-direction-flag`
**Date:** `2026-08-15`
**Author:** `Instar-echo`
**Tier:** 1 (small, low-risk correction to just-shipped behaviour; no new capability)

## Summary of the change

`AspInboundClassifier` declared `fromUser` in its input type and `server.ts`
passed it, but the classifier never read it — the identifier occurred exactly
once in the file, in the type declaration. Because `onMessageLogged` carries
BOTH directions, the classifier therefore also classified this agent's own
outbound messages and wrote ledger rows for them.

Now: an entry explicitly marked `fromUser === false` is skipped and counted in a
new `counters.skippedOutbound`. Everything else is unchanged.

**How it was found:** by reading the live deployed surface, not by a test. A real
ledger row's `bodyBytes` matched an outbound message the agent had just sent.

## Decision-point inventory

- **What gets recorded** — *narrowed*, deliberately. Outbound rows stop being
  written. This is the entire point.
- **Classification logic** — *untouched*. No verdict changes for any message that
  is still classified.
- **Message delivery** — *untouched*. Still chained, still swallows everything,
  still cannot block, delay, rewrite or drop a message.
- **Authorization** — *untouched*. The verdict still carries no permission, role
  or trust field.

---

## 1. Over-block

The one new refusal is "skip an explicitly outbound entry". The risk of an
over-broad skip — silently recording nothing at all — is held off by two things:
the skip triggers ONLY on an explicit `false` (an absent flag still classifies,
so it fails toward recording), and a paired control test asserts the same bytes
marked inbound are still classified and recorded.

## 2. Under-block

- **Outbound provenance is now unrecorded entirely.** If we later want proof of
  what this agent itself signed on the way out, that is a separate feature with
  its own record; it is not smuggled in here.
- **A caller that omits `fromUser` still gets both directions.** Deliberate: the
  alternative (defaulting to skip) would silently disable provenance for any
  caller that never learned about the flag. Fails toward recording.

## 3. Level-of-abstraction fit

Correct layer. The class is named for inbound and is documented as inbound; the
seam it attaches to is bidirectional. Filtering belongs at the consumer that has
the narrower contract, not in the shared seam that legitimately carries both.

## 4. Signal vs authority

Unchanged and still signal-only. This narrows what a recorder writes; it holds no
blocking authority and gates nothing.

## 5. Interactions

None. No other consumer reads `counters` or the ledger (verified by search when
the parent feature landed: four references outside the ASP modules, two comments
and two wiring lines). Adding a counter field is additive.

## 6. Multi-machine posture

**Machine-local BY DESIGN**, unchanged from the parent feature. The ledger and
nonce store are per-machine files; nothing replicates, nothing is proxied on
read, no user-facing notice, no generated URL. A message is classified on the
machine that received it.

## 7. Failure modes

Unchanged — every path is still inside the classifier's swallow-everything
`try/catch`, counted in `counters.errors`. The new branch is a field comparison
that cannot throw.

## 8. Rollback cost

Delete the branch and the counter field. No data migration, no schema change, no
config key, no agent state. Ledger rows already written stay valid and are still
correctly shaped; there are simply fewer new ones.

## Evidence

15 tests pass in the classifier file (11 pre-existing + 4 new). The four new ones
pin all three directions: explicit outbound is skipped and unrecorded, the SAME
bytes inbound are classified and recorded (the control — without it the first
test would pass against a classifier that had stopped working), an absent flag
still classifies, and the chained handler honours direction too.

**Shown capable of failing:** with the skip disabled, exactly the 2 tests that
assert outbound-is-skipped fail and the other 13 pass — so they measure this
change and not something adjacent.
