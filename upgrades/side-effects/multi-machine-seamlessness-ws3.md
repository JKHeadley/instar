# Side-Effects Review — WS3.1/WS3.2 one-voice gates (SpeakerElection)

**Spec:** docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md (converged 2026-06-12, approved; merged to main in PR #1083)
**Change:** new `src/monitoring/SpeakerElection.ts` (deterministic speaker election with
lease-stability dwell); PresenceProxy gate at its single send chokepoint (closes F18 —
it had NO machine gate); PromiseBeacon gate upgraded to live owner re-resolution with
the commitment stamp as fallback (closes F19); CommitmentTracker stamps
`ownerMachineId` at creation (defaulting to originMachineId); PostUpdateMigrator
backfills existing open commitments; dark config flag
`multiMachine.seamlessness.ws3OneVoice` (default false) + `ws3DwellMs`.

## 1. Over-block — what legitimate emissions could this wrongly silence?

The known hazard (round-1 adversarial finding, addressed in the converged spec): a
gate keyed on "am I the owner?" can conclude "no" on EVERY machine and silence the
pool. The election is built against that direction of error:
- Unknown ownership NEVER yields pool-wide silence: lease-holder speaks; no/offline
  lease-holder → deterministic lowest-online-id tiebreak; flapping lease → bounded
  defer then tiebreak. The exactly-one-speaks invariant test asserts ≥1 as well as ≤1,
  including under a flapping lease.
- Every guard failure (flag off, no machine id, pool < 2, deps unbound during the
  boot window) returns "speak" — fail toward speech.
- PromiseBeacon's silent verdicts RE-ARM the commitment (schedule), never drop it; the
  owning machine's beacon carries the heartbeat.
Residual over-block: a STALE local placement view could say "owner is the other
machine" while that machine is dead — its election (not running) can't speak, ours
stays silent for that topic until placement converges. Mitigation: ownership records
key the election only when status is 'active'; a dead machine's records converge via
the existing failover path, and PresenceProxy's cadence re-evaluates each tick.
Accepted as bounded-by-failover; noted for the WS1.3 reconcile build which shortens
exactly this window. Second residual (independent reviewer finding): a held silent
verdict can outlive the chosen speaker's departure for up to one dwell window
(default 60s) plus one cadence tick on a doubly-degraded path (speaker offline
mid-dwell + unknown ownership + no online lease-holder) — bounded, self-healing
(re-election after dwell expiry), and no emission is dropped (both consumers re-arm).

## 2. Under-block — what double-voice does this still miss?

- Both gates only cover PresenceProxy + PromiseBeacon (the F18/F19 surfaces named in
  the spec). Other notice paths (rate-limit sentinel, recovery notices — F23/WS3.3)
  are explicitly a separate spec item with episode-key dedup; not silently claimed.
- The ≥1/≤1 invariant holds when machines agree on the replicated inputs. During a
  partition with divergent placement views, two machines can transiently both believe
  they own a topic and both speak — the same exposure as today (no regression), fully
  closed only by the WS1 epoch-fenced reconcile family.

## 3. Level-of-abstraction fit

One shared deterministic module consumed by both sentinels at their existing
chokepoints — not two bespoke gates (the F18 finding showed exactly how per-sentinel
divergence happens). The election reads only local replicated state (ownership
registry, capacity registry, lease status) — never a mesh call on the emission path
(spec hot-path rule). The dwell lives in the module so every consumer inherits it.

## 4. Signal vs authority compliance

The election holds NARROW authority: it gates WHO SPEAKS a duplicate-prone sentinel
notice — never recovery actions, never message content, never anything user-initiated
(spec "Decision points touched": WS3 gates sentinel SPEECH only). Its logic is
deterministic over replicated state (not brittle pattern-matching), it fails open to
"speak" on every uncertainty, ships dark, and every verdict is observable (onVerdict
hook → server log; P7). This is the blocking-authority shape the converged spec
explicitly reviewed and approved across three rounds.

## 5. Interactions

- The per-topic proxy mutex (PromiseBeacon/PresenceProxy double-post guard, spec A10)
  is untouched and still applies AFTER the election — the two compose (election picks
  the machine, mutex serializes emitters within it).
- PromiseBeacon's legacy static gate remains for election-absent construction
  (back-compat for tests/embedders); the election branch supersedes it when wired.
- The CommitmentTracker stamp default cannot collide with cross-machine commitment
  sync (P1.5): originMachineId was already recorded; ownerMachineId now mirrors it at
  creation and remains mutable via the existing CAS mutate path.
- The migration touches state/commitments.json directly at update time (server down/
  pre-boot — same pattern as every other PostUpdateMigrator state migration); it
  stamps only missing fields on 'pending' records.

## 6. External surfaces

None new. No routes, no message formats, no cross-machine wire changes. The flag is
config-local. Single-machine agents: structurally inert (no SpeakerElection
engagement below 2 online machines; CommitmentTracker stamp is absent without an
originMachineId — both tested).

## 7. Rollback cost

Flag-flip: `multiMachine.seamlessness.ws3OneVoice: false` (the default) restores
legacy verdicts instantly at the next decision — no restart-ordering hazard since the
flag is read live per decision. The backfilled ownerMachineId stamps are inert data
when the flag is off (the legacy gate only acts when currentMachineId is ALSO set,
i.e. multi-machine pools) and are correct-by-construction on single-machine agents;
no data rollback needed.

## Second-pass review

REQUIRED (sentinel surface). Reviewer response appended below.

<!-- second-pass reviewer response appended below by the independent reviewer -->

---

## Second-pass reviewer response (independent subagent, 2026-06-12)

Concur with the review

1. **Fail-toward-speech verified on every uncertain path.** Both consumer gates skip the send ONLY when `!verdict.speak` (PromiseBeacon.ts:360, PresenceProxy.ts:1847), and `SpeakerElection.decideInner` returns `speak:true` on every legacy/no-op/ambiguous branch: flag-off (`legacy-disabled`), no machine id, pool<2 (`single-machine`), owner-self, stamp-self, lease-holder-self, and the deterministic `tiebreak-lowest-id` whenever the lease holder is null or offline. The guards are ordered legacy/no-op FIRST, so none of the election machinery runs when disabled. The boot-window no-op is real: `poolMachineIds()` returns `[]` until `ws3PoolDeps` binds, yielding `single-machine`/speak. The flag is read live (`() => ws3Cfg().ws3OneVoice === true`) so the rollback flip takes effect at the next decision with no restart — artifact §7 is accurate.

2. **Silent verdicts re-arm, never drop.** PromiseBeacon calls `this.schedule(c)` on a non-speak verdict, which re-arms at the commitment cadence (default 10min, 1s floor — no busy-loop); PresenceProxy logs and returns, and its own cadence re-evaluates. No emission is lost on a silent/defer verdict. The legacy static gate is preserved for election-absent construction as the artifact §5 claims.

3. **Migration direction-of-error is safe and idempotent.** `migrateCommitmentOwnerBackfill` stamps ONLY `status==='pending'` records lacking `ownerMachineId`, with THIS machine's own identity.json machineId — and crucially, when no identity exists it skips WITHOUT writing the marker, so it retries on a later update rather than permanently no-op'ing. The stamp is only a fallback; live placement re-resolution at speak time means a stale backfilled stamp racing a transfer cannot wedge the gate (live owner beats stamp; tested). The single-machine no-op is genuinely byte-identical: no `originMachineId` → `ownerMachineId` stays absent (tested).

4. **No authority beyond sentinel speech; cannot gate recovery/delivery/user flows.** The election is consumed at exactly two chokepoints — `PresenceProxy.sendProxyMessage` and `PromiseBeacon.fire` — both of which emit duplicate-prone 🔭/heartbeat notices. It is injected as an optional dep; it touches no recovery action, no message content, no user-initiated path, and `resolveTopicOwner` reads only local replicated state with no mesh/fetch call on the hot path (asserted by test). The `onVerdict` hook is try/catch-swallowed so observability can never gate. I agree with the artifact's "no issue identified" answers in §3–§6.

5. **Bounded memory; ≤1 invariant holds.** The `held` map is opportunistically swept past the dwell window at size>512 and `unstableSince` entries are deleted on every decisive path — no unbounded growth. Two machines cannot BOTH speak for a topic under agreed replicated inputs: live owner is single-valued, the stamp comparison is to one id, and the tiebreak picks one `sort()[0]`. (Divergent-placement double-voice during a partition is correctly scoped to WS1 and disclosed as no-regression in §2.)

**One verification note for the record (bounded, not a blocker):** the speaker-identity dwell can HOLD a silent verdict, and the held branch returns it irrespective of current pool state. If the chosen speaker machine drops offline mid-dwell while ownership is unknown AND there is no online lease holder AND the remaining pool is still ≥2, the surviving machines can each return a fresh held-silent verdict, producing a transient ALL-silent window for that topic. This does NOT violate the spec's ≥1 framing ("never pool-wide / never unbounded silence"): it is bounded by `dwellMs` (default 60s) plus one cadence tick, it self-heals (after dwell expiry the new lowest-id re-elects to `tiebreak-lowest-id` and speaks), no emission is dropped (both consumers re-arm), and the `single-machine` guard correctly rescues the pool-of-1 case by firing before the dwell check. It is strictly no worse in outcome than the partition exposure already disclosed in §2, and the gate holds no authority beyond speech — an acceptable residual on a doubly-degraded path, not a defect. Recorded in §1's residual list.

## Addendum — no-silent-fallbacks ratchet (CI round 1)

The three new fail-open guards in server.ts (identity read, pool-ids read, ownership
read) tripped the repo-wide silent-fallback ratchet (466 > 463). Each now carries the
sanctioned `@silent-fallback-ok` exemption with its reason inline: every one degrades
to the election's designed fail-toward-speech/no-op verdict — the documented safe
direction, not a silent loss. Ratchet count restored to baseline.
