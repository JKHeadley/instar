---
title: "OwnershipApplier mesh-self ordering fix — make the transfer-fix applier actually run"
slug: "ownership-applier-meshself-ordering-fix"
author: "echo"
parent-principle: "Wiring Integrity — a dependency-injected component must actually run, not be a silently-skipped no-op (Testing Integrity Standard, wiring-integrity clause)."
review-convergence: "2026-06-16T06:31:02.035Z"
review-iterations: 3
review-completed-at: "2026-06-16T06:31:02.035Z"
review-report: "docs/specs/reports/ownership-applier-meshself-ordering-fix-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
approved: true
approved-by: "echo (autonomous run, standing operator pre-approval for topic 13481 — design-fork/spec decisions are mine to approve and report in the ELI16)"
---

# OwnershipApplier mesh-self ordering fix

## Problem statement

The multi-machine transfer fix (transfer-fix §7.2) relies on the `OwnershipApplier` to
materialize durable ownership on the machine a topic moved **to** — it reads the
replicated placement journal (`peers/<machineId>.topic-placement.jsonl`) and writes a
durable `LocalSessionOwnershipStore` record so the next message resolves the right owner.

Applying the **Live-User-Channel Proof** gold standard to the transfer (the first feature
held to that bar) caught a genuine ship-blocker: **the `OwnershipApplier` is never
constructed or ticked at runtime — on either machine.**

Root cause is a boot-ordering bug in `src/commands/server.ts`:

- The applier wiring is guarded by `if (durableOwnershipStore && _meshSelfId)` at
  ~line 14995.
- `_meshSelfId` is not assigned (`_meshSelfId = meshSelfId`) until ~line 15648 — about
  650 lines / a later `await` stage in the async boot sequence.

So at the moment the guard is evaluated, `_meshSelfId` is still its initial `null`. The
guard is `truthy && null` → **false**, and the applier block (construction + boot tick +
the 15s interval) is skipped permanently.

**Why it was invisible until the live test:** on the transfer **source** the durable
ownership record is written directly (the `tclaim` path), so a source machine looks
correct without the applier ever running. The applier is the **only** materialization
path on the **destination**. So a transferred seat is recorded on the source, replicates
to the destination's journal, and then **dies there** — the destination never materializes
ownership, never knows it owns the session, and never serves the conversation. This is
exactly the failure the operator personally hit, and exactly what the standard exists to
catch: `/pool/transfer` returns `seatMoved:true` while, end-to-end, nothing landed on the
destination.

**Evidence the applier *logic* is correct (so this is purely a wiring/ordering bug):**
constructing `CoherenceJournalReader` + `OwnershipApplier` + `LocalSessionOwnershipStore`
by hand against the destination's *deployed* journal materialized every replicated
placement correctly (`materialized 11/11`, including the live-test topic, tagged
`SELF — this machine now serves it`). The activation fix (pool-consistent durable-store
activation, v1.3.590) is necessary but not sufficient: the store is active, but the
component that *uses* it never runs.

## Proposed design

Make the applier wiring **order-independent** (Structure > Willpower — a fix that depends on
two code regions staying in a particular order is a wish; a fix that cannot break under
reordering is a guarantee). Two surgical changes:

### 1. `src/core/OwnershipApplier.ts` — late-bind `selfMachineId`

`selfMachineId` is used **only** for the SELF-vs-peer log label (line ~122); it is NOT
required to materialize a placement (every placement is materialized regardless of owner —
fast-forward CAS on epoch). So accept it lazily:

```ts
selfMachineId: string | (() => string | null | undefined);
```

Resolve it at tick time via a private helper:

```ts
private resolveSelf(): string | null | undefined {
  const s = this.d.selfMachineId;
  return typeof s === 'function' ? s() : s;
}
```

and use `this.resolveSelf()` where `this.d.selfMachineId` is read. A plain string still
works (full backward compatibility — existing callers/tests are unaffected).

### 2. Extract a testable wiring factory + construct on the durable-store condition alone

The construction CONDITION is what the boot-ordering bug corrupted, so it is extracted into
a small exported factory (`src/core/ownershipApplierWiring.ts`) — mirroring
`durableOwnershipActivation` — so the invariant is unit-testable without booting the whole
server (Structure > Willpower; the inline-in-`server.ts` condition was untestable, which is
how the ordering bug shipped):

```ts
// ownershipApplierWiring.ts
export function wireOwnershipApplier(deps: {
  durableOwnershipStore: SessionOwnershipStore | null;
  reader: PlacementReader;
  getSelfMachineId: () => string | null | undefined;   // late-bound
  logger?: (m: string) => void;
}): OwnershipApplier | null {
  if (!deps.durableOwnershipStore) return null;          // gate on the store ALONE — not on _meshSelfId
  return new OwnershipApplier({
    reader: deps.reader,
    store: deps.durableOwnershipStore,
    selfMachineId: deps.getSelfMachineId,                // getter, resolved per-tick
    logger: deps.logger,
  });
}
```

`server.ts` calls `wireOwnershipApplier({ durableOwnershipStore, reader, getSelfMachineId: () => _meshSelfId, ... })`
in place of the inline `if (durableOwnershipStore && _meshSelfId) { new OwnershipApplier(...) }`,
then schedules the boot tick + 15s interval on the returned applier (when non-null).

Construction now depends only on the durable store being active (the correct condition —
applying replicated placements is a durable-store concern; InMemory has no replication to
apply). The boot tick + 15s interval run from the start; an early tick that fires before
`_meshSelfId` is assigned still materializes placements correctly (it only loses the
SELF/peer log label on that one early tick), and every subsequent tick — milliseconds
later, after the assignment — labels correctly.

### Observability

The applier's runtime activity is already observable and that surface becomes meaningful for
the first time once it actually runs: each materializing tick logs
`[ownership-applier] materialized topic <t> → owner <m> (SELF|peer …)` and the interval logs
`[OwnershipApplier] materialized N/M topic(s) from replicated placements`; a tick error logs
`[OwnershipApplier] tick failed`. These lines in `logs/server.log` are the read surface for
"is the destination materializing transferred seats?" — their **presence** is itself the
proof the wiring is alive (the bug's signature was their total absence). The applier is a
deterministic file-scan component, not an LLM feature, so it carries no token/`/metrics`
surface; the materialized/examined counts in the interval log are the equivalent rate signal.
No new metric is introduced because the fix's success criterion is precisely the appearance
of these existing-but-never-emitted lines.

### Multi-machine posture

This is the materialization half of the existing replicated transfer path; posture is
unchanged (replicated placement journal → durable per-machine ownership store). Single
machine: the durable store may be active but there are no peer placements to apply, so the
applier is a harmless no-op tick. No new state, route, or URL is introduced.

## Decision points touched

No block/allow/route gate is introduced, removed, or modified. The change is internal
wiring: it removes an over-restrictive construction guard (`&& _meshSelfId`) that was
silently disabling a required component, and makes a dependency late-bound.

## Frontloaded Decisions

- **Lazy-bind vs relocate-the-block.** Both fix the ordering. Lazy-binding is chosen because
  it is order-independent (cannot regress if either code region is later moved), it makes
  the applier's construction condition *semantically correct* (gate on the durable store,
  not on an unrelated mesh-id variable), and it keeps the diff local. Relocating the block
  would leave a latent fragility (a future reorder reintroduces the bug). Reversible: behind
  no flag, but it only activates the durable-ownership path that already ships dark for
  single-machine and pool-consistent for replication-on pools.
- **Construct even when self is momentarily null.** Accepted: materialization does not need
  self; only the log label does. An early label-less tick is strictly better than never
  materializing. Cheap-to-change: pure internal logging cosmetics.

## Testing

- **Tier 1 (`tests/unit/`):** OwnershipApplier resolves a **function** `selfMachineId` at tick
  time — a getter returning `null` at construction then a value still materializes placements
  on both ticks, and labels SELF/peer correctly once the getter returns a value; a plain
  string still works (backward compat); a peer placement materializes even when self is
  unresolved (proving construction-time self is not required — the regression guard for this
  exact bug).
- **Tier 2 / wiring-integrity (`tests/unit` + `tests/integration`):** test the EXTRACTED
  `wireOwnershipApplier` factory directly — it returns a **live applier (non-null)** when a
  durable store is present even though `getSelfMachineId()` returns `null` (the exact
  condition the boot-ordering bug got wrong: store-present + self-unset must still construct),
  and returns `null` when the store is absent (InMemory has nothing to apply). This proves the
  construction CONDITION at the unit level — the regression surface codex flagged — without
  booting the whole server. An integration test then exercises the
  `CoherenceJournalReader` + (factory-built) applier + `LocalSessionOwnershipStore` triad over
  a fixture peer placement journal and asserts a durable destination record is written — the
  in-process analogue of the cross-machine path, runnable in CI without two machines.
- **Tier 3 / E2E — the live bar (see Verification below).** A boot-ordering wiring bug only
  fully manifests in a real two-machine deployment; the synthetic tiers above are necessary
  but cannot exercise the actual server boot sequence that the bug lives in. The gold
  standard's live-user-channel re-run **is** the E2E for this fix, and is a hard release gate
  that runs in THIS effort as a required step (not optional, not postponed).

**Named residual (explicit coverage map).** The factory unit test proves the construction
*predicate* (store-present + self-unset ⇒ non-null applier); it deliberately does NOT prove
that `server.ts` *invokes* `wireOwnershipApplier` at the right point in its boot sequence —
that is the one surface a unit test cannot reach. That residual is owned, not waved away: it
is closed by the Tier-3 live verification below (step 3b asserts the **server's own** applier
emitted `[ownership-applier] materialized …`, and 3a/3c assert the durable destination state
the boot wiring must produce). Factory unit test + live E2E together cover the predicate and
the invocation; neither alone is sufficient, and the live E2E is a hard release gate so the
invocation half can never be skipped.

## Verification (the live bar — reproduces the original failure before claiming fixed)

Per the **Bug-Fix Evidence Bar** (verify before you claim) and the **Live-User-Channel
Proof** standard, the fix is not "done" until the *original* failure is reproduced against
the deployed system and shown resolved end-to-end:

1. Deploy the fixed version to **both** machines (Laptop + Mac Mini); restart both servers.
2. `POST /pool/transfer` a throwaway topic Laptop→Mini.
3. Assert the **destination** (Mini) materializes it — all THREE must hold (none was true
   before the fix): (a) a durable record at `.instar/ownership/local/<topic>.json` on the
   Mini owned by the Mini; (b) `[ownership-applier] materialized topic <topic> → owner
   <mini>` in the Mini's `logs/server.log` (proving the **server's own** applier ran, not a
   manual diagnostic — the `(SELF …)` label is best-effort and appears once `_meshSelfId`
   resolves, so the gate keys on the materialized line and the durable record, NOT on the
   SELF suffix, which an early pre-resolve tick legitimately omits); (c) the Mini's
   `GET /pool/placement?topic=<topic>` reports `isThisMachine:true`.
4. Drive a message through the real user channel (Telegram and Slack) and confirm the reply
   is genuinely served **from the Mini**, then record the signed `LiveTestArtifact`.

**The authoritative correctness gate is the durable STATE, not the log.** Steps 3(a) (the
durable `.instar/ownership/local/<topic>.json` record on the Mini) and 3(c) (the Mini's
`/pool/placement` reporting `isThisMachine:true`) are queried from durable state / a live
API and are what PASS/FAIL keys on — immune to log-level changes, rotation, throttling, or
async-flush loss. Step 3(b)'s log line is corroborating evidence that the **server's own**
applier (not a manual diagnostic) produced the record; its absence with 3(a)+3(c) present is
investigated (it would mean the record arrived by some other path) but does not by itself
fail a run where durable state is correct, and its presence cannot substitute for a missing
durable record. So log brittleness can neither cause a false PASS nor block a true one.

A `seatMoved:true` from `/pool/transfer` that is NOT accompanied by destination
materialization (step 3) is the exact false-OK this whole effort exists to forbid, and
blocks the claim.

## Open questions

*(none)*
