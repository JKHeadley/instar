# Side-effects review — alive-but-rejecting classification (auth-reject evidence)

**Change:** `RopeRecoveryProber` records the freshest typed auth-layer probe refusal per
(peer, kind) and exposes `lastAuthRejectAtMs(peer)`. `RopeHealthMonitor` consumes it via a
new optional dep checked BEFORE both 'peer-offline — expected' branches: an all-down peer
with refusal evidence fresher than `authRejectFreshnessMs` (45 min) classifies as the new
condition `auth-rejected`, raising ONE actionable item per episode
(`authRejectAlertEnabled`, default true) and a distinct digest sentence.

**Origin (live, 2026-08-27→29, topic 62395):** the Studio's regenerated signing key left
peers refusing every outbound RPC (`401 auth-rejected:signature-invalid`, ~10,968
consecutive per rope). The monitor classified all three peers 'peer-offline — expected
(its heartbeat stopped)' — but the heartbeat and registry-online flag had stopped
*because* of the auth fault. The classification consumed its own symptom as the benign
explanation, and a two-day one-way mesh outage raised nothing.

## 1. Over-block — what legitimate input does this now reject?

Nothing is blocked — the change is a classification + one additional alert class. The
over-fire risk: an alert during a benign transient. Bounded by the evidence bar — only a
TYPED auth-layer refusal records (the peer's dispatcher answered and refused); transport
failures, timeouts, and untyped bodies record nothing, so a sleeping machine structurally
cannot trip it. A single refusal during a healthy period does not alert either: the
classification only applies inside the ALL-DOWN branch, so at least one rope must already
be dead-classified.

## 2. Under-block — what does this still miss?

- Evidence only exists where the recovery prober runs (dev-gated live; dark-on-fleet
  installs record nothing and keep today's exact behaviour — honest, not silent: the
  classification simply never fires there).
- The 45-min freshness bound means a wedged prober (not probing at all) yields no
  evidence and the peer falls back to 'peer-offline'. Failing toward the old behaviour is
  the chosen direction.
- Detection, not repair: the mesh stays one-way until the identity is fixed (the
  automatic re-announce is the machine-self-assertion spec's build).

## 3. Level-of-abstraction fit

The prober owns probe verdicts, so the evidence lives there (scheduling-state only, never
persisted — same as its other episode state). The monitor owns peer classification, so
the rule lives there. The wiring site connects the two existing components; no new
component, no parallel check.

## 4. Signal vs authority compliance

Compliant. Both components are signal-producers: the new path raises an attention item
and a digest sentence; it blocks nothing, restarts nothing, repairs nothing, and cannot
suppress any other alert (it runs BEFORE the offline branches and only ever upgrades
loudness, never downgrades — an auth-rejected peer would otherwise have been the QUIET
classification).

## 5. Interactions

- **Urgent tier:** unaffected in behaviour — a peer with fresh auth evidence classifies
  `auth-rejected` and skips the urgent path for that evaluation; without evidence the
  urgent rules run unchanged. The two alerts cannot double-fire for the same evaluation.
- **Sleep gate / split-brain suppressors:** not consulted for this class, deliberately —
  they exist to avoid false "partition" alarms on wake, and a typed refusal is immune to
  that false-positive mode (a sleeping machine answers nothing).
- **Escalate-once:** per-episode latch (`authRejectRaisedAt`), persisted like
  `urgentRaisedAt`, cleared by the same sustained-clear reset; delivery-failure retry
  mirrors the urgent path's detected-not-notified honesty.
- **State file:** one additive field; old state files load (missing field → null).
- **`RopeHealthCondition` union:** gains `'auth-rejected'`. Grep confirmed consumers are
  in-file (digest, transitions, isCondition) — the HTTP route serves the string through.

## 6. External surfaces

`GET /mesh/rope-health` may now show `condition: "auth-rejected"` and a new digest
sentence; the attention queue gains one new item class (episode-deduped). Alert text is
content-scrubbed by construction: nickname + relative time only — no key material, no
machine ids in prose, no addresses.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** "Peer X refuses MY signatures" is inherently a per-observer
fact (X may refuse this machine while accepting another whose stored identity is current).
Each machine classifies from its own probe evidence; no replication path is wanted —
replicating the verdict would let one machine's key problem misreport another's healthy
relationship. Single-machine agents have no peers and are a strict no-op.

## 8. Rollback cost

Trivial. `authRejectAlertEnabled: false` silences the alert while keeping the honest
classification; removing the `readAuthRejectAtMs` dep from the server wiring restores
byte-identical pre-change classification (explicitly tested: a null/throwing evidence
source falls through to the ordinary rules). The persisted field is additive and ignored
by old code. No migration.

## Second-pass note

Signal-only monitoring change (no block/allow authority anywhere in the path); Tier 1
with the no-dep-equals-old-behaviour test standing in for the reviewer's main concern.

## Tests

- Prober (+2): typed auth refusal records freshest-per-peer; transport failures and typed
  successes record nothing; per-peer scoping.
- Monitor (+6): the full regression (all-down + stopped heartbeat + registry-offline +
  fresh evidence ⇒ `auth-rejected`, ONE item, digest sentence, never 'expected'); stale
  evidence falls through; throwing source is no evidence; alert-disabled still classifies;
  failed raise retries; recovery clears the latch and a new episode alerts once more.
- Verified RED against pre-fix behaviour (the 4 positive cases fail for the right reason)
  and green after. 55 unit + 7 integration in the touched suites, all green.
