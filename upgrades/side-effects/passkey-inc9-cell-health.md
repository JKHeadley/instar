# Side-Effects Review — Per-cell health state machine and the one digest (Increment 9)

**Version / slug:** `passkey-inc9-cell-health`
**Date:** `2026-09-23`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (a state machine whose verdicts stop automatic sign-ins and drive the only user-facing notice)`

## Summary of the change

Increment 9 of the approved spec `docs/specs/agent-held-google-passkey.md` (§4 state table + "Pool
read degraded" + flapping, §13 self-heal brakes, §5.2 the one digest item, §3.2 (b) operator
attestation of Google-side removal). Nothing here drives a browser or contacts Google: it is the
deterministic bookkeeping over PROOF OUTCOMES that the cold-proof / canary / repair workers (later
increments) will feed, plus the single notice that reports what needs a human.

- **`PasskeyCellHealth.ts`** (new):
  - `applyPasskeyProofOutcome` — the §4 table, pure. `security` wins from every state and only a
    re-enrollment leaves it (an operator `ready` is NOT enough); `credential-rejected` ⇒ `rejected`
    (no immediate retry; weekly retry on the unverified backoff); `removed-on-google` is recorded and
    never counts; `failed` arms ONE confirming proof 1h later (§13: max-attempts 2, 90m wall clock) and
    only a confirmed failure degrades; three confirmed failures ⇒ `breaker-open`; three consecutive
    `unknown` ⇒ `unverified` with 7 → 14 → 28-day backoff, three more at the cap ⇒
    `unverified-stopped`; `ready` heals `degraded` / `unverified` / `rejected`, and the terminal
    `breaker-open` / `unverified-stopped` only via an operator-triggered proof or re-enrollment
    (an automatic `ready` is recorded but does not reopen them). Terminal states take precedence.
  - `advancePasskeyHealthClocks` — no `ready` for 21 days ⇒ `unverified`; the clock PAUSES while the
    pool read path is degraded for the account (`clocksPausedSince` / `pausedMs`) so a dark peer
    never drifts a cell toward unverified. Flapping: 3 healthy↔degraded flips in 30 days set a FLAG
    (never a state).
  - `PasskeyHealthStore` (`state/passkey-health.json`, 0600, atomic; corrupt ⇒ THROWS, fail closed —
    a cell that silently read `healthy` would re-admit a repair) with a states-only audit log
    (`logs/passkey-health.jsonl`: machine id, a 16-hex cell hash, from/to/cause — never the email).
  - `buildPasskeyHealthDigest` (pure) + `PasskeyDigestLedger` — ONE item under the fixed key
    `passkey-health:digest`: cells needing a human (degraded / breaker-open / unverified / stopped /
    rejected / security / quarantined / legacy-overdue / orphan, plus any cell with a pending or
    attested Google-side removal), pending outbox revokes, Chrome-gate failures, suspension,
    unobserved peers. Buzz rules per §5.2: content changed since the LAST BUZZ and (24h passed OR
    the SECURITY/suspension section itself CHANGED — a standing security line never turns unrelated
    deltas into per-tick buzzes) ⇒ buzz; otherwise a silent upsert; peer-list changes alone are
    silent (excluded from the buzz hash); an empty digest resolves the episode once; a pass that
    changes nothing does nothing (the "As of" stamp is outside every hash). An UNREADABLE ledger
    denies buzzing (the last buzz time is unknown) until a successful record rewrites it. The
    `flapping` flag follows the 30-day window (clears by itself). The table has no rows for `failed`
    in `unverified`/`rejected` or `unknown` in `rejected`, so those are recorded without moving the
    cell (an unknown keeps `rejected`'s name; a failure never shortens the ladder).
- **Routes** (same dev gate): `GET /passkeys/health` (records + ledger state), `POST
  /passkeys/health/outcome` (Bearer; a LOCAL cell with an ACTIVE grant only — 404 otherwise; the proof
  workers' funnel. The two PERMISSIVE provenances — `origin: 'operator'`, the only automatic exit
  from breaker-open / unverified-stopped, and `reenrolled: true`, the only exit from `security` —
  require the dashboard PIN over HTTP: a Bearer body cannot assert an operator fact), `POST
  /passkeys/health/digest/refresh` (one pass, `force` re-upserts unchanged content silently), PIN
  `POST /passkeys/attest-google-removed` (+ the `attest-google-removed` passkey-cell op in
  `PasskeyCellActions`, applied only to a cell that HAS a health record here — an attestation never
  mints one; a `removed-verified` cell is never downgraded). A revoke removes the cell's health
  record with the grant (`onRevoked`), and the digest pass drops any record whose cell this machine
  no longer holds — a revoked cell can neither age toward `unverified` nor nag. The pool state and
  `GET /passkeys` publish each cell's real health + Google-side state (clamped to the closed set on
  receive; free text ⇒ `unknown`).
- **The digest pass** (`runPasskeyHealthDigestTick`): pauses the 21-day clock PER ACCOUNT — only for
  accounts a partitioned peer is KNOWN to hold (a partitioned peer with no last-known rows pauses
  nothing: pausing is the permissive direction); lists quarantined custody unconditionally (self and
  peers, record or not); merges peers' PUBLISHED health when this machine holds the serving lease (a
  non-holder narrates only itself — its cells, its outbox); upserts via the existing
  `telegram.upsertAttentionItem` with the ledger's verdict CARRIED TO THE SINK (`silent: true` on a
  silent update — the hub post is sent without notification), HIGH when urgent; records the ledger
  only after a successful upsert; a resolve closes the item on the sink (`updateAttentionStatus`
  DONE, silent) and the episode in the ledger. Late-bound onto the route context
  (`ctx.passkeyHealthDigestTick`) so the server's 5-minute timer calls
  `AgentServer.runPasskeyHealthDigestTick()` without a self-HTTP call; gated (a dark agent's tick
  returns `skipped`).
- Docs: API rows + a features-page section; write-domain entries; capability reason.

**Not in this increment:** the workers that PRODUCE outcomes (cold proof §3.8, canary, repair
recording) and the watcher CADENCE (which cell is due when, seat lease, jitter — §4 first bullets:
`proofDue` and `nextProofDueAt` are computed here for it); the suspension record / canaries /
kill switch (§2 — the digest carries a `suspension` slot fed `null`); Chrome-gate failures (§2);
the Google-side list CHECK that yields `removed-verified` (§3.2 (a)) and the digest's direct Google
removal link; the producer that moves a cell to `google-side: pending-operator` (the revoke path
per §3.2 — this increment ships the attested/verified states, not the pending transition);
`legacy-overdue` / `orphan-on-google` producers (§6 / §3.7); the 72h exclude-offer buzz; the
lease-holder TAKEOVER step of §5.2 (a new holder resolving the previous holder's copy — today both
copies coalesce by key in the pool attention view and the operator acknowledges the old one).
<!-- tracked: CMT-544 -->

## Decision-point inventory

- `applyPasskeyProofOutcome` / `advancePasskeyHealthClocks` — add — deterministic table; restriction-first.
- `PasskeyDigestLedger.decide` — add — buzz / silent / resolve / none from hashes + the 24h floor.
- `runPasskeyHealthDigestTick` lease check — add — holder narrates the pool; others narrate themselves.

---

## 1. Over-block

- A confirmed failure needs the second `failed` in the 1h–90m window; a confirm that lands late is
  a NEW first failure (the cell stays healthy longer, never degrades on stale evidence).
- `security` is left only by re-enrollment: a false `security` (a mis-read identity) costs a
  re-enrollment. Accepted by the spec (custody may be corrupt; the outcome mapping keeps `security`
  strictly to an observed different identity).
- A non-holder's digest omits peers and peer outbox rows; if no machine holds the lease (a
  split-brain moment), no machine narrates the pool until the lease settles — the per-machine copies
  still exist, and the pool attention view coalesces by key.
- The 24h buzz floor also holds across a resolve: content that comes back within 24h of the last
  buzz is a silent update until the floor passes (tested) — one quiet day rather than a nag.
- An attestation needs an existing health record on the target machine (`no-cell-record` otherwise):
  the operator attests on the machine that actually held the cell, never on a bystander.
- Without a coordinator (`coordinator.enabled === false`) every machine reads itself as the lease
  holder and narrates the pool: N full copies under one key, coalesced by the pool attention view.
  Tolerable; named here because "a lone machine raises it for itself" is the only case the spec
  describes.
- The server timer's callback references `server` before its declaration textually; it is a closure
  whose first fire is five minutes out, so the only failure mode is a thrown constructor — at which
  point the process is already dying.

## 2. Under-block

- `POST /passkeys/health/outcome` is Bearer for ORDINARY provenances (watcher / canary / repair /
  enrollment): anything holding the token can move a LOCAL, currently-granted cell toward the
  restrictive states freely and toward `healthy` only with a `ready` that the table admits. The two
  permissive provenances are PIN-gated over HTTP (second-pass finding): `origin: 'operator'` (the
  only automatic exit from breaker-open / unverified-stopped) and `reenrolled: true` (the only exit
  from `security`) refuse 403 without the dashboard PIN — the in-process workers call the store
  directly and carry their own provenance. What remains true: a Bearer can still record a `ready`
  for a granted cell (the Google sign-in it claims is not verified here; that corroboration is the
  cold-proof increment's job, §11).
- The digest upsert does not verify the attention item's delivery beyond the sink's promise; a sink
  failure leaves the ledger unrecorded, so the next pass retries (never records "buzzed" falsely).
- Peers' published health is mesh-peer data: a lying peer can make the digest list a cell it need not
  (louder, never quieter — a peer cannot remove another machine's line).

## 3. Level-of-abstraction fit

Pure table + store + digest builder; the routes compose; the server owns the timer and delegates the
pass to the late-bound route closure (one implementation, no second copy in server.ts). Same shape as
increments 6 and 8.

## 4. Signal vs authority compliance

Health is a SIGNAL that the admission policy (increment 4) consumes restrictively — a cell that is
not `healthy` is refused by name; nothing here admits a repair. The digest is a notification, not an
action (§13 "self-heal before notify"). No heuristic; no LLM.

## 4b. Judgment-point check (Judgment Within Floors standard)

None added.

## 5. Interactions

- Increment 4's `PasskeyCellAdmissionState` refusals are what a non-`healthy` state feeds; the
  cold-proof increment wires `PasskeyHealthStore.get(email).state` into that seam.
- The pool memo's `degraded` flag pauses the 21-day clock; the pool-state clamp forces peers' health
  into the closed set (a peer cannot pre-publish `healthy` as free text, and `unknown` stays a valid
  publication for a machine with no record).
- The nonce ledger makes `attest-google-removed` idempotent like every op; a `removed-verified`
  Google-side state is never downgraded by an attestation.
- `upsertAttentionItem` (increment 6) is reused; the item is hub-only and keyed, so the pool view
  coalesces machines' copies by key (§5.2).

## 6. External surfaces

- Four new routes under `/passkeys` (write-domain classified; docs rows); one attention item key;
  one audit log; two state files. No config keys required.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The digest names each cell, its state, its last proof, and the flags in plain lines; `GET
/passkeys/health` exposes the next due time and the ledger state. The Google removal LINK and the
dashboard controls are later increments. <!-- tracked: CMT-544 -->

## 7. Multi-machine posture (Cross-Machine Coherence)

Health is machine-local BY DESIGN (each machine proves its own credential) and proxied-on-read through
the pool state; the digest is coalesced by key with the lease holder holding the complete list and a
new holder taking the key over on its next pass (§5.2). Later unified through `passkeyHealth` (§3.2).

## 8. Rollback cost

Pure code + two machine-local JSON files + one log. Reverting leaves the records inert; the attention
item (if any) is acknowledged by the operator like any other.

---

## Conclusion

Every proof outcome now has one honest consequence, every cell a state the admission policy can
refuse on, and every condition that needs a human one calm, keyed, rate-limited notice — with the
restrictive direction on every uncertainty (security terminal, corrupt store throws, paused clocks
under a degraded pool, silent peer-list changes). Clear to ship after the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent subagent (Claude), 2026-09-23 — **Concern raised (1 blocking + 7 should-fix +
notes)**; every blocking and should-fix item actioned and re-verified before commit. The reviewer
confirmed every row of the §4 table incl. the exits and terminal precedence, the §13 brakes (single
confirm, ≥1h, ≤90m, counted once), the 7 → 14 → 28 ladder and its stop arithmetic, no time credit on
the paused clock, a states-only audit line, and fail-closed store reads (500s, never a silent unknown).

1. **blocking — "silent" never reached the sink.** The upsert carried no `silent` flag, so every
   silent update still posted a notifying hub message; the 24h floor was ledger-only. FIXED:
   `silent: action === 'silent'` on the upsert; the integration test asserts the sink's flag on the
   buzz (false) and the peer-only change (true).
2. **should-fix (authority) — permissive exits forgeable from a Bearer body.** FIXED: `origin:
   'operator'` and `reenrolled: true` require the dashboard PIN over HTTP (403 without); tested.
3. **should-fix — health records outlived the grant** (a revoked cell aged to `unverified` and nagged
   forever). FIXED: `onRevoked` removes the record; the digest pass drops records for cells no longer
   held; the outcome route requires an ACTIVE grant; tested (revoke ⇒ no record, later outcome 404).
4. **should-fix — repeated fast failures never degraded** (an early second failure re-anchored the
   window). FIXED: an early failure keeps the original anchor; a 30/60-minute failure loop now
   confirms at the hour; tested.
5. **should-fix — a standing security line let every unrelated delta buzz per tick.** FIXED: the
   per-tick buzz is gated on the security/suspension SECTION hash changing; tested both ways.
6. **should-fix — a quarantined cell with an existing record vanished from the digest.** FIXED:
   quarantined custody is listed unconditionally (self and peers).
7. **should-fix — the pool-degraded pause was pool-wide** (permissive). FIXED: per account, only for
   accounts a partitioned peer is known to hold; unknown ⇒ no pause.
8. **should-fix — resolve was ledger-only.** FIXED: the item is closed on the sink (DONE, silent);
   the lease-holder takeover half is named in "Not in this increment".
9. (minor) Table deviations — FIXED: `failed` in `unverified`/`rejected` and `unknown` in `rejected`
   no longer move the cell; the flapping flag follows the window (not sticky); records with a state
   outside the closed set are corrupt (throw); an unreadable digest ledger DENIES buzzing.
10. (note) `attest-google-removed` no longer mints a record (refused `no-cell-record`); the
    `pending-operator` producer, the `passkeyHoldsLease` default without a coordinator, and the
    timer's forward reference to `server` are recorded above.

---

## Evidence pointers

- `tests/unit/passkey-cell-health.test.ts` — 10: the confirm dance (early / in-window / late),
  breaker after three confirmed failures + its two exits, the unknown ladder (7 → 14 → 28 → stopped)
  and heals, rejected / removed-on-google / heal, security from every state + the re-enrollment-only
  exit, flapping (flag + ageing), the 21-day clock with the pool-degraded pause, the store
  (healthy-and-due on first sight, states-only audit, corrupt throws), the digest (only what needs a
  human, urgent title, peers section) and the ledger (buzz → none → silent → 24h buzz → security buzz
  → resolve → floor-bounded re-episode).
- `tests/integration/passkeys-cell-health-routes.test.ts` — 5: dark 503s + validation + 404;
  outcomes through the table with audit, pool state and `GET /passkeys` reflecting health, a security
  digest buzzing once then `none`, the re-enrollment exit and the resolve; attestation as PIN and as
  a signed mandate on a peer; lease holder vs non-holder digests with a dark peer named silently; a
  missing sink reported as `no-sink` and never recorded.
- `tests/e2e/passkeys-cell-health-lifecycle.test.ts` — feature alive over HTTP incl. the production
  timer seam (`ctx.passkeyHealthDigestTick`); dark on the fleet (503s, tick `skipped`).
- Existing pool-read-path suites re-run green with the widened health clamp (free text ⇒ `unknown`).

---

## Class-Closure Declaration (display-only mirror)

- No agent-authored-artifact defect — not applicable.
- `unbounded-self-action` — not applicable (the digest pass emits at most one keyed upsert per tick
  under a 24h buzz floor and never restarts, retries or kills; the proof-scheduling loop is a later
  increment and will register there).
