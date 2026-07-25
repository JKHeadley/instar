---
title: "Cross-Machine Door + Capability Registry"
slug: "cross-machine-door-capability-registry"
author: "codey"
status: draft
approved: false
review-convergence: pending
spec-only: true
---

# Cross-Machine Door + Capability Registry

## Scope and status

Spec-first deliverable for ACT-409. It proposes a cross-machine read model; it
does not implement routes, storage, mesh verbs, or fleet rollout. Convergence
rounds 1-7 (2026-07-25: six internal reviewer lanes + GPT-tier external passes
+ the standards-conformance gate each round) surfaced and resolved ~48
material findings; the former ten open questions are resolved in
`## Frontloaded Decisions`.

Round 6 (an adversarial external pass run specifically to test whether the
spec was actually converged) found eight material defects that five prior
rounds had missed, and they share ONE cause worth recording: every round
patched prose locally, so NUMBERS and INVARIANTS drifted apart between
sections — a 72-vs-64 byte digest bound, a ±2-min-vs-24h skew tolerance, an
epoch-monotonicity claim stronger than its own mechanism, a status matrix
whose ordering contradicted the sentence beneath it, a `conflict` rule with
no field able to express provenance, an `entries: []` with three
indistinguishable meanings, a replayable heartbeat that could hold a dead
peer "fresh" forever, and a row bound that collided with a
never-drop invariant. All eight are resolved above/below with the fix
named inline. The process lesson (filed to the drive's coherence gap log):
multi-round spec editing REQUIRES a final cross-section consistency pass —
per-round local edits cannot detect number drift, and "five rounds" is not
evidence of convergence.

Round 7 then VERIFIED those eight fixes independently (six confirmed
resolved) and demonstrated the same lesson one level up: two of the round-6
fixes had left a contradicting sentence elsewhere in the document, and three
of the fixes introduced NEW defects of their own — a fix can carry its own
bug. Specifically: the fallback that closed the heartbeat replay hole
reproduced it on the pull path (closed here by a receiver-nonce echo); the new
compound row key `(capabilityId, sourceDetail)` was not propagated into either
truncation sort order, so truncation could silently drop half of a
`conflict`; and the new `scanGeneration` width clamp had no defined behavior at
exhaustion. All are resolved above. The standing rule this establishes: EVERY
fix round must itself be verified, and a fix that adds a field or a fallback
must be traced to every rule that consumes it (sort orders, counters, config
key names) before the round is called clean.

Rounds 8-9 came from the BUILD and from verifying the fixes, not from fresh
document reading. Round 9 closed the last two: the epoch-monotonicity claim
was STILL too strong after two narrowings (a same-second re-init can mint an
EQUAL epoch, and an epoch that climbed via `prev + 1` can exceed wall-clock, so
total state loss guarantees nothing at all — the spec now claims nothing and
names the bounded lockout plus its healer), and `machineEpoch` exhaustion had
the same missing-transition defect its sibling counter had, now specified as a
loud terminal condition. Three rounds in a row found that a FIX carried a
narrower version of the same defect: the honest generalization is that an
over-claim tends to survive rewording, so the test for "resolved" must be
"what input makes this claim false?", not "does the sentence read better now?"

Round 8 came from the BUILD, not from a reviewer, and it exposed the blind
spot that document-only convergence structurally cannot see: the spec named a
`scanGeneration` counter "incremented on every completed doorway scan" — and
no such field exists in production (absent from the scan-state writer's field
allowlist and from `src/` entirely). Seven rounds of reading the document
could not detect it, because the defect was not IN the document; it was in the
document's relationship to the code it depends on. It surfaced within minutes
of the first implementation attempt. The field is now `scanStampSecs`, derived
from the `lastScanAt` that already exists and already changes on every
completed scan. The rule this adds: a spec that names an EXTERNAL field, route,
or store must cite where that thing exists in code — and a convergence round
must include one grounding pass that checks those citations, not just internal
consistency. Prose can only be verified against prose; a build verifies against
reality.

## Glossary

- **Doorway** — a way this machine reaches LLM providers (the Claude Code
  CLI, Codex CLI, an API key); inventoried by `GET /doorways`.
- **Pool / mesh** — this agent's set of machines and their authenticated
  machine-to-machine transport.
- **Projection** — a machine's own derived, rebuildable summary of its
  capabilities; never an authority, always reconstructible from sources.
- **Heartbeat digest** — a tiny fixed-size summary riding the existing
  authenticated capacity/presence heartbeat, used only to detect "something
  changed, pull the full projection."
- **Dark** — shipped in code but disabled by config; a dark route answers
  `503` with a named code, never fabricated data.
- **Ratchet** — a repo-level lint/CI check that fails the build when a rule
  regresses, so the rule is enforced by machinery rather than review memory.

## Problem

Instar already has two useful but separate truths:

- `GET /doorways` is the doorway/model knowledge registry. It describes how a
  machine can reach model providers and overlays machine-local probe state.
- The multi-machine pool surfaces (`GET /pool`, pool machine records, mesh
  endpoint propagation, leases, placement, and capability advertisements)
  describe machines and some operational reachability.

Neither is a durable, queryable answer to: "Which machine can serve this
capability, through which doorway, with what freshness and authorization
posture?" Operators must join local `/doorways` data to pool data manually.
That creates stale routing, ambiguous failures, and multi-machine friction: a
capability can be present in a peer's config but unavailable at runtime, or a
door can be reachable locally while its advertised peer endpoint is stale.

The cross-machine registry adds a bounded, machine-qualified read model that
links a capability to its serving machine(s), doorway, endpoint reference,
verification time, and honest status. It is a projection, not a new authority:
local doorway truth and authenticated machine/mesh state remain the sources.

## Design principles

1. **Read model, not control plane.** v1 discovers and reports; it does not
   migrate sessions, mint credentials, or automatically route work. Every read
   response carries `advisory: true`, and that marker is backed by a
   structural guard, not culture (see Frontloaded Decision 17).
2. **Source-linked freshness, receiver-owned.** Every row names its source,
   observed-at time, and freshness class. Missing or stale data is represented
   explicitly, never omitted or converted to "available." Freshness authority
   belongs to the RECEIVER: peer-declared timestamps are claims, clamped to
   receiver-owned ceilings (see Trust and merge rules).
3. **Machine-qualified identity.** Keys include stable machine id and
   capability id. Nicknames are display fields, not identity. URLs are never
   display fields.
4. **Authenticated, untrusted, self-reported remote data.** Peer snapshots are
   accepted only through existing machine-authenticated mesh paths, then
   schema-clamped as untrusted data. Every remote field — including
   `probeOutcome` and `evidenceClass` — is SELF-REPORTED by the peer: authentication proves
   who spoke, never that the claim is true. Remote descriptions never become
   instructions; rows rendered into agent context ride the established
   `<replicated-untrusted-data>` envelope, and display strings are
   HTML-escaped at the render funnel.
5. **Least disclosure.** Store endpoint references and capability metadata,
   not tokens, private model prompts, or raw credential locations. Pool scope
   obeys existing operator authorization.
6. **Deterministic conflict handling with self-claim supremacy.** A machine is
   the SOLE authority for rows about itself. Contradictory cross-machine
   claims cannot enter (Trust rule 1); a machine's own-source contradictions
   remain visible with provenance rather than being silently merged.
7. **Origin-bound projections.** A machine's exported projection contains ONLY
   rows it originated about itself (hop count 0). Peer-learned rows are never
   re-exported — no claim laundering, no manufactured corroboration.

## Proposed record (v6)

Each machine keeps ONE durable artifact — its own self-projection — and ONE
in-memory, TTL-bounded map of validated peer projections. Peer rows are
deliberately NOT durable: their TTL ceiling (10 min) is far below any
restart-recovery horizon, and the digest+pull path repopulates them within a
heartbeat cycle, so durability would buy nothing and would create a durable
PII-free-but-peer-owned state surface with no clean posture. (Restart
consequence, stated honestly: for up to one heartbeat cycle after a server
restart, pool reads show peers as `unknown` with reason `no-data-yet` — the
receiver-side "no ingest yet this process lifetime" state, deliberately
distinct from the peer-side `source-unavailable` — truthful, self-healing,
and bounded.)

```json
{
  "schemaVersion": 1,
  "machineId": "mesh-machine-id",
  "machineEpoch": 1784958000,
  "projectionSeq": 172,
  "scanStampSecs": 1784958000,
  "scanState": "observed|never-observed|source-unavailable",
  "truncated": false,
  "entries": [{
    "capabilityId": "models:claude-code/claude-opus-5",
    "capabilityKind": "model",
    "doorwayId": "claude-code",
    "machineId": "mesh-machine-id",
    "probeOutcome": "positive|negative|unknown",
    "endpointRef": "mesh://mesh-machine-id/doorways",
    "observedAt": "2026-07-25T00:00:00Z",
    "receivedAt": "2026-07-25T00:00:03Z",
    "source": "local-doorways|peer-pool|mesh-heartbeat",
    "sourceDetail": "doorway-scan|doorway-manifest|pool-observation",
    "evidenceClass": "cli-present|probe-answered|manifest-only",
    "evidence": {
      "doorwayScanAt": "2026-07-25T00:00:00Z",
      "manifestVerifiedAt": "2026-07-20T00:00:00Z"
    }
  }]
}
```

Field rules (all structurally enforced, not prose):

- **`machineEpoch` (envelope-level, first-class).** ONE total-ordered minting
  rule (no source mixing): whenever the origin initializes fresh projection
  state it mints `epoch = max(wall-clock-now-seconds,
  previously-highest-emitted + 1)` — the previously-highest value read from
  the durable self-projection when present, else 0. Honest bound on that
  rule (the round-6 finding; the earlier text over-claimed): the `prev + 1`
  arm makes minting monotonic across wall-clock rollback and across any
  re-init that can still READ the durable projection. Across TOTAL state loss
  it guarantees NOTHING, and the spec claims nothing (rounds 6-8 each
  narrowed an over-claim here; this is the honest floor). With the previous
  value unreadable the origin can only mint `max(now-seconds, 1)`, which may
  be LOWER than the lost epoch (the clock ran backwards, or the lost epoch had
  itself climbed above wall-clock through the `prev + 1` arm) or EQUAL to it
  (loss and re-init inside the same wall-clock second). Both cases are
  receiver-visible and bounded, not silent: a lower pair is rejected
  `stale-projection`, and an EQUAL pair with a different digest is rejected
  `stale-projection` too (rule 2) — so a state-lost origin can be locked out
  until its watermark ages out. The healer is exactly `watermarkMaxAge`
  (24h), the lockout is therefore bounded, and the condition is diagnosable
  from `/capability-registry/health`'s per-origin rejection counters rather
  than being mistaken for a dead peer. No additional mechanism is specified,
  deliberately: the alternative (a durable per-origin nonce store on every
  receiver) buys a rare-case hour at the cost of a new durable surface.
  Minting never references the mesh machine-epoch (whose small-counter
  domain is incomparable with wall-clock values — the round-3 inversion
  finding). It
  appears ONCE per projection — never per entry — so the merge precondition
  is well-defined. Receive-side sanity clamp (anti-poisoning): an epoch
  greater than the receiver's wall-clock-now + `epochClampBound` (default
  24h — wide enough that ordinary clock drift, including the observed
  80-minute production case, never rejects an honest origin) is rejected
  with reason `clock-skew` (a skewed honest origin must not read as
  corrupt). **Watermark aging — the universal lockout healer:** a
  receiver's per-origin watermark EXPIRES after `watermarkMaxAge` (default
  24h) without an accepted projection; the next authenticated projection is
  then accepted fresh. This bounds EVERY lockout class — a poisoned
  watermark (one-time origin compromise minting ≤ now+24h of headroom), a
  forward-clock-glitch epoch preserved by the `prev + 1` arm, a reinstall,
  a crash-loop of fresh-init mints — to ≤ `watermarkMaxAge` worst case,
  with the reopened replay window bounded as in rule 2 (≤ 10 min of stale
  advisory rows). Sustained per-origin rejections are visible in
  `/capability-registry/health` counters, so a locked-out origin is a
  diagnosable state, never a silent one.
- **`projectionSeq`** — per-epoch monotonic counter, incremented on every
  projection write; persisted in the durable self-projection so a
  same-epoch rebuild continues the sequence. State loss re-mints an epoch
  under the rule above — higher in every case EXCEPT total state loss with a
  backward clock, which is the named residual healed by watermark aging (the
  round-7 finding: this sentence previously asserted "re-mints a higher epoch
  anyway", contradicting the bound stated two rules up).
- **`machineEpoch` exhaustion (round-8 finding, second pass).** Two rules can
  demand an epoch re-mint (`projectionSeq` at its ceiling, and any fresh-init
  mint), while the width clamp refuses an epoch above 11 digits — so at
  `99_999_999_999` (wall-clock year ~5138) the mandated re-mint would be
  refused and an implementer would have to violate one rule or the other.
  Normative resolution: epoch exhaustion is a TERMINAL, LOUD condition, never
  a silent wrap. The writer refuses the write, marks the local projection
  `scanState: source-unavailable`, logs at error level, and the condition is a
  `schemaVersion` bump's problem (a v2 envelope may widen the field) — exactly
  the same posture as any other unrepresentable value. It is specified not
  because it will happen but because "the implementer must invent it" is the
  defect class this spec keeps finding; a named terminal state costs one
  paragraph and removes the invention.
- **`scanStampSecs` (round-8 finding — replaces the earlier
  `scanGeneration` counter).** The observation-freshness component of the
  digest tuple is DERIVED, never counted: it is
  `floor(Date.parse(clamped lastScanAt) / 1000)`, or `0` when the machine has
  never completed a scan. Why the change: rounds 6-7 specified a
  `scanGeneration` counter "incremented on every completed doorway scan", but
  NO SUCH FIELD EXISTS in production — it is absent from the scan-state
  writer's field allowlist (`scripts/doorway-scan.mjs`) and from `src/`
  entirely, so an implementer reading `scan.scanGeneration` gets `undefined`
  forever and the propagation mechanism is silently dead (caught in review of
  the Increment-0 build, PR #1615). `lastScanAt` is the field that already
  exists, is already clamped by `DoorwayRegistryReader`, and already changes
  on every completed scan — including a no-change one — which is exactly the
  property the counter was invented to provide.
  Consequences, all benign: it needs no producer change; it has no exhaustion
  transition to define (a 10-digit epoch-seconds value is width-safe past year
  2286); and a backward clock merely changes the tuple, which triggers ONE
  bounded re-pull rather than corrupting anything, because the tuple is
  compared for INEQUALITY only (never ordered). The receiver's
  `(machineEpoch, projectionSeq)` watermark remains the sole ordering
  authority.
- **Envelope numeric width clamps (normative, so the digest bound holds by
  construction — the round-6 finding).** `schemaVersion` ≤ 3 decimal digits,
  `machineEpoch` ≤ 11, `projectionSeq` ≤ 10, `scanStampSecs` ≤ 10; all are
  non-negative integers. A value exceeding its width is refused at write and
  rejects the projection on receive (`malformed`). A `projectionSeq` at its
  ceiling forces an epoch re-mint (which resets the sequence) rather than
  overflowing. These four widths are what make the digest's single size bound
  arithmetic rather than aspirational.
- **`truncated`** — envelope boolean (clamped), present on the wire so a
  receiver renders a truncated projection as truncated, never as complete.
- **`scanState`** — envelope closed enum (`observed | never-observed |
  source-unavailable`), on the wire because an EMPTY `entries` array is
  otherwise three different truths (the round-6 finding): a scan ran and
  genuinely found nothing (`observed`), no scan has ever run on that machine
  (`never-observed`), or the underlying doorway source could not be read
  (`source-unavailable`). A receiver renders a peer's empty projection using
  this field and NEVER as "no capabilities." It is envelope semantics, so it
  joins `truncated` in the pull-decision tuple.
  **Derivation (normative — the round-8 build finding):** `observed` requires
  `lastScanAt !== null` in the scan-state, NOT mere existence of the
  scan-state file. The canonical scan-state ships with `lastScanAt: null` on a
  machine that has never completed a scan (`freshScanState()`), and main's
  reader already encodes this rule (`DoorwayRegistryReader`:
  `scanned = lastScanAt !== null`). Deriving `observed` from file existence
  reports a never-scanned machine as observed — reintroducing exactly the
  ambiguity this field exists to remove. An unreadable or corrupt scan-state
  is `source-unavailable`, kept distinct from `never-observed`; a peer projection whose
  `scanState` is not `observed` produces that machine's named failure/empty
  row (`source-unavailable`, or the receiver-side `no-data-yet` before first
  ingest) instead of an inferred-empty capability list.
- **`probeOutcome`** — closed enum (`positive|negative|unknown`): the RAW
  observed fact ("the probe answered" / "the probe failed" / "no probe").
  Derived STATUS (`available|unavailable|unknown|stale|conflict`) is NEVER
  on the wire — it is computed by whichever machine SERVES a read, from
  probeOutcome + freshness via the status matrix. A peer therefore cannot
  even express "I am available" as a claim; it can only report what its
  probe did. (This also removes the round-5 ambiguity of a derived field
  inside the fact hash.)
- **`capabilityKind`** — v1 admits `model` ONLY. `route` and `service` are
  reserved enum values REJECTED on write (kind-specific status/evidence
  contracts are a future schema bump).
- **`capabilityId`** — format-clamped (`models:<doorwayId>/<modelId>`, charset
  + length bounded), NOT membership-clamped against a second hand-maintained
  list (the doorway manifest's Opus-5 release-day staleness is the recorded
  failure mode of closed membership lists). The `models:` namespace is
  derivable only from doorway-scan output; unparseable ids are rejected.
  Canonicalization: `doorwayId` and `modelId` are lowercased, charset
  `[a-z0-9._-]` only (a delimiter or escape character in a source id rejects
  the row — no escaping games), and two ids are the same capability iff
  their canonical forms are byte-equal.
- **`endpointRef`** — a closed grammar, not a free string: MUST parse as
  `mesh://<machineId>/<enumerated-route>` where the machineId component
  MUST EQUAL the projection envelope's `machineId` (origin-bound — a lying
  origin cannot point a future consumer at another machine's routes; v1
  enumerated-route set: `doorways` only). `http(s)://` schemes, userinfo,
  query strings, and secret-shaped substrings are refused at write AND at
  receive. A sink test asserts the field never round-trips raw input.
- **`evidence`** — a CLOSED schema (exactly the two keys shown, ISO-8601
  type-clamped). Unknown keys are dropped on receive. `manifestVerifiedAt`
  carries the canonical doorway manifest's own freshness so catalog staleness
  is visible per row (source-stale distinguishable from observation-stale).
- **`evidenceClass`** — closed enum declaring probe depth: `cli-present`
  (binary/version check only), `probe-answered` (the door actually answered),
  `manifest-only` (no live probe). All values are SELF-reported;
  `receiver-verified` is deliberately reserved (absent in v1) for a future
  active-verification increment, so no v1 row can claim independent
  corroboration.
- **`receivedAt`** — stamped by the RECEIVER, never accepted from the wire.
- **`source`** — hop-0 is FIELD-ENFORCED, not asserted: the durable
  self-projection writer and the export path accept only
  `source: "local-doorways"` rows; a `peer-pool`/`mesh-heartbeat` source in
  an exported projection rejects it (`malformed`). Those two values exist
  only in the receiver's in-memory peer map, stamped by the receiver.
- **`sourceDetail`** — closed enum naming WHICH local source produced the
  row (`doorway-scan` = live scan-state, `doorway-manifest` = the canonical
  model manifest, `pool-observation` = the machine's own pool/mesh
  observation of its doorways). This field is what makes own-source
  `conflict` representable at all (the round-6 finding: `source` is pinned to
  the single value `local-doorways` on every exported row, so it cannot
  distinguish two disagreeing local sources). The local row key is therefore
  `(capabilityId, sourceDetail)`, not `capabilityId` alone: two local sources
  that disagree about the same capability both persist, and the read surface
  renders `conflict` for that `capabilityId` WITH the disagreeing
  `sourceDetail` values and their per-row `probeOutcome`/`observedAt` — which
  is what "visible with provenance" requires. `sourceDetail` is
  fact-bearing (it participates in the digest tuple) and is clamped on
  receive like every other enum; an unknown value rejects the projection
  (`malformed`).

**Status derivation matrix (normative).** Status is a pure function of
evidence and effective expiry — never stored authority:

The rows are evaluated STRICTLY in the order listed; the first matching row
wins and no later row can override it. The unknown-producing rows deliberately
sit ABOVE the expiry rows, which is what makes "`unknown` does not expire"
a structural property rather than a second competing rule (the round-6
ordering finding: with expiry evaluated first, an unknown row would have
classified `stale`, contradicting the sentence below the table).

| # | Condition (first match wins) | Status |
|---|---|---|
| 1 | No observation for the key exists | `unknown` |
| 2 | Own-source contradiction (same `capabilityId`, disagreeing `probeOutcome` across distinct `sourceDetail` values) | `conflict` |
| 3 | `evidenceClass: manifest-only` (regardless of claimed positivity) | `unknown` |
| 4 | `probeOutcome: unknown` (no probe outcome, at any `evidenceClass` or age) | `unknown` |
| 5 | Transport expiry passed (Trust rule 3 formula) | `stale` |
| 6 | Source observation aged out (`observedAt`/`doorwayScanAt` > localStaleAfter, or a stale `manifestVerifiedAt`) | `stale` |
| 7 | Fresh observation, `probeOutcome: negative` (door probe failed / model absent) | `unavailable` |
| 8 | Fresh observation, `probeOutcome: positive` | `available` |

Rows 1-4 are total over the "no usable outcome" space, so rows 5-8 are only
ever reached by a row carrying a `positive` or `negative` outcome — the
expiry arms therefore govern exactly the two statuses that can decay.
`unavailable` and `available` both decay to `stale` (never to each other) as
their evidence ages; `unknown` is the floor and does not expire, by the
ordering above. `manifest-only` evidence can never yield `available` — the
strongest it supports is `unknown` (a catalog entry proves existence in a
document, not reachability).

## Trust and merge rules (normative)

Each rule is a structural property of the registry, not guidance for a future
consumer:

1. **Origin binding.** A peer projection is accepted ONLY for the machine
   whose authenticated channel identity matches BOTH the envelope `machineId`
   and every entry's `machineId`; any mismatch rejects the WHOLE projection
   with failure reason `origin-mismatch`. A peer therefore cannot assert
   capabilities as — or about — another machine. (Rule 6's whole-projection
   rejection semantics apply to every receive-side rule.)
2. **Per-origin monotonicity (anti-replay).** The receiver keeps, per origin,
   the highest accepted `(machineEpoch, projectionSeq)` pair (in-memory,
   beside the peer map). A projection with a lower pair is rejected with
   failure reason `stale-projection`; an EQUAL pair with a DIFFERENT digest
   is also rejected `stale-projection` (one sequence number cannot name two
   states), while an equal pair with an equal digest is a no-op. A
   captured, validly-authenticated older snapshot cannot regress state or
   resurrect a retracted claim.
   Honest bound: after a receiver restart the watermark is empty, so a
   replayed old projection could be accepted once — where receiver TTL
   clamping (rule 3) caps the damage at ≤ 10 min of stale advisory rows.
   Epoch supersession (see field rules) keeps origin reinstalls recoverable.
3. **Receiver-owned freshness — transport and observation aged SEPARATELY.**
   The two freshness dimensions have different clocks and are never mixed
   (the round-4 domain-mixing finding):
   - **Transport freshness** (is the origin still standing behind this
     projection?): a single receiver-owned expression — `lastConfirmedAt +
     remoteTtlCeiling` (default ceiling 10 min; heartbeat-cadence domain),
     where `lastConfirmedAt` is a per-origin scalar set at ingest and
     refreshed by each authenticated MATCHING-digest heartbeat from that
     origin (O(1) per origin, not per row) **that is itself proven NEW**
     (see the freshness precondition below). There is NO peer-declared
     expiry anywhere in the design — the round-5 review showed any
     peer-stamped arm inevitably reintroduces steady-state-stale, and
     receiver-owned freshness makes a peer expiry claim dead weight. A
     healthy-but-unchanged peer stays transport-fresh WITHOUT full pulls;
     transport-stale means the heartbeat stopped.
     **Freshness precondition (normative — closes the round-6 replay hole).**
     "Authenticated" is not "new": a captured matching-digest heartbeat
     replayed on a loop would otherwise reset `lastConfirmedAt` forever and
     keep a dead peer permanently fresh, defeating the TTL (the epoch/seq
     watermark does not reject an equal pair with an equal digest — that is
     defined as a no-op). A heartbeat may therefore advance
     `lastConfirmedAt` ONLY when the receiver can prove it is new, by one of
     exactly two admitted proofs: (a) the mesh heartbeat carries a
     per-origin strictly-increasing sequence/nonce and this one is strictly
     greater than the last seen from that origin, or (b) the mesh heartbeat
     carries an origin-signed send time within the receiver's
     `epochClampBound` skew window AND strictly newer than the last accepted
     one. If the underlying heartbeat provides NEITHER proof, the registry
     MUST NOT treat heartbeats as confirmation at all: it falls back to
     advancing `lastConfirmedAt` only on a successful authenticated PULL
     **whose response echoes the receiver's per-request nonce** (see the
     pull-freshness rule in `## Ingest and transport` — the round-7 finding:
     without that echo the fallback inherits the very replay gap it was
     introduced to close, since an equal-pair/equal-digest response is a
     defined no-op rather than a rejection), and the affected peers simply go
     transport-stale between pulls. That fallback is the fail-closed
     direction — a peer reads stale rather than falsely fresh — and which
     mode is in force is reported by `/capability-registry/health`
     (`confirmationMode: heartbeat-sequence | heartbeat-signed-time |
     pull-only`) so the posture is never a silent assumption. Increment 1
     MUST assert the fallback in a fixture test (replayed identical
     heartbeat ⇒ `lastConfirmedAt` unchanged ⇒ row goes `stale` on
     schedule).
   - **Observation freshness** (how old is the underlying fact?):
     `observedAt` denotes when the SOURCE observation was made (for local
     rows, == `doorwayScanAt`) — NOT projection-emission time — and ages on
     the SOURCE cadence via the status matrix (`localStaleAfter`, default
     24h; scan-cadence domain). It takes no part in the 10-min expiry
     formula.
   Anti-laundering needs no `observedAt` arm: a replayed OLDER projection
   is rejected by rule 2's watermark before freshness is ever computed, and
   a NEW projection honestly carrying an old observation classifies `stale`
   through the matrix's source-age row. An `observedAt` up to 24h
   future-dated (`epochClampBound` — the same drift tolerance the epoch
   clamp uses, covering the observed 80-minute production drift) is CLAMPED
   to `receivedAt` (an observation "from the future" is treated as
   observed-now, receiver-owned honesty); beyond 24h it is rejected
   (`clock-skew`). The two skew tolerances are deliberately ONE number —
   a drift that passes the epoch clamp can never be locked out by the
   observation bound. Consumers and UI must render observation age alongside
   status — "fresh" never asserts a recent re-check beyond what
   `evidenceClass` + `observedAt` actually say.
4. **Status derives at read time — cheaply.** `GET /capability-registry`
   serves the stored/ingested snapshot; the ONLY read-time computation is
   the status matrix applied per row (probeOutcome + two freshness
   comparisons — no join recompute, O(rows served)). Status NEVER exists as
   stored state or wire data, so "a row without a fresh observation cannot
   be selected as available" is a property of the read surface itself,
   everywhere, with no stored-status staleness class even possible.
5. **Self-claim supremacy (backstop).** A machine's own authenticated live
   observation about itself always outranks any peer claim about it. Under
   rule 1 such peer claims cannot even be ingested, so this rule is the
   DECLARED DEPENDENT BACKSTOP: it exists so that any future relaxation of
   origin binding must consciously confront it, not so it fires today.
   `conflict` status covers contradictions among a machine's OWN sources
   only, shown with provenance, observe-only.
6. **Cardinality ceilings.** Per-origin entry cap (default 200 rows). An
   over-limit RECEIVED projection is rejected WHOLE with failure reason
   `over-limit` (no truncation-order gaming). The LOCAL writer never
   silently truncates its own honest derivation: if local derivation exceeds
   the cap it writes the first N rows in deterministic
   `(doorwayId, capabilityId, sourceDetail)` sort order — `sourceDetail` is
   part of the sort key because it is part of the row key, and without it two
   rows that differ ONLY in provenance TIE, making truncation nondeterministic
   and able to drop one half of a contradiction (the round-7 finding: a
   silently half-erased `conflict` would violate the visible-with-provenance
   invariant). Rows sharing a `capabilityId` are therefore adjacent and are
   retained or dropped as a GROUP: the writer never splits a
   `capabilityId`'s provenance set across the cap boundary — it stops at the
   last complete group that fits — marks the projection `truncated: true`
   (visible in every read), and logs loudly — truthful, bounded, and
   impossible to hit silently. Pool responses carry `total` +
   `truncated: true` beyond a response bound, with deterministic retention
   order: per-machine failure rows always retained, then capability rows by
   `(machineId, capabilityId, sourceDetail)` sort, with the same
   never-split-a-capability's-provenance-group rule as the local writer. The bound governs CAPABILITY rows only
   (`maxPoolResponseCapabilityRows`, default 2000) and failure rows are
   counted separately — otherwise the two rules collide whenever failures
   alone reach the bound, forcing an implementer to violate one of them (the
   round-6 finding). Failure rows need no bound of their own: there is at
   most ONE per machine, and the machine set is already bounded by the
   authenticated pool registry, so the response stays bounded by
   construction while "every machine's failure is visible" stays absolute.
7. **Closed failure vocabulary.** Every per-machine failure row's `reason` is
   a fixed enum (`timeout`, `stale-projection`, `origin-mismatch`,
   `clock-skew`, `malformed`, `version-unsupported`, `over-limit`,
   `source-unavailable`, `not-participating`, `no-data-yet`) — never verbatim
   peer/transport error text (the doorway registry's probeStatus lesson;
   also closes a prompt-injection and disclosure channel).
   `not-participating` is the mixed-enablement answer: a pool-registered,
   heartbeat-fresh machine whose heartbeats carry NO capability digest has
   the feature dark — honestly distinguishable from a broken
   (`timeout`/`malformed`) or source-empty (`source-unavailable`) peer.
8. **Bounded lifetimes, no GC machinery.** Remote rows are in-memory and
   expire under their receiver-clamped TTLs; a machine absent from the
   authenticated pool registry drops from the peer map immediately on
   registry removal. The durable self-projection is fully re-derived on
   every rebuild, so a frozen projection cannot present dead local
   capabilities after re-enable — the projection rebuilds before it serves
   (`snapshotStale` flagged until the first rebuild completes).

## Ingest and transport (ONE chokepoint)

There is exactly ONE peer-data ingest path, and every Trust rule runs inside
it:

- Each machine's heartbeat carries a fixed-size capability digest, encoded
  as the compact string
  `cap1:<schemaVersion>:<machineEpoch>:<projectionSeq>:<truncated 0|1>:<scanState 0|1|2>:<scanStampSecs>:<entriesSha256-16hex>`
  — **≤ 64 bytes, and that bound is arithmetic, not aspirational**: the
  envelope width clamps above (3 + 11 + 10 + 10 decimal digits, one digit
  each for `truncated` and the `scanState` ordinal, a 16-hex truncated
  entries hash, the 4-byte `cap1` tag and 7 separators) sum to 63 bytes
  worst case. A value that would exceed its clamp is refused at write, so an
  over-long digest cannot be emitted. (Round-6 finding: this bound and
  Frontloaded Decision 14 previously disagreed — 72 vs 64 — and neither
  followed "by construction" without the width clamps; both now read 64.)
  `scanState` is encoded as an ordinal (`0 = observed`, `1 = never-observed`,
  `2 = source-unavailable`) so envelope semantics, not just entry content,
  drive the pull decision. A machine with the feature dark emits NO digest
  (see failure reason `not-participating`).
- **Digest determinism (normative):** `entriesSha256` is computed over a
  CANONICAL serialization of the FACT-BEARING fields ONLY —
  `(capabilityId, capabilityKind, doorwayId, machineId, probeOutcome,
  endpointRef, source, sourceDetail, evidenceClass)` per entry, entries
  sorted by `(doorwayId, capabilityId, sourceDetail)` — `sourceDetail` joins
  the sort key because it is part of the local row key, so two disagreeing
  local sources for one capability serialize deterministically instead of
  colliding. JSON with sorted keys. `scanStampSecs` is DERIVED from the
  scan-state's clamped `lastScanAt` (see the field rules) — it propagates
  OBSERVATION freshness: a scan that changes no facts still re-stamps
  `lastScanAt` and therefore bumps the digest tuple, triggering one bounded
  re-pull per origin per scan (daily cadence, ≤200 rows) that refreshes
  receivers' stored `observedAt`, so stable healthy fleets never decay to
  false observation-staleness (the round-5 non-propagation finding, now
  carried by a field that actually exists — the round-8 finding). Timestamps (`observedAt`,
  `doorwayScanAt`, `manifestVerifiedAt`) are EXCLUDED from the
  hash: a rebuild that merely re-stamps time does not churn the digest, so
  digest-compare stays a no-op for unchanged facts (the round-4
  volatile-timestamp finding). Two rebuilds of identical facts produce
  identical digests (fixture-tested in Increment 1).
- The PULL DECISION keys on the tuple `(schemaVersion, truncated, scanState,
  scanStampSecs, entriesSha256)` — envelope semantics changes fetch too, so a
  version bump or truncation change cannot hide behind identical entries
  (the round-4 envelope-fields finding). An epoch/seq bump with an
  unchanged tuple updates the watermark from the digest without fetching
  identical content. Watermark advance and the `lastConfirmedAt` re-clamp
  apply ONLY to digests authenticated directly as the origin — an
  indirectly-propagated digest can trigger a pull, never advance trust
  state. When the entries hash differs from the last
  ingested state, the receiver fetches the full projection via the EXISTING
  authenticated pull verb (the pull re-authenticates the origin — an
  indirectly-propagated digest can trigger a pull but can never bypass rule
  1's channel-identity check) and runs it through the validation funnel
  (rules 1-3, 6, schema clamps). A validation REJECTION counts as a pull
  failure for the brakes below — a stale-locked or misbehaving origin is
  backed off, not re-pulled every heartbeat.
- Per-origin pull brakes (P19, declared): exponential backoff on pull
  failure, a per-origin breaker after 5 consecutive failures (half-open
  retry each 10 min), and full pulls jittered on mesh-reconnect AND on
  receiver process restart (neither a partition heal nor a reboot
  synchronizes N simultaneous pulls). A peer whose entries hash genuinely
  flips every heartbeat is bounded to one 200-row pull per heartbeat cycle
  per origin — sustained-but-bounded, and visible in ingest counters.
- **Pull freshness (normative — the round-7 finding).** Because the RECEIVER
  initiates a pull, it needs no assumption about the transport to obtain a
  liveness proof: every pull request carries a receiver-generated single-use
  nonce, and the response MUST echo it. `lastConfirmedAt` advances ONLY on a
  nonce-echoing response. A captured older response cannot carry the current
  nonce, so it can neither refresh transport freshness nor extend a dead
  peer's TTL — and this holds in `pull-only` confirmation mode, which is
  exactly the mode chosen when the heartbeat cannot prove newness. A
  missing-or-wrong-nonce response is a named failure row (`malformed`) and
  counts as a pull failure for the brakes.
- Transport replay posture, stated honestly: the pull verb re-authenticates
  per request, and the nonce echo above makes RESPONSE replay ineffective for
  FRESHNESS; rules 2-3 (epoch/seq watermark + TTL clamps) remain the
  defense-in-depth against a replayed response's CONTENT. What is deliberately
  NOT claimed: that the underlying mesh transport is nonce-replay-proof — the
  design stops depending on that property rather than assuming it.
- `GET /capability-registry?scope=pool` performs NO fan-out of any kind: it
  serves the union of the durable self-projection and the in-memory
  validated peer map. Peer failure rows come from the ingest state (last
  attempt outcome per origin). This deliberately does NOT depend on the
  WS4.4(f) shared pool poll-cache (dark on the fleet) or any other read-time
  carrier — the read is O(serve-local) by construction.

## Surfaces and ownership

- `GET /capability-registry` — this machine's redacted projection. Serves the
  stored snapshot (validation once at ingest; read-time work is rule 4's
  per-row timestamp comparison only). `200` with `scanState:
  "never-observed"` and empty entries when no observation exists
  (truthful-empty, mirroring `/doorways`' `never-run`); `503` ONLY when the
  feature flag is dark. Disabled reads as disabled; empty reads as empty —
  never interchangeable.
- `GET /capability-registry?scope=pool` — the local-serve merged view (see
  Ingest and transport). Per-machine failure rows with the closed reason
  enum; mixed failures return `200` with `pool.failed` rows — never a 500,
  never an omitted machine. Authorization: the same operator-Bearer +
  pool-visibility gate as `GET /pool` / `GET /sessions?scope=pool`; pool
  scope is DENY-BY-DEFAULT (route refuses) until its increment enables it.
- `POST /capability-registry/refresh` — Bearer-auth, LOCAL-projection rebuild
  ONLY: re-reads existing doorway scan-state and pool observations. It NEVER
  invokes doorway probes (nothing metered — metered probes stay human-manual
  per the doorway spec) and NEVER triggers transitive peer refreshes.
  Single-flight (concurrent calls coalesce), rate-limited 1 per 5 min with
  `429`, jittered when fired on mesh-reconnect.
- Every read response carries `advisory: true` and rows carry their
  self-reported `evidenceClass`. The marker is enforced by Frontloaded
  Decision 17's ratchet, and the dashboard follow-up must render
  uncorroborated (all v1) claims distinguishably.
- `/capabilities` advertises the read surfaces only once the flag actually
  serves them on this install (advertising a dark route breaks
  Self-Discovery).

The existing `/doorways` registry remains authoritative for doorway/model
facts on each machine. Existing pool and mesh endpoint routes remain
authoritative for machine identity and transport reachability. The new
registry owns only the join, freshness classification, and conflict
presentation.

## Multi-machine posture

- **Durable self-projection** (`state/capability-registry.json`, hop-0 rows
  about this machine only): machine-local BY DESIGN.
  machine-local-justification: physical-credential-locality — a machine's
  doorway reachability is a function of the CLI logins and credentials that
  physically live on that machine's disk; its self-projection cannot be
  authored anywhere else. (Peer-learned rows are NOT in this file — they are
  in-memory only, so the durable surface is exactly the credential-local
  part.)
- **In-memory peer map + anti-replay watermark**: transient receiver state,
  not a durable surface; posture question does not arise (nothing on disk,
  rebuilt within one heartbeat cycle, loss consequences stated in Trust
  rule 2).
- **Pool view**: proxied-on-read from local ingest state — nothing
  replicates as authority (replicating projections would recreate rejected
  Alternative B; reach is not authority).
- **User-facing notices** (the Increment 4 attention item): raised by the
  serving-lease holder ONLY (elected-raiser precedent) — one voice. The
  hysteresis/episode state is holder-local; a lease move mid-episode resets
  the 3-tick counter (honest reset semantics — worst case one delayed item,
  never a duplicate).
- **Generated URLs**: none — `endpointRef` is an opaque mesh route reference
  by closed grammar; no URLs cross machine boundaries.
- The refresh job runs per-machine over its own projection.

## Decision points touched

| Decision point | Class | Rationale / floor |
|---|---|---|
| Truthful-empty reads (missing never becomes `available`) | invariant | Constitutional honesty; enforced at the read surface. |
| Peer data authenticated-then-untrusted, schema-clamped, never instructions | invariant | WS2.x envelope convention; closed schemas above. |
| No tokens / credential paths / URLs in any row | invariant | Least disclosure; endpointRef closed grammar + sink test. |
| Read-model-not-control-plane (no v1 consumer routes work from this) | invariant | Signal vs. authority; `advisory: true` + the FD-17 ratchet; consumer requires the separate tracked spec (ACT-1153). |
| Every peer failure is a named closed-enum row, never an omitted machine | invariant | No Silent Degradation. |
| Origin binding + monotonicity + self-claim backstop | invariant | Deterministic trust rules; no judgment involved. |
| Freshness/status classifier (TTL, skew, stale thresholds) | judgment-candidate | Floor: a row past effective expiry may NEVER classify `available`; conservative default `unknown`. Arbiter: config-tunable ceilings with spec-named defaults (FD 2). |
| Conflict presentation (own-source contradictions) | judgment-candidate | Floor: contradictions are never silently merged; observe-only in v1. Arbiter: spec-fixed rule now; operator-resolution flow only via a future spec. |
| Refresh/pull budget & brakes | judgment-candidate | Floor: single-flight + rate-limit + per-origin backoff/breaker + zero LLM spend + no metered probes. Arbiter: config knobs with named defaults. |
| Increment 4 attention thresholds | judgment-candidate | Floor: ONE aggregated deduped item (Bounded Notification Surface); hysteresis required. Arbiter: config with named defaults (FD 8). |

## Frontloaded Decisions

1. **Vocabulary:** v1 admits only `models:<doorwayId>/<modelId>` rows whose id
   parses under the format clamp and whose doorway id is a registered
   doorway. `route`/`service` kinds: reserved, rejected on write. The
   `models:` namespace is derivable only from doorway-scan output — format
   is clamped in code; membership is NOT a second hand-maintained list.
2. **Freshness defaults:** transport TTL ceiling 10 min (≥ 2× the 30s-5min
   transport cadences, anti-flap), applied via Trust rule 3's
   transport-only formula with the per-origin `lastConfirmedAt` re-clamp;
   observation freshness ages separately on the source cadence
   (`localStaleAfter` 24h). Future-dating skew is ONE number, not two:
   `epochClampBound` (24h) bounds BOTH the epoch sanity clamp and the
   `observedAt` future-clamp, and `watermarkMaxAge` is also 24h. The
   round-6 finding removed a third, contradictory "±2 min" tolerance and its
   `skewToleranceMs` key — two different published numbers for one bound is
   exactly the drift a converged spec must not ship. Config-tunable
   (`capabilityRegistry.freshness.*`) — numbers cheap-to-change-after
   behind the dark flag; the classifier floor is invariant.
3. **Transport:** the digest+pull design in `## Ingest and transport` — one
   chokepoint, no new mesh RPC, no new trust path, no read-time fan-out.
4. **Persistence:** durable atomic-write JSON at
   `state/capability-registry.json` for the SELF-projection only
   (single-writer funnel, temp-file+rename — the torn-state lesson; all
   source adapters feed one writer). Peer rows in-memory only. Explicitly
   NOT the replicated-store foundation. Container choice
   cheap-to-change-after (drop-and-rebuild; the anti-replay watermark is
   deliberately NOT stored in it — see Trust rule 2).
5. **HTTP contract:** `200` truthful-empty with `scanState`, `503`
   only-when-dark, pool partial failures as named rows in a `200`. Dark ≠
   empty, structurally distinct.
6. **Authorization:** `scope=pool` rides the same gate as `GET /pool`;
   deny-by-default until the increment that enables it. Per-row owner
   restrictions: a named follow-up (all rows pool-visible-redacted in v1).
7. **Conflict:** self-claim supremacy as a declared backstop (Trust rule 5);
   cross-machine contradictions cannot enter by construction; own-source
   `conflict` stays observe-only with provenance.
8. **Refresh cadence/budget:** the `capability-registry-refresh` job (ships
   `enabled: false`) is THE local-rebuild driver; a completed doorway-scan
   run ALSO triggers a rebuild (event, not cadence), so the two jobs
   compose without a second schedule. Peer ingest rides the heartbeat
   digest. Attention: ONE deduped aggregated item after 3 consecutive
   all-stale ticks counted over PARTICIPATING peers only —
   `not-participating` (feature-dark) machines are excluded from the
   hysteresis, and a tick with ZERO participating peers counts as nothing
   (never toward the alarm — vacuous all-stale must not fire it). A cohort
   machine in a mostly-dark fleet therefore never alarms about healthy
   non-participants, while dark peers stay VISIBLE as `not-participating`
   rows (excluded from alarms, never from the view). Priority medium,
   episode-keyed. Numbers config-tunable, cheap-tagged.
9. **Granularity:** v1 contract is exactly the v6 record's field set. Quotas
   / prompt-support / channel-compat are ADDITIVE optional fields behind a
   `schemaVersion` bump. The routing-consumer minimum contract belongs to
   the future routing spec (ACT-1153), which MUST treat every remote claim
   as an unverified hint requiring local confirmation before commitment —
   self-reported `evidenceClass` never substitutes for receiver
   verification (the reserved `receiver-verified` class is that future
   increment's contract).
10. **Operator UX:** dashboard rendering SCOPED OUT of Increments 0-4
    (API-only, as `/doorways` shipped). The follow-up is REGISTERED
    (ACT-1156, Close the Loop): a section of the existing Machines tab
    rendering self-reported claims distinguishably; mobile failure summary
    one line per machine
    ("<nickname> — N capabilities, M stale, K failed (as of <age>; oldest
    observation <age>)").
11. **Config keys (named):** `capabilityRegistry.enabled` (Increment 2+;
    omitted ⇒ resolveDevAgentGate — live on a development agent, dark on
    the fleet), `capabilityRegistry.poolScope.enabled` (Increment 4 cohort),
    `capabilityRegistry.freshness.{remoteTtlCeilingMs,localStaleAfterMs,epochClampBoundMs,watermarkMaxAgeMs}`
    (there is deliberately NO `skewToleranceMs` — `epochClampBoundMs` is the
    single future-dating bound),
    `capabilityRegistry.limits.{maxEntriesPerMachine,maxPoolResponseCapabilityRows}`
    (the pool bound governs CAPABILITY rows only — per-machine failure rows are
    counted separately and never dropped; see Trust rule 6).
    Job manifest: `capability-registry-refresh`, ships `enabled: false`.
    Config defaults ride `migrateConfig()`; the CLAUDE.md template entry
    (FD 16) rides `migrateClaudeMd()` — both per Migration Parity.
12. **Dark-route semantics:** dark = `503` with `code:
    "capability-registry-dark"`, NEVER the truthful-empty `200` (the round-1
    draft's rollback text pre-decided the dishonest direction; corrected).
13. **Schema forward-compat:** a peer projection with unknown/higher
    `schemaVersion` is a named failure row (`version-unsupported`), never a
    silent drop and never a partial parse — specified BEFORE Increment 3
    (mixed versions are the NORMAL state during a rolling update).
14. **Validation clamp numbers:** maxEntriesPerMachine 200,
    maxPoolResponseCapabilityRows 2000, string fields ≤ 256 chars, evidence
    exactly 2 keys, heartbeat digest ≤ 64 bytes — and that digest bound is
    made arithmetic by the envelope width clamps it depends on
    (`schemaVersion` ≤ 3 digits, `machineEpoch` ≤ 11, `projectionSeq` ≤ 10,
    `scanStampSecs` ≤ 10, `truncated`/`scanState` one digit each, 16-hex
    entries hash ⇒ 63 bytes worst case). The ingest section states the SAME
    64-byte number; the round-6 finding corrected an earlier 72-vs-64
    disagreement between the two sections. Cheap-tagged with one constraint:
    `limits.*` must be changed fleet-uniformly (or receiver limit ≥ any
    origin's cap) — a receiver with a lower cap than an origin's honest
    projection rejects it loudly (`over-limit`), which is visible but
    avoidable drift.
15. **Testing:** Increment 1 fixture tests as listed — INCLUDING the four
    round-6/7 regression fixtures: (a) a replayed identical heartbeat AND a
    replayed pull response each leave `lastConfirmedAt` unchanged so the row
    goes `stale` on schedule (the pull case covers `pull-only` mode; a
    wrong-nonce response classifies `malformed`),
    (b) the status matrix is TOTAL (every `(probeOutcome, evidenceClass,
    age)` combination classifies, with `probeOutcome: unknown` never
    reaching an expiry arm), (c) two disagreeing `sourceDetail` rows for one
    `capabilityId` render `conflict` WITH both provenances, and (d) a
    maximum-width envelope serializes to a digest ≤ 64 bytes while an
    over-width value is refused at write — PLUS Tier 2 integration
    tests over the full HTTP pipeline (`/capability-registry`,
    `/capability-registry/health`, and `scope=pool` including
    partial-failure rows) PLUS the Tier 3 E2E feature-alive lifecycle test
    (production init path; route answers `200` truthful-empty, not `503`)
    — all three tiers, from the increment that mounts each surface
    (Testing Integrity Standard).
16. **Agent awareness:** the CLAUDE.md template gains the Registry First
    entry ("which machine can serve capability X?" → `GET
    /capability-registry`) in the SAME PR that mounts the route, delivered
    to existing agents via `migrateClaudeMd()` (FD 11).
17. **The advisory marker is ratcheted, not cultural:** the SAME PR that
    mounts the route ships a named lint/ratchet — "no non-test code consumes
    `/capability-registry` responses for admission, placement, or routing
    decisions" — registered against the read-model invariant in the
    Standards Enforcement Coverage inventory, so a future in-repo consumer
    cannot quietly promote this surface to authority. (Round-2 finding: an
    unchecked `advisory: true` is decorative; this is the structural guard.)

## Maturation plan

- **test-agent-live:** Increment 1's synthetic two-machine fixtures run in CI
  from the first PR; the test agent (Codey's install) arms the route the
  moment Increment 2's release reaches it, via an EXPLICIT
  `capabilityRegistry.enabled: true` (never an assumption about how the
  dev-agent gate resolves on his install).
- **dev-agent-live:** Increment 2 — route live on the development agent
  (Echo), observe-only, refresh job armed manually.
- **fleet:** Increment 3 ships dark fleet-wide; Increment 4 enables a
  bounded cohort whose doorway-scan job is enabled (tracked precondition:
  ACT-1155).
- **graduation criterion:** 7 days of Increment-4 cohort soak with zero
  false `available` classifications (spot-audited against live doorway
  state), zero unbounded-growth events, and the attention item firing only
  on genuine sustained staleness. The measurement surface is
  `GET /capability-registry/health` (mounted with Increment 2): ingest
  counts, rejections by closed reason PER ORIGIN (a locked-out or skewed
  origin is diagnosable, never silent), pulls, breaker states, watermark
  ages, and per-status row counts — Increment 4's "publish metrics" refers
  to THIS surface, so the criterion is measurable, not aspirational.
- **dark-window:** each increment's flag stays dark ≥ 48h after its release
  reaches an install before being enabled there.
- Tracked dependencies (pinned against auto-expiry sweep — both are
  deadline-bearing registry entries, not ordinary pending items):
  ACT-1153 (routing consumer, deliberately deferred), ACT-1155
  (doorway-scan graduation, Increment 4 precondition).

## Alternatives considered

### A. Proxy `/doorways` from every peer on each request

Rejected for v1: couples dashboard latency to peer availability, creates
partial-response ambiguity, and makes repeated reads expensive. The
digest+pull ingest keeps reads local; a true "live probe" mode may layer on
later.

### B. Copy every peer's doorway JSON into one canonical global store

Rejected: creates a second authority, loses machine-local posture, and makes
conflicts look like consensus. Keep projections machine-local and merge only
at the read surface. (Origin binding — Trust rule 1 — also closes the
indirect version: hop-0 export makes re-exported corroboration impossible.)

### C. Let the scheduler route work immediately from the registry

Deferred to a separate spec, tracked as ACT-1153 (Close the Loop: a
registered work item, not prose). That spec must define admission, lease
ownership, fallback, operator override, hard fail-closed on unknown/stale
claims, and local confirmation of self-reported remote claims (FD 9).

### D. Use one generic "online" boolean

Rejected: online transport does not prove a doorway or capability is usable.
Rows retain independent doorway, mesh, and freshness evidence — plus
`evidenceClass`, so probe depth is honest per row.

### E. Industry patterns (service discovery / gossip / CRDT)

What we borrow and what we deliberately avoid: from Consul/Kubernetes-style
discovery we borrow TTL-bounded health rows and explicit
readiness-vs-liveness separation (`evidenceClass` is our readiness-depth
analog), but reject the trusted central catalog (recreates Alternative B in
a mesh whose machines are mutually authenticated, not mutually trusted).
From gossip (SWIM-style) we reject transitive claims outright — origin
binding forbids exactly what gossip optimizes — and our convergence-speed
need is met by the existing heartbeat cadence. From CRDT/LWW registers we
reject silent last-writer-wins conflict resolution ("conflicts look like
consensus"); we keep contradictions visible with provenance instead.
Watch/anti-entropy semantics are unnecessary at pool scale (≤ tens of
machines): digest-compare per heartbeat IS our anti-entropy, at fixed cost.
The nearest standard pattern is HTTP conditional caching, and v1 is
deliberately isomorphic to it: the digest IS an ETag, the digest-change
pull IS a conditional GET, `remoteTtlCeiling` IS the Cache-Control TTL,
and `scanStampSecs` IS a Last-Modified stamp. What we add beyond ETag-style
caching is exactly the part a mutually-authenticated-but-not-mutually-
trusted mesh requires and a trusted HTTP origin does not: origin binding,
the anti-replay watermark, and receiver-owned freshness. Everything else
reuses existing primitives (heartbeat, pull verb, breakers, attention
aggregation) rather than new machinery.

## Rollout ladder and rollback

### Increment 0 — schema and read-only local projection (dark)

Define the schema, validation limits, closed enums, source adapters behind
the single-writer funnel, and a local status reader. No route mounted, no
peer traffic. Rollback: delete the unreferenced schema/reader.

### Increment 1 — test rung

Fixture tests cover local `/doorways` joins, stale expiry, receiver TTL
clamping (all three formula arms + the matching-digest re-clamp),
origin-mismatch rejection, epoch/seq replay rejection (including epoch
supersession recovery, the epoch sanity clamp, and watermark aging healing
a locked-out origin), timestamp-excluded digest stability (a re-stamped
rebuild does not churn the digest), over-limit
whole-rejection AND the local truncated-flag path, malformed rows,
version-unsupported rows, digest determinism (two rebuilds of identical
state → identical digests), `not-participating` classification, digest-flap
brake behavior, and partial pool failures. A synthetic two-machine mesh
proves machine identity binding and no-token disclosure (endpointRef sink
test). Rollback: disable the test-only adapter.

### Increment 2 — development agent (observe-only)

Mount `GET /capability-registry` locally (dev-agent gate resolution),
populated from this agent's actual doorway scan plus authenticated pool
observations; ship the Tier 2 + Tier 3 tests with it. The refresh job ships
`enabled: false`. Rollback: `capabilityRegistry.enabled: false` — routes
answer the documented dark `503`, refresh stops.

### Increment 3 — fleet dark read surface

Ship route + schema fleet-wide, dark by default. Peer scope and refresh stay
dark. The `version-unsupported` forward-compat contract (FD 13) is REQUIRED
here. **Population dependency, stated honestly:** the local source is the
doorway-scan job, which ships `enabled: false` fleet-wide — a fleet machine
that never runs it projects `scanState: "never-observed"` truthfully and
permanently. Increment 3 therefore ships KNOWINGLY INERT on the fleet, and
graduating the scan job is a NAMED, TRACKED precondition of Increment 4
(ACT-1155) — without it, Increment 4's cohort would observe nothing and its
attention item would be permanently meaningless (the dark-but-load-bearing
lesson; the surface itself is advisory-only, so `dark-default` is its honest
class, not a G3 load-bearing gap).

### Increment 4 — fleet observe-only

Enable pool read/refresh for a bounded cohort whose scan job is enabled
(ACT-1155 delivered). Publish metrics and ONE aggregated attention item
(lease-holder raiser, 3-tick hysteresis) for sustained stale/conflict. No
consumer may make routing or admission decisions from this surface (FD 17's
ratchet). Rollback: cohort disable + refresh stop; remote rows expire from
memory under receiver TTLs; local rows rebuild on next scan.

### Future increment — supervised routing (not in this spec)

Tracked as ACT-1153. Only after convergence and soak evidence may a separate
spec authorize a consumer; it must define lease ownership, fallback, operator
override, hard fail-closed on unknown/stale claims, and receiver-side
confirmation of self-reported claims (FD 9).

## Security, privacy, and multi-machine failure posture

- Peer reads require existing machine authentication and authorization; no
  new trust path is implied. Pool scope is deny-by-default until its
  increment enables it.
- All clamps are enumerated with numbers (FD 14); enums are closed;
  `evidence` is a closed schema; unknown keys drop on receive.
- Never return tokens, credential paths, raw model prompts, or tunnel URLs.
  `endpointRef` is grammar-enforced opaque; display fields carry no URLs;
  pool rows are machine-qualified and redacted.
- A peer timeout, stale/replayed projection, origin mismatch, clock-skew
  rejection, malformed payload, unsupported schema version, or over-limit
  projection yields a NAMED closed-enum failure row, not an omitted machine
  and not verbatim error text.
- Local and remote evidence are labeled separately, with self-reported probe
  depth (`evidenceClass`). "Unknown" is not "down," "reachable" is not
  "capable," "CLI present" is not "model answered," and — the residual
  accepted risk, named honestly — an authenticated peer CAN lie about
  itself in v1; nothing downstream may treat such claims as verified
  (FD 9 / FD 17).
- Rows rendered into agent context ride the untrusted-data envelope; rows
  rendered into HTML are escaped at the funnel.

## Open questions for convergence

*(none — all resolved into Frontloaded Decisions above)*

## Non-goals

No implementation, automatic routing, credential synchronization, peer
configuration mutation, new login/enrollment flow, or LLM-based capability
classification is included in ACT-409. The supervised routing consumer is
explicitly out of scope and tracked as ACT-1153.
