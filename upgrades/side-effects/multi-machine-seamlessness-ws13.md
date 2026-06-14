# Side-Effects Review — WS1.3 ownership reconcile + honest pending state

**Spec:** docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md §WS1.3 (converged + approved, on main)
**Change:** (1) FSM gains `force-claim` (fenced epoch takeover; caller-validated death
evidence; rejects self-claim and missing records); (2) new `OwnershipReconciler` —
per-machine tick that converges pin/owner divergence: cooperative transfer→claim while
the owner lives (flap debounce + bounded safe point), adoption of unowned pinned
topics, force-claim ONLY with owner-death evidence (offline + last-seen past bound) AND
quorum membership; (3) `GET /pool/placement` surfaces `pendingReplacement` +
`pendingSince`; (4) SessionReaper closeout holds (do-not-act, audited once per episode)
when the topic's pin names THIS machine — the divergence is reconciling toward us;
(5) journal `PlacementReason` gains `'reconcile'` (additive); (6) dark flags
`multiMachine.seamlessness.ws13Reconcile` (false) + `ws13DryRun` (true) + `ws13TickMs`.

## 1. Over-block
The reconciler never blocks user actions. The closeout hold is the inverse of a block:
it STOPS an aggressive kill (the 2026-06-12 incident: 2-minute swings at a working
session for hours). Risk inverted: could the hold protect a session that genuinely
should close? Only when a pin actively names this machine — a deliberate, operator-set
state — and it self-clears the moment the pin converges or moves. The hold cannot leak
to unpinned topics.

## 2. Under-block
- Force-claim evidence is heartbeat-derived (capacity view). A partitioned-but-alive
  owner that cannot heartbeat LOOKS dead after the bound; force-claim then fences it
  out. This is the designed direction (the lease has the same property — clock-proof
  epochs mean the returning machine cannot double-run; it observes the higher epoch
  and stands down), and quorum membership prevents the minority side from acting.
- The cooperative path's CAS can lose races indefinitely under pathological churn;
  each tick re-evaluates — bounded per tick, eventually consistent, never spinning
  (one action attempt per topic per tick).

## 3. Level-of-abstraction fit
The FSM stays pure (sequencing + epochs); evidence/quorum live in the reconciler;
surfaces stay read-only. Matches the existing place/claim/transfer architecture —
no parallel ownership mechanism.

## 4. Signal vs authority compliance
The reconciler holds narrow, evidence-gated authority over ownership RECORDS (not
messages, not sessions, not user actions) — the same authority class as the existing
router placement, sharing its CAS arbiter. Force-claim's brittle half (the death
bound) is fenced by the quorum check and the epoch CAS: a wrong call cannot double-run
(stale owner is fenced) and cannot orphan (the record stays active under the claimer).
The closeout hold removes authority rather than adding it. Dry-run default ships the
whole engine observe-only.

## 5. Interactions
- The router's own place/claim on inbound messages composes: both go through the same
  CAS; a reconciler action and a router action race safely (one wins, the loser
  re-evaluates).
- The transfer route's existing place-half (quiet-topic repair) is untouched; the
  reconciler covers the ACTIVE-record case that path deliberately refuses.
- The closeout's genuine-move path is unchanged for unpinned/pin-elsewhere topics;
  the -1 sentinel resets cleanly so a future genuine move dwells normally.
- The cas-pairing discipline (§3.3) holds: every landed reconciler CAS emits a
  journal placement entry with the new 'reconcile' reason (additive; old readers
  ignore unknown reasons per the journal's forward-compat contract).
- WS3's SpeakerElection reads ownership via the same registry — faster convergence
  directly improves one-voice accuracy. No new coupling.

## 6. External surfaces
`pendingReplacement`/`pendingSince` on an existing authenticated route. No new mesh
verbs: force-claim is NOT remotely invokable — each machine force-claims only for
itself, locally, with its own evidence (L15: a peer cannot drive a takeover).

## 7. Multi-machine posture (Cross-Machine Coherence)
**This IS the multi-machine feature.** Reconciler: per-machine by design — each
machine reconciles its own pin view against the shared CAS registry (the arbiter).
Pin stores are machine-local router-write-only by design (provenance). The
pendingReplacement surface is proxied-on-read via the existing holder-proxy on
/pool/placement. Phase C: quorum is N-machine from day one (online > total/2; the
2-machine degradation to surviving-machine-vs-provably-dark-peer is explicit and
documented because majority-of-2 cannot lose a member); no LAN assumption (all reads
local/replicated; evidence from the heartbeat registry that already works over the
public internet); no per-machine interactive steps (headless-VM compatible).

## 8. Rollback cost
Flag-flip (`ws13Reconcile: false` — the default) stops the engine instantly (read
live per tick). Records already converged by the reconciler are ordinary valid
ownership records — no data rollback. The closeout hold de-activates with no pin
conflicts present. PlacementReason 'reconcile' entries are inert history.

## Second-pass review
REQUIRED (ownership lifecycle + reaper surface). Independent reviewer response
appended below.

<!-- second-pass reviewer response appended below by the independent reviewer -->

---

## Second-pass reviewer response (independent subagent, 2026-06-12)

**Concern raised: the journal validator silently drops every `'reconcile'` placement entry — the §3.3 CAS-pairing the artifact (§5) and the OwnershipReconciler doc-comment both claim never actually lands.**

Code evidence: `src/core/CoherenceJournal.ts:591` — the `topic-placement` validator hardcodes its accepted reasons (`['user-move','placed','failover','released','quota-block-move']`); `'reconcile'` was absent. Only the `PlacementReason` TYPE was extended; the annotation `: PlacementReason[]` compiles because a subset of the union is type-legal, so the gap is silent at build time. `validate()` runs on the LOCAL emit path, so the entry is rejected at the source (counted only as `degradation.schemaRejects`). No test caught it because the reconciler unit tests assert against a FAKE emitPlacement and the integration cases only cover the route. Impact: every landed reconciler CAS would have produced NO durable placement evidence — falsifying artifact §5 and the §3.3 pairing invariant.

The reviewer's verification notes on everything else (all confirmed, no further concerns):

1. **Force-claim can NOT fire against a reachable-but-slow owner** — the gate requires `!online` AND last-seen past the 180s bound AND quorum; a slow-but-online owner falls to `deferredNoEvidence`. Dark + dry-run defaults verified at the wiring (`ws13Reconcile === true` gate; dry-run unless explicitly false; `act()` returns without CAS in dry-run).
2. **No two-active-owner / no-owner race** — the CAS store accepts only strictly-monotonic epochs; reconciler and router compute epoch+1 from the same observed record, the loser re-evaluates; release-during-transferring was already rejected by the FSM.
3. **The -1 closeout sentinel cannot leak to an unpinned topic and never permanently blocks a genuine move** — hold requires `otherOwner && pinnedHere`; convergence resets -1→0; a direct held→genuine-move transition costs one extra dwell tick (recovers; slightly imprecise in §5's "resets cleanly" but not a defect).
4. **Tick loop bounded; no spin/flood; no unbounded memory** — one act per topic per tick; `conflictSince` deleted on convergence and on landed CAS; `isTopicBusy` is a sound conservative signal because the 120s `pastDeadline` bound guarantees progress.
5. **Phase C quorum matches the artifact exactly** — `online * 2 > machines.length` for N>2 with the documented ≤2 degradation.

## Fix addendum (same change, before commit)

The reviewer's concern is fixed in this same PR: `'reconcile'` added to the runtime
allowlist (`CoherenceJournal.ts`, with a KEEP-IN-SYNC comment naming this exact
failure shape), plus the missing semantic-correctness test — the REAL
`CoherenceJournal` accepts `reason:'reconcile'` with zero schemaRejects and the
persisted entry carries the reason (`tests/unit/CoherenceJournal.test.ts`), proven
failing with the allowlist fix reverted and passing with it. Reviewer re-verification
of the fix appended below.

## Reviewer re-verification of the fix (same independent reviewer, 2026-06-12)

Fix verified — concern resolved. Concur with the review.

Notes:
1. The runtime allowlist now includes `'reconcile'` and carries a KEEP-IN-SYNC comment that names the exact failure shape — a type-legal subset silently schema-rejecting at the source. This addresses the structural root, not just the symptom.
2. The new test drives the REAL `CoherenceJournal` (no mock) and verifies both the zero-`schemaRejects`-delta AND the persisted-on-disk `data.reason === 'reconcile'`, genuinely exercising the validator and serialization path — the correct semantic-correctness coverage for reconciler-driven CAS journal pairing.
3. Full suite green: 39/39 pass.
