# Side-Effects Review — The pool read path, attempt/pause ledger and admission rules (Increment 8)

**Version / slug:** `passkey-inc8-pool-read-path`
**Date:** `2026-09-23`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (a cross-machine read path whose verdicts refuse enrollment and proofs)`

## Summary of the change

Increment 8 of the approved spec `docs/specs/agent-held-google-passkey.md` (§5.1 "Pool read path" +
its "what each machine may do" table, the §3.7 rate limits, the §4 peer classification / same-account
gap / pauses / 72h exclude offer). Nothing here mints, proves or uses a passkey; it is the shared
substrate the enrollment, cold-proof and health increments consume so that every pool-wide safety
bound is enforced across ALL of an agent's machines, never per machine.

- **`PasskeyPoolState.ts`** (new):
  - `PasskeyAttemptLedger` (`state/passkey-attempts.json`, 0600, atomic): attempt rows (enrollment /
    proof / canary / repair) stamped with THIS machine's id, pruned after 24h; pauses (account-scoped
    throttle/risk, machine-scoped throttle) with an identical open pause EXTENDED, never duplicated;
    a corrupt file THROWS (a ledger that silently read empty would let a bound evaporate).
  - `PasskeyPeerExclusions` (`state/passkey-peer-exclusions.json`): exclude / include / list, idempotent.
  - `PasskeyMachineState` — the publishable per-machine state: cells (canonical email, granted,
    grant seq, custody by NAME, googleCreatedAt, `health: 'unknown'` until §4 lands), attempts,
    pauses, grant echoes, revoke high-water, outbox rows (no bundles), `pushEnabled`, `suspension:
    null` (the lease holder's record lands with the health increment). `clampPasskeyMachineState`
    treats a peer body as mesh-peer DATA: schema + machine-id match required, every row type-clamped
    and length-bounded, every row re-stamped with the REGISTRY machine id (a peer cannot forge another
    machine's rows), malformed rows dropped.
  - `classifyPasskeyPeer`: answered ⇒ `observed`; else excluded ⇒ `excluded`; else rope
    `peer-offline` (and rope available) ⇒ `peer-offline`; else `partitioned` — including rope health
    absent (§4: it is itself dev-gated, so absence blocks rather than trusts).
  - Pure checks: `enrollmentRateLimit` (one enrollment per cell per 30 min; three per account per
    day POOL-WIDE where proofs/canaries/repairs COUNT toward the figure but only an enrollment is
    refused), `sameAccountGap` (6h across DIFFERENT machines; own-machine and repair rows never
    block), `activePauseFor`, and `poolAdmission` — the §5.1 table evaluated most-restrictive-first
    (partitioned peer ⇒ no enroll/prove/canary; suspended ⇒ canary only + repair by degraded
    override; stopped / kill switch ⇒ no sign-ins, repair by override; lease holder unreachable ≤24h
    ⇒ last-known, older ⇒ `passkey-suspension-unknown`; revoke always, `queued` past a silent peer).
  - `PasskeyPoolReader`: one query per peer per tick, in parallel, 5 s per peer + 5 s overall (a
    peer past the overall budget is `timeout`), single-flight, memo with a TTL (the server sets it
    to the tick interval, so `?scope=pool` and every check are served from the memo for a whole
    tick — a dashboard polling every few seconds never re-fans), LAST-KNOWN rows kept durably in
    `state/passkey-pool-lastknown.json`. An UNREADABLE or wrong-version cache is handled in the
    restrictive direction (second-pass finding): every silent peer reads `partitioned` (its lost
    rows may have held a pause), the file is never overwritten, and `degradedReasons` names
    `last-known-cache-unreadable`. Exclusions auto-clear when a peer answers; the 72h exclude
    offer is flagged only for a peer that WAS observed once (a never-seen peer may be brand new).
    Peer failures classify; a corrupt LOCAL ledger or exclusion file REJECTS the tick (fail closed,
    the route answers 500) — the reader does not promise "never throws".
- **Routes** (same dev gate): `GET /passkeys` (+ `?scope=pool` from the memo, with `ageMs`),
  `GET /passkeys/pool-state` (Bearer transport; a caller naming itself via `X-Instar-Machine-Id`
  must be ACTIVE in this machine's registry AND not recovery-quarantined — revoked / pending /
  unknown / quarantined ⇒ 403; an unreadable quarantine ledger refuses), `POST
  /passkeys/pool-state/tick`, `GET /passkeys/admission` (read-only; honest `inputs` saying the
  suspension record and lease-holder state are not published on this build), `POST
  /passkeys/exclude-peer` / `include-peer` (PIN; unknown machine 409; self refused), plus the two
  ops in `PasskeyCellActions` (applied when the exclusion store is wired, else honest not-available).
  Every peer body is bounded to 1 MB BEFORE parsing (the row caps apply after) on both fetch paths.
- **Server wiring**: when `passkeys.enabled` resolves on, one `PasskeyPoolReader` per server with a
  5-minute `setInterval` (unref'd, cleared at shutdown); the production fetch carries the Bearer +
  `X-Instar-Machine-Id`, refuses non-allowlisted peer URLs, and classifies failures with the pool
  fan-out vocabulary (never a URL). Routes use the server instance when present, else ONE
  router-owned fallback reader shared across requests (single-flight + memo, no timer) — never one
  reader per request.
- Docs: API rows for the six routes + a features-page section.

**Not in this increment:** the suspension record / canary state machine and the lease-holder
publication (§2, §4) — `poolAdmission` already evaluates those rows, but the route feeds them
`none`/`self` and SAYS so; the health watcher that records proof outcomes and writes pauses (§4);
the enrollment/proof workers that WRITE attempt rows (this increment ships the ledger and the
checks they call); the 72h "exclude machine X?" digest buzz (the flag `excludeOfferDue` is computed;
the digest is the §5.2 notice increment); the four replicated store kinds (the pool read path IS the
fallback while they are dark, §5.1). <!-- tracked: CMT-544 -->

## Decision-point inventory

- `classifyPasskeyPeer` — add — deterministic over (answered, excluded, rope); restriction-first.
- `enrollmentRateLimit` / `sameAccountGap` / `activePauseFor` — add — pure arithmetic over merged rows.
- `poolAdmission` — add — the spec's table, most-restrictive-first; no heuristic.
- `GET /passkeys/pool-state` caller check — add — registry status of a self-named caller (Bearer still required).

---

## 1. Over-block

- A partitioned peer blocks enrollment and proofs on EVERY other machine until it answers or is
  excluded; the spec accepts this (residual: rope health confirms a partition in 30–90 min, so a
  live-but-briefly-unreachable peer can look partitioned for one tick — one skipped tick, nothing
  lost). Repair and revoke are never blocked by it.
- Rope health absent ⇒ every silent peer is `partitioned` (never `peer-offline`): on an agent without
  the rope monitor, a closed laptop blocks enrollment on the others until excluded. Chosen because
  rope health is itself dev-gated and "presumed offline" would be the permissive guess (§4).
- Last-known rows of an offline/excluded peer keep counting until their own timestamps expire (24h
  for attempts, the pause's own end): a machine that went offline right after an attempt still
  bounds the pool for up to a day. Intended (§4 "worst-case last-known rows").
- A caller naming itself with a machine id that this machine's registry has not admitted yet
  (`pending`) is refused the pool state — the bootstrap direction (Know Your Principal).
- **A mixed pool blocks enrollment until the operator acts** (likely first-day experience): a fleet
  peer with `passkeys` dark answers 503 ⇒ `route-missing` ⇒ `partitioned` ⇒ every dev-agent
  enrollment/proof refuses `passkey-pool-state-unavailable` until that machine is excluded
  (`exclude-peer`) or updated. Spec-consistent (an unobserved peer), stated here so it is expected.
- An unreadable last-known cache turns every silent peer `partitioned` until the file is repaired
  or removed — deliberately louder than the alternative (silently losing an offline peer's pause).
- **Schema note for later increments:** `schemaVersion: 1` is a hard reject on read, so a schema bump
  by the health/suspension increments would make not-yet-updated peers read updated ones as
  `malformed` ⇒ `partitioned` ⇒ a pool-wide enrollment freeze during a rolling update. Those
  increments must keep v1 ADDITIVE (new optional fields) or tolerate v1..vN on read.

## 2. Under-block

- `X-Instar-Machine-Id` is a self-declared header over the shared Bearer token: it lets a de-paired
  machine that STILL holds the token be refused by name, but it cannot prove the caller's identity
  (the signed passkey-cell path does; this read carries no secret). A caller omitting the header is
  served — the state is non-secret by construction (canonical emails, seqs, custody by name).
- Peer rows are trusted mesh-peer data (§1.1/§5.1): a lying peer can only make this machine STRICTER
  (more attempts, more pauses, a partitioned look). It cannot grant, cannot load a key, cannot lift
  a pause. The suspension trigger that would make peer rows load-bearing in the other direction is
  a later increment and the spec accepts it explicitly (§2).
- `poolAdmission`'s suspension and lease-holder rows are evaluated against `none`/`self` on this
  build — stated in the route's `inputs` — so nothing is suspended yet by construction; the health
  increment publishes the real record.
- The 5 s overall budget is enforced with a race, so a peer's late answer is dropped for THIS tick
  (its last-known rows serve) — never a hang, never a stale memo pretending to be fresh (`ageMs`).

## 3. Level-of-abstraction fit

A pure module (ledger, classification, checks, reader) with an injected fetch; routes compose it;
the server owns one instance. The same shape as the outbox (increment 6). Nothing about passkeys
leaks into the pool registry or rope health — they are read through their existing surfaces.

## 4. Signal vs authority compliance

The pool read path is a SIGNAL source with restrictive-only authority: its verdicts refuse
enrollment and proofs (safe direction) and never authorize anything. Peer classification is
deterministic over structural inputs; there is no heuristic gate. `GET /passkeys/admission` is
read-only observability.

## 4b. Judgment-point check (Judgment Within Floors standard)

None. Every decision here is arithmetic over rows or a table lookup; no LLM, no heuristic.

## 5. Interactions

- Reuses the existing pool-fan-out vocabulary (`no-known-url` / `url-rejected` / `route-missing` /
  `unauthorized` / `timeout` / `unreachable`) and the peer-URL allowlist guard, so a peer failure
  never leaks a URL.
- The reader's tick is a READ (no retry, no notify, no restart) — not a self-action controller; its
  outbound traffic is bounded to one GET per peer per 5 minutes.
- The nonce ledger makes `exclude-peer` / `include-peer` mandates idempotent like every other op.
- `GET /passkeys?scope=pool` and the checks share ONE memo — one fan-out per tick however many
  readers (the §5.1 "shared by every check" rule; the same lesson as the WS4.4(f) pool cache).

## 6. External surfaces

- Six new routes under `/passkeys` (write-domain classified; docs rows). Outbound: one GET per peer
  per tick to `/passkeys/pool-state`. No notices, no config keys required (`passkeys.enrollment` and
  `passkeys.healthWatcher.sameAccountGapHours` are read when present, spec defaults otherwise).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

`GET /passkeys/admission` names the exact refusing rule and its retry time in plain fields; the pool
view names each peer's condition and why (`degradedReasons`). No dashboard control yet (§5 increment).
<!-- tracked: CMT-544 -->

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read BY DESIGN: each machine owns its ledger, exclusions and last-known cache
(machine-local files; per-machine authority per §12), and the pool view is the merged read through
the tick memo. The replicated store kinds (§3.2) are the later unification; this path is their
fallback and stays as the dark-store fallback afterwards. Rows carry canonical emails so each machine
derives its own keys (§5.1).

## 8. Rollback cost

Pure code + three machine-local JSON files. Reverting leaves the files inert; nothing durable changes
shape elsewhere.

---

## Conclusion

Every pool-wide passkey bound now has one honest read path: peers publish non-secret state, each
machine reads it once per tick under fixed budgets, classifies silence as offline-but-counting or
partitioned-and-blocking, keeps last-known rows across restarts, and evaluates the spec's table plus
the rate limit, the gap and the pauses — restrictive only, with the unpublished inputs named rather
than assumed. Clear to ship after the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent subagent (Claude), 2026-09-23 — **Concern raised (2) + should-fix / minor
notes**; every concern and should-fix actioned and re-verified before commit. The reviewer confirmed:
peer rows are additive-only through every check (restrictive-only holds), the machine-id re-stamp is
load-bearing and correct (a peer cannot forge own-machine rows to lift the same-account gap), the
budgets and single-flight are correct per instance, classification defaults to `partitioned` on every
uncertainty, and every table row matches the spec in isolation.

1. **`poolAdmission` was not most-restrictive-first for combined rows** — the suspended-canary
   carve-out ran before the partitioned / stale-lease-holder refusals, so a canary under suspension
   was admitted past a partitioned peer. FIXED: every refusing row is evaluated before any admitting
   carve-out; repair is handled on its own branch with the most severe reason named; combination
   cases tested (suspended∧partitioned, suspended∧stale lease, stopped∧partitioned, repair under
   several, revoke under all).
2. **An unreadable last-known cache was the PERMISSIVE case** — an offline peer's lost pause/attempt
   rows relaxed the pool and the corrupt file was overwritten from the empty read. FIXED: silent peers
   read `partitioned` while the cache is unreadable or wrong-version, the file is never overwritten,
   `degradedReasons` names it; tested (rope-offline and excluded peers both partitioned, file bytes
   unchanged, wrong-version case, self-heal when peers answer).
3. **Recovery-quarantined callers were served** — the spec names three refused classes; only two were
   implemented. FIXED: the pool-state route consults the identity-recovery quarantine (pending claims
   naming the caller ⇒ 403 `recovery-quarantined`; an unreadable ledger refuses); tested.
4. **`?scope=pool` re-fanned every 60 s** under a polling dashboard, contradicting "always served from
   the tick memo". FIXED: the server instance's memo TTL equals the tick interval.
5. **Per-request fallback readers multiplied fan-outs and last-known writes.** FIXED: one router-owned
   fallback reader shared across requests (single-flight + memo).
6. **Daily-cap retry time** was the oldest row's expiry, too early when rows exceed the cap. FIXED:
   the (n − cap + 1)-th oldest row's expiry; tested with 5 rows / cap 3.
7. (minor) "never throws" — the tick rejects fail-closed on a corrupt local ledger/exclusion file;
   comment and artifact now say so.
8. (minor) No response-size bound before `r.json()` — FIXED: 1 MB cap before parsing on both fetch
   paths (`malformed`), parse errors classified `malformed`. (Post-CI amend: the two classified
   peer-fetch catch blocks carry the no-silent-fallbacks annotation — they classify into the peer row,
   never swallow — so the ratchet baseline holds at 495.)
9. (note) Mixed pool (a dark fleet peer ⇒ partitioned ⇒ enrollment freeze until excluded) and the
   `schemaVersion` hard-reject hazard for later increments — both added to §1.

---

## Evidence pointers

- `tests/unit/passkey-pool-state.test.ts` — 21: ledger prune/stamp/corrupt-throws; pause extend /
  prune / scope resolution; exclusions idempotency; local state assembly (no secret in the body);
  clamp (forged machine id re-stamped, malformed rows dropped, wrong machine/schema rejected);
  classification incl. rope-absent; rate limit (cell interval, pool-wide daily cap counting
  proofs/repairs, retry times incl. more rows than the cap, config); same-account gap; the full
  admission table (observed, offline/excluded, partitioned, suspended, stopped, kill switch, lease
  holder ≤24h / stale / never) PLUS the combined-row cases (most restrictive wins); reader
  (observed/offline/partitioned merge, malformed keeps last-known, durable last-known across a
  restart, never-seen peer not offered, UNREADABLE cache ⇒ partitioned + file preserved + reason
  named, exclusion auto-clear, overall-budget timeout + single-flight, memo TTL, single-machine
  never degraded).
- `tests/integration/passkeys-pool-read-path-routes.test.ts` — 6: dark 503s; single-machine local +
  pool views; a peer's rows bounding this machine's admission (daily cap, same-account gap, repair
  unaffected); silent peer partitioned vs offline vs rope-absent with last-known rows; caller refusal
  (revoked / pending / unknown) and the reader's `unauthorized` view; exclude/include via PIN and as
  a signed mandate on a third machine, auto-clear on answer.
- `tests/e2e/passkeys-pool-read-path-lifecycle.test.ts` — feature alive over HTTP on a dev agent
  (every route 200, lone machine admits enrollment, PIN exclude lands, no-PIN 403); dark on the fleet.
- Docs coverage check passes with the six routes documented.

---

## Class-Closure Declaration (display-only mirror)

- No agent-authored-artifact defect — not applicable.
- `unbounded-self-action` — not applicable (the reader is a bounded read poll — one GET per peer per
  5-minute tick, no retry, no notify, no restart; no self-triggered corrective action is added).
