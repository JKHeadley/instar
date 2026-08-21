# Side-Effects Review — a non-owner no longer claims an inbound it only relays

**Change:** `src/server/routes.ts` (+14) and `tests/integration/exactly-once-ingress.test.ts` (+52)
**Tier:** 1 (declared). See "Tier declaration" below — the gate's advisory signal is recorded there.
**Branch:** `w22-d-ownership-claim-order` · **Base:** `7d4076a53` (JKHeadley/main, v1.3.1182)

## Summary of the change

`POST /internal/telegram-forward` recorded and CLAIMED an arriving message in this machine's
exactly-once ingress ledger before anything checked which machine owns the conversation. Ownership is
consulted afterwards, inside routing. A machine that does not own a topic therefore took a claim it
would never complete, and only then discovered the message belonged elsewhere.

The change adds one guard: when the ownership registry is wired and names a DIFFERENT machine as the
owner, the claim is skipped. Everything else is untouched — the message continues through
serve-progress stamping, a2a dispatch, and normal routing exactly as before.

**Observed damage this fixes,** from live data on the Mac Mini after topic 29723 transferred to the
laptop at `2026-08-18T06:01:01Z`:

    telegram:29723:47566   abandoned    2026-08-18T06:05:07.177Z   (4 min after the handover)
    telegram:29723:47828   processing   2026-08-18T17:19:37.984Z   (still stuck three days later)

Both are the claim residue of a relay that worked: the Mini passed the messages to the laptop and
left claims behind that nothing ever finished.

## Decision-point inventory

One decision point, already existing: whether this machine claims an inbound event in its ledger.
The change narrows *when* that claim happens. It does **not** add a block/allow decision on the
message itself.

## 1. Over-block

**None by construction, and this is the point of the design.** An earlier draft of this change
refused a non-owner arrival with a `409` and returned. That was withdrawn during this review: a
non-owner does not merely claim — `src/core/SessionRouter.ts:6-7` documents "Owned + owner alive +
owner != self → forward via deliverMessage over MeshRpc", so the non-owner is the machine that
RELAYS the message to the owner. Refusing would have removed the relay; the forwarder classifies an
unrecognised status as `ForwardTransientError` (`src/lifeline/TelegramLifeline.ts:1621`) and retries
against the same machine, which would refuse again — a working delivery turned into a retry loop and
then a dropped message.

The shipped version blocks nothing. No status code changes, no early return, no path stops.

## 2. Under-block

Still missed, explicitly:

- A claim taken *before* ownership is established at all (registry unwired, or `ownerOf` returns
  null). Those still claim, as today. Making them not claim would require an ownership answer this
  layer does not have.
- Orphan rows that already exist are not repaired by this change. `telegram:29723:47828` stays stuck
  until something else clears it; the recovery that would clear it is lease-gated and no reachable
  machine currently holds the lease. That is a separate finding, deliberately not bundled here.
- A machine whose registry is *stale* (names itself as owner when it is not) still claims. The
  registry is the authority for ownership; this change consumes it, it does not second-guess it.

## 3. Level-of-abstraction fit

Correct layer, narrowly. The claim happens at the route; the ownership fact is already on the route
context (`ctx.sessionOwnershipRegistry`, `ctx.meshSelfId` — `src/server/routes.ts:1479`, `:1535`), so
no new plumbing is introduced. Pushing the check into `decideIngress` was considered and rejected:
that function is about dedupe semantics for a key, and topic ownership is not its concern.

The newer session-pool receive path already carries an equivalent fence
(`src/core/DeliverMessageHandler.js:49-52` stale-epoch, `:53-82` sender rejection). This brings the
older forward route into line with a pattern that already exists rather than inventing one.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md` governs **judgment** decisions — blocking on what a message *means* or
what an agent's *intent* appears to be. This is not one: "which machine owns this topic?" is a
registry lookup, an ownership fact, not an interpretation. It sits in the document's excluded
category alongside idempotency and dedupe mechanics at the transport layer.

More importantly, the shipped change holds **no blocking authority at all**. It does not decide
whether a message proceeds; it decides whether a bookkeeping row is written. The version that DID
hold blocking authority was withdrawn in this review precisely because brittle authority over an
inbound path is what the principle forbids.

## 5. Interactions

- **Routing is untouched.** The non-owner still reaches `ctx.telegram.onTopicMessage` and still
  relays over the mesh. That is asserted by a dedicated regression test.
- **At-most-once for the owner is untouched.** The dedupe path runs exactly as before when this
  machine is the owner; a duplicate redelivery is still dropped. Asserted by test.
- **`currentInboundByTopic`** is not set for a skipped claim, which is correct: that marker exists so
  a later reply can be committed against the claim, and there is no claim to commit.
- No interaction with the session-pool receive path — different route, its own fence.
- Does not shadow or get shadowed by the stuck-message recovery, which is lease-gated and separate.

## 6. External surfaces

No status codes change, no response shape changes, no route added, no protocol surface. One new log
line on the skip path (`exactly-once: skipped non-owner claim`) and one on the read-error path. From
outside this machine, behaviour is identical except that a ledger row is no longer written when this
machine is not the owner.

## 6b. Operator-surface quality

The skip is visible in the log with the topic, the owner and self named, so "why is there no ledger
row for this topic on this machine?" is answerable from the log rather than by inference. No operator
action is required.

## 7. Multi-machine posture (Cross-Machine Coherence)

**This change exists because of multi-machine.** Posture: machine-local decision, mesh-derived input.
The ownership registry is the replicated authority; this route consumes it read-only. On a
single-machine agent the registry is unwired or names self, the guard never engages, and behaviour is
byte-identical to today — verified by the owner-path test. Nothing is stranded on a topic transfer;
the change makes transfers cleaner by removing the residue they leave.

## 8. Rollback cost

Revert of a 14-line block in one file. No migration, no persisted state to unwind, no agent repair.
Rows already written are unaffected either way. Worst realistic case: a machine that should have
claimed does not, and the ledger under-records inbound for a topic it does not own — which is the
intended behaviour, and which loses no message because routing is untouched.

## Conclusion

Bounded correction of claim ordering, with no blocking authority and no delivery change. The
delivery-regression variant of this change was caught in this review and withdrawn before it reached
a pull request.

**Verdict is REVIEW-GRADE, not proven.** The five-property signature runner that would let a guard be
called *fixed* does not exist. Nothing here is described as fixing, verifying or proving.

## Tier declaration

The observer ruling of 2026-08-21 (topic 29723, ruling ten) declared this change tier 1, with the
reasoning that the higher tier exists to force design convergence before code and that convergence
exists on the record — the Window-22 causal map, the charter, and rulings eight through ten, with
mechanism proven, predicted after-state stated, and falsification condition stated. The ruling is
void if the diff carries new plumbing, a schema, config, or a protocol surface; it carries none — the
ownership inputs already existed on the route context, and no config key, route, or exported type is
added. The gate's own advisory signal is printed at commit time and is recorded in the trace
alongside this reasoning so the comparison is auditable rather than suppressed.

## Evidence pointers

- `npx tsc --noEmit` — PASS.
- The four ownership tests **could not execute locally**: the build sandbox denies opening a listener
  (`listen EPERM: operation not permitted 0.0.0.0`), which Supertest requires. They are written and
  staged and run in CI. **Per the observer's binding condition, this change is not reviewable until
  those tests execute and pass in this PR's own checks — reading plus the type checker is not
  execution.** An earlier attempt to work around the sandbox by replacing Supertest with an
  in-process shim was withdrawn: it rewrote pre-existing tests and traded away real-socket coverage
  in CI to solve a problem that exists only on the build machine.
- Investigation that produced the mechanism: `.instar/w22/branch-d-admission-path.md`,
  `.instar/w22/branch-d-edge-a.md`, `.instar/w22/branch-d-edge-b.md`.

## Second-pass review

Concur with the review. I checked the side-effects artifact, the signal-vs-authority principle, the actual `git diff`, and the named implementation seams. The shipped diff adds only `shouldClaimInbound` around the local ledger claim in `src/server/routes.ts`; it does not add an early return, change a response status, or skip the later serve-progress, agent-message hook, or `onTopicMessage` routing path when the non-owner branch is taken. The owner path remains the existing `ctx.messageLedger && shouldClaimInbound` path because `ownerOf(topic) === meshSelfId` leaves `shouldClaimInbound` true, so duplicate drop and claim/currentInbound behavior are unchanged for the owner. The ownership read-error catch only logs and leaves `shouldClaimInbound` true, so it falls through to today's claim/routing behavior. `SessionRouter` confirms a live non-owner active owner is relayed with `forwardToOwner(...)->deliverMessage`, and `TelegramLifeline` classifies unrecognized non-2xx forward responses as `ForwardTransientError`, so the withdrawn 409/blocking design would have retried as described. The diff introduces no new plumbing, schema, config, route, exported type, or protocol surface; it only adds the route guard plus integration tests. I did not find diff content omitted by the artifact.

Independent reviewer, 2026-08-21T08:27:16Z
