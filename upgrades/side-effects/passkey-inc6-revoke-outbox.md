# Side-Effects Review — Durable passkey revoke outbox (Increment 6)

**Version / slug:** `passkey-inc6-revoke-outbox`
**Date:** `2026-09-23`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (a self-triggered re-delivery loop that carries revocation authority to peers)`

## Summary of the change

Increment 6 of the approved spec `docs/specs/agent-held-google-passkey.md` (§3.2 "Revoke is carried by
the mandate outbox", FD15 "Revokes never silently expire"). Increment 5 delivered a peer revoke
synchronously and answered 502 on failure; this increment makes a peer revoke DURABLE.

- **`PasskeyRevokeOutbox`** (`state/passkey-revoke-outbox.json`, 0600, atomic) — entries keyed per
  cell `(email@targetMachine)`, latest-wins; each holds the exact SIGNED bundle (same principal,
  `issuedAt`, nonce) which is re-delivered UNCHANGED. `attemptNow` (the route's first try), `tick`
  (the loop): due entries re-sent on 1h → 6h → daily backoff clocked from the durable `nextAttemptAt`;
  the peer-online forward pull is EDGE-triggered — one pull per observed offline→online transition
  (`peerSeenOfflineSinceAttempt`), never below a 15-minute floor after the last attempt — so a peer
  that stays online-but-refusing gets the plain backoff, never a 15-minute hammer; 30 days after `issuedAt` an entry ESCALATES (state `escalated`, one aggregated HIGH attention
  item per machine `passkey-incomplete-revoke:<machineId>` listing every escalated cell) and automatic
  re-delivery stops apart from ONE post-breaker attempt when the peer is next observed online (recorded
  as `postBreakerAttemptAt`; a flapping peer cannot re-trigger it). Outcomes: `applied` (→ the issued
  peer-grant copy is forgotten), `dismissed` at the peer (→ closed), a PERMANENT refusal (bad signature,
  wrong target, malformed, ttl-too-long → closed, re-issue), anything else (→ keeps backing off).
  `tick` and `attemptNow` share ONE in-flight lane (a route try during a tick can never double-send),
  ≤10 attempts per tick, corrupt file fails CLOSED (throws). A failed escalation raise leaves
  `escalationNotified:false` and is retried every tick until the sink accepts it.
- **Routes** (same dev gate): `POST /passkeys/revoke` with `targetMachineId` now signs once, enqueues,
  tries now and answers `200` (applied) or `202` (queued, with the outbox entry's state/attempts/next
  time) instead of 502; `GET /passkeys/outbox` (entries without bundle bodies); `POST
  /passkeys/outbox/tick` (one pass on demand, Bearer, idempotent).
- **Server wiring**: when `passkeys.enabled` resolves on, the server owns one outbox instance and a
  10-minute `setInterval` (unref'd, cleared at shutdown); delivery posts to the peer's
  `/passkeys/cell-action`; peer-online reads the pool registry's live `online` flag; the attention item
  goes through a NEW `telegram.upsertAttentionItem` — create on first raise, otherwise REFRESH the
  body/title, set the row back to OPEN and re-post it to the Attention hub — so a second cell escalating
  on the same machine appears in the same item, and a later episode after the operator resolved the
  first re-opens it (never a silent expiry). Routes use the server instance when
  present, else a per-request file-backed one (tests; no timer).
- **Self-action registration**: `passkey-revoke-outbox` is registered in
  `src/testing/selfActionRegistry.ts` with a faithful convergence model (1h/6h/daily backoff, 30-day
  breaker, one post-breaker attempt; durable attempts/next-attempt survive restart; the peer is online on
  every tick and never transitions, so — like the real edge-triggered pull — no pull fires) — the
  ratchet proves a bounded, horizon-independent emit count (≤33 per entry) under a peer that always
  rejects, online or offline.
- Docs: outbox rows in the API reference + a section on the features page.

**Not in this increment:** lease-holder takeover of a lost issuer's outbox and the replicated
`passkeyTombstones` accelerator (the outbox lives on the issuing machine — the accepted Rung-1 residual
in §3.2); re-signing a revoke whose issuer was removed; the escalated cell's `google-side-pending-
operator` state and the Google-side removal link (they belong to the health/cell-state increment, which
also closes the escalation once removal is verified or attested); an operator route to close/dismiss an
entry from this side (the `close()` method exists; its PIN route lands with the dashboard increment).
<!-- tracked: CMT-544 -->

## Decision-point inventory

- `tick` due/forward-pull/breaker logic — add — deterministic schedule over durable timestamps; bounded.
- permanent-vs-transient refusal classification — add — a closed allowlist of permanent reasons; everything else retries.
- escalation at 30 days — add — invariant on `issuedAt`; one item per machine.

---

## 1. Over-block

- A permanent refusal closes the entry rather than retrying it for 30 days: the operator must re-issue.
  The set is a closed allowlist (`bad-signature`, `target-not-this-machine`, `not-a-passkey-cell-mandate`,
  `unknown-op`, `malformed`, `ttl-too-long`) — every other refusal (incl. `issuer-not-trusted`, the
  bootstrap case) keeps backing off, because it can be cured on the peer without a new bundle.
- The 15-minute floor means a peer that comes online right after a failed attempt waits up to 15 min;
  and the pull needs an OBSERVED offline tick first — a peer that was never seen offline by this machine
  is simply retried on the schedule.
- ≤10 attempts per tick: a large backlog drains over several ticks (10 minutes apart).

## 2. Under-block

- Peer-online is an OBSERVATION (registry `online` flag); a stale flag delays the forward pull until
  the normal backoff — never skips it.
- The single post-breaker attempt is per entry, not per machine: N escalated cells on one machine spend
  N attempts when it returns (each bounded to one).
- Nothing yet moves the escalated cell into `google-side-pending-operator` or shows the Google removal
  link — the attention body says the key may still be usable and that the digest will carry the link
  (the health increment owns the cell state). <!-- tracked: CMT-544 -->
- The outbox lives on the issuing machine only; losing that machine loses outstanding re-delivery until
  the tombstone store replicates it (Rung 2 precondition per §3.2). <!-- tracked: CMT-544 -->

## 3. Level-of-abstraction fit

The outbox is a pure store+loop over an injected `deliver`; it knows nothing about signatures (the
bundle is opaque) or about grants beyond the applied hook. The route composes: sign → enqueue → try now.

## 4. Signal vs authority compliance

Re-delivering an already-signed revoke carries no new authority: the peer re-verifies signature, issuer
set and nonce on every delivery, and a revoke can only remove. The escalation is a notification, not an
action. No heuristic gates anything.

## 4b. Judgment-point check (Judgment Within Floors standard)

None.

## 5. Interactions

- The peer's nonce ledger makes every redelivery idempotent: a `received`-but-unapplied revoke re-applies
  its STORED cutoff (increment 5), an `applied` one answers duplicate — so the outbox can never over-revoke.
- `onApplied` forgets the issued peer-grant copy (the same bookkeeping the synchronous path did).
- Self-action governance: registered controller + convergence model; `lint-no-unregistered-self-action`
  and `lint-emit-without-admit` clean.
- The rope-health monitor's attention pattern is reused verbatim (same sink, HIGH, deduped by id).

## 6. External surfaces

- New routes `GET /passkeys/outbox`, `POST /passkeys/outbox/tick` (write-domain classified; docs rows).
- A HIGH attention item per machine after 30 unacknowledged days.
- Outbound POSTs to peers every backoff step (bounded).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The 202 names what happened (`queued`, attempts, next attempt, last result) in plain words; the outbox
read hides bundle bodies. No dashboard control yet (§5 increment). <!-- tracked: CMT-544 -->

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: each issuing machine owns its outbox; the peer applies through its own verified
receiver. Cross-machine takeover is the tombstone increment (above).

## 8. Rollback cost

Pure code + one machine-local JSON file. Reverting leaves queued entries inert; a pending revoke can be
re-issued synchronously by the operator.

---

## Conclusion

A peer revoke can no longer be lost to a bad moment: it is signed once, kept durably, re-delivered
unchanged on a bounded schedule, escalated loudly at 30 days, and given one last chance when the peer
returns — with the emit count proven bounded by the convergence ratchet. Clear to ship after the
second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent subagent (Claude), 2026-09-23 — **Concern raised (2) + minor notes**; both
concerns and the actionable notes fixed and re-verified. The reviewer confirmed: 404 from a pre-increment
peer retries to the breaker (correct), the permanent allowlist cannot match a transient receiver reason,
both delivery classifiers agree, production has one outbox instance, the peer-grant copy is retained until
`applied`, and `cutoffSeq` is the known peer sequence.

1. **Level-triggered forward pull** — with `peerOnline` a STATE read, an online-but-refusing peer was
   re-sent every ~20 minutes for 30 days (reviewer's simulation: 2,161 deliveries), and the convergence
   model hid it (its pre-breaker branch never consulted online). FIXED: the pull is edge-triggered on an
   observed offline→online transition (`peerSeenOfflineSinceAttempt`, cleared on every attempt), never
   below the floor; unit test drives 3h of 10-minute ticks against an online, refusing peer and sees
   exactly the scheduled retries; the model's comment states the fixture explicitly and the bound is
   re-derived (≤33).
2. **`createAttentionItem` is create-once** — a second escalated cell never reached the item, and a
   resolved item could not re-open for a later episode (a silent expiry, forbidden by FD15). FIXED: new
   `TelegramAdapter.upsertAttentionItem` (refresh + reopen + hub re-post, hub-only), used by both wirings;
   `escalationNotified` makes a failed raise retryable; unit test covers a rejected raise retried on the
   next tick and a later cell refreshing the same id with both cells.
3. (minor) `attemptNow` bypassed single-flight — FIXED: one in-flight lane shared with `tick` (tested).
4. (minor) bound comment 33 vs `boundK` 34 — reconciled to 33.

---

## Evidence pointers

- `tests/unit/passkey-revoke-outbox.test.ts` — 7: latest-wins + immediate try + 1h/6h/daily with the
  SAME bundle across a restart; EDGE-triggered forward pull (one pull per offline→online transition,
  floor from the last attempt, no hammering of an online-refusing peer); retried escalation raise +
  aggregated refresh with a second cell; attemptNow/tick single lane; applied/dismissed/permanent vs
  transient refusal; 30-day breaker (aggregated item, no attempts while offline, exactly one
  post-breaker attempt under a flapping peer, a post-breaker success, operator close); single-flight +
  per-tick bound + corrupt file fails closed.
- `tests/integration/passkeys-grants-routes.test.ts` — extended: a peer revoke applied via the outbox
  (200, `GET /passkeys/outbox` without bundles); a peer revoke the peer cannot yet accept is queued (202),
  a tick attempts nothing before due, an offline→online observation arms the pull, the floor holds, and
  once the peer trusts the issuer the SAME bundle applies on a later tick (attempts: 2).
- `tests/unit/self-action-convergence.test.ts` — the `passkey-revoke-outbox` model settles ≤34 and does
  not scale with the horizon; restart-under-pressure keeps the bound.
- Docs coverage check passes locally with the two new routes documented.

---

## Class-Closure Declaration (display-only mirror)

- `unbounded-self-action` — closure: **guard** — citation `tests/unit/self-action-convergence.test.ts`
  (ratchet) via the registered controller `passkey-revoke-outbox` in `src/testing/selfActionRegistry.ts`:
  a fixed backoff schedule over DURABLE timestamps, a 30-day breaker that stops automatic re-delivery,
  an edge-triggered (not level) forward pull, and a single durably-recorded post-breaker attempt bound
  the emit count (≤33 per entry) independent of the horizon and of restarts.
- No agent-authored-artifact defect — not applicable.
