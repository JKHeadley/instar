# Side-Effects Review — Passkey grants, issuer set, nonce ledger, `passkey-cell` mandate (Increment 5)

**Version / slug:** `passkey-inc5-grants-mandate`
**Date:** `2026-09-23`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (authority carrier for credential-bearing cells; cross-machine signed ops)`

## Summary of the change

Increment 5 of the approved spec `docs/specs/agent-held-google-passkey.md` (§3.2 grants and revokes,
§3.3 the `passkey-cell` mandate, FD12 / FD15 / FD21, §5.2 routes). It builds the AUTHORITY layer a
passkey cell needs before anything can be minted or loaded — and nothing on this build mints or loads.

- **`PasskeyGrantStore`** (`state/passkey-grants.json`, 0600, atomic) — one ACTIVE grant per
  (email × THIS machine); monotonic `localSeq` per instance; `revoke` covers instances by sequence
  (`localSeq ≤ cutoff`, or every instance when the cutoff is unknown — restrictive); the revoke
  HIGH-WATER mark is kept under `secrets/passkeys/revoke-hwm.json` (outside the backup manifest) and
  `admitRestoredGrants` drops any restored grant at or below it (§6). Non-secret copies of grants this
  machine issued to peers. A corrupt file FAILS CLOSED (throws; never read as empty, never clobbered).
- **`PasskeyIssuerSet`** (`state/passkey-issuers.json`) — the receiver's EXPECTED-ISSUER set: self on
  the first local PIN, peers only by local operator confirmation or a signed `issuer-add`; no
  trust-on-first-use. Checked at every verification against the machine registry: `revoked` ⇒ refused
  + lazily removed; `pending` / `missing` / `unreadable` / quarantined ⇒ refused, KEPT.
- **`PasskeyNonceLedger`** (`state/passkey-nonces.json`) — `received` (with the revoke cutoff in the
  same write) → `applied` (after read-back) / `dismissed`; re-signed copies dedupe on the nonce they
  replace; ordinary nonces prune after expiry+skew, revoke nonces after 60 days.
- **`PasskeyCellMandate`** — the signed carrier: Ed25519 over a DISTINCT domain tag
  (`instar-passkey-cell-mandate-v1`) bound to the issuer fingerprint; verification order: shape →
  issuer trusted (set + registry status) → signature → target == self → freshness (15 min ± 2 min
  skew; `revoke` exempt) → replay. Isolation from `account-follow-me` is structural (different
  domain tag) and tested in BOTH directions.
- **`PasskeyCellActions`** — ONE apply funnel for the PIN route and the mesh receiver: nonce written
  before acting, read-back before `applied`, duplicates honest (a `received` revoke re-applies the
  STORED cutoff), FD21 bootstrap (a multi-machine agent refuses its first grant until a peer issuer is
  confirmed), unavailable ops named (`op-not-available-on-this-build`).
- **Routes** (dev-gated `passkeys.enabled`; 503 on the fleet): `GET /passkeys/grants`; PIN levers
  `POST /passkeys/{grant,revoke,issuer-add,issuer-remove}` — local target applies here, a
  `targetMachineId` signs a mandate with this machine's identity key and delivers it to the peer's
  `POST /passkeys/cell-action` (Bearer transport; the signature + issuer set + nonce ledger are the
  authority; follow-me bundles refused). The PIN check is the SAME per-IP-limited check the mandate
  routes use (in-memory + durable `PinAttemptStore`; 429 after repeated failures). The recorded
  principal is always the verified fact — `dashboard-pin@<this machine>` — a body-supplied name is
  ignored. A verified local PIN adds this machine to its own issuer set. `issuer-add` requires an
  ACTIVE machine in THIS machine's registry for BOTH origins (PIN and mandate).
  Revoke on this build drops the local grant, the profile's passkey binding (via revert) and — only if
  a credential store already exists on disk — the stored credential; it names what changed and says
  what it does NOT stop.
- **Wiring**: `buildPlaywrightRegistry` now injects `passkeyEntryExists` (the increment-4 seam) when the
  gate is on AND a store exists on disk — closing the "no route can assign the method" gap by design
  rather than by omission; `devGatedFeatures` gains `passkeys`; `WriteDomainRegistry` classifies the
  five mutating routes as machine-local / git-sync-excluded; `CapabilityIndex` reason updated; the
  CLAUDE.md passkey bullet is extended (new agents) and an in-place migration extends it for existing
  agents (marker `/passkeys/grants`).

- **Revoke cutoff is always CONCRETE.** The cutoff written with the `received` nonce is the issuer's
  sequence when it knew one, else the target's CURRENT active instance (0 = nothing) — so a redelivery
  or a crash-finish re-applies exactly that number and can never catch a grant made afterwards. The
  issuer records the peer's returned `localSeq` on a peer grant and sends it in a later peer revoke.
- **Boot sweep**: every authority-touching route first finishes any revoke left `received` (stored
  cutoff), before it acts.

**What this build does NOT do:** mint, load, prove or enroll anything; run a revoke OUTBOX (a peer
revoke is delivered synchronously — a failed delivery answers 502 and the operator re-issues; the
durable outbox with backoff, 30-day breaker and escalation is the next increment); replicate grant rows;
raise the digest. Each is a named later increment of the same run. <!-- tracked: CMT-544 -->

## Decision-point inventory

- `verifyPasskeyCellMandate` — add — deterministic authority check (signature, issuer set, target, freshness, replay); fail closed.
- `PasskeyIssuerSet.verdict` — add — registry-status invariant; removal only on `revoked`.
- FD21 bootstrap check in `apply(grant)` — add — invariant: peers present ⇒ a confirmed peer issuer required.
- `admitRestoredGrants` high-water rule — add — invariant: a restore never lowers revocation.
- `passkeyEntryExists` injection — modify — validation seam now wired (fail closed on unreadable store).

---

## 1. Over-block

- With active peers and no confirmed peer issuer, even a LOCAL PIN grant is refused (409) — by spec
  (FD21). The response names the fix (`issuer-add` on this machine).
- A revoke whose cutoff is unknown removes every instance present, including a re-grant made between
  issue and delivery — restrictive by spec; the operator re-grants.
- An issuer that is `pending`/`missing`/`unreadable` in the registry is refused although it may be
  healthy — fail closed; nothing is forgotten, so recovery is automatic on the next check.
- `issuer-add` refuses a machine that is not `active` in this machine's registry (409) — a machine must
  be paired before it can be trusted.
- A corrupt grants/issuers/nonces file throws — every route answers 500 `authority-unreadable` rather
  than treating the file as empty (which would silently re-open authority or accept replays). The one
  deliberate exception is the tiny revoke HIGH-WATER file: unreadable reads as 0 (it only ever raises a
  bar on RESTORE; a fresh machine has none). A corrupted high-water file plus a restore of an old backup
  could therefore re-admit a revoked grant — accepted posture, named here.
- A trusted issuer cannot stretch a mandate's life: `expiresAt − issuedAt > 15 min + skew` is refused
  (`ttl-too-long`).

## 2. Under-block

- The receiver route is Bearer-authenticated HTTP, not the mesh-envelope verb: transport identity is
  NOT used as a trust input (the spec's "the signature is the authority"); the issuer set + registry
  key resolve trust. A holder of the Bearer token can DELIVER bundles but cannot forge one (no issuer
  key). The PIN levers DO sign with this machine's key, which is why they ride the rate-limited PIN
  check — a Bearer holder cannot enumerate the PIN through them. Refusal reasons still let a Bearer
  holder probe issuer-set membership (low; membership is not secret).
- Identity-recovery QUARANTINE (`pending` reannounce claims) is a seam (`quarantinePending`) not yet
  wired to `IdentityReannounceService` in routes; today only registry `status` feeds the verdict. The
  reannounce feature is itself dark; wiring lands with its graduation. <!-- tracked: CMT-544 -->
- A peer revoke has no durable outbox yet: an offline peer is reported as a 502 and the grant on that
  peer remains until the operator re-issues or the outbox increment lands. The local grant copy on the
  issuer is NOT dropped by a failed peer revoke (so nothing is forgotten). <!-- tracked: CMT-544 -->
- `revertMethod` on revoke reverts every browser-profile account matching the email across services
  (google/anthropic/openai rows for the same identity) — intended: the passkey binding is per identity.

## 3. Level-of-abstraction fit

Authority (grants), trust (issuer set), replay (nonce ledger) and carrier (mandate) are four small pure
modules with one apply funnel; routes only verify the PIN or hand the bundle to the funnel. Signing reuses
Node's Ed25519 exactly as WS5.2 does, with its own domain tag rather than a shared helper — a shared helper
would make the two families interchangeable by construction, which is the opposite of the requirement.

## 4. Signal vs authority compliance

Every blocking decision is a deterministic invariant over declared state (a set membership, a registry
status, a signature, a timestamp window, a nonce). No heuristic holds authority; nothing here reads
message content.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment points.

## 5. Interactions

- Increment 4's `passkeyEntryExists` seam is now wired (gate on + store on disk); the registry still
  fails CLOSED when the store is unreadable. The revert route and the revoke path share
  `revertLoginMethod`.
- The follow-me acceptors (`acceptDeliveredMandate`, `acceptMandateDelivery`) refuse a passkey-cell
  bundle; the passkey receiver refuses a follow-me bundle (400 before any verification) — tested both
  ways, including a follow-me signature transplanted onto a passkey-shaped body (bad-signature).
- A verified local PIN on ANY passkey lever adds self to the issuer set (idempotent). A failed PIN never
  does (tested).
- The backup manifest already excludes `secrets/` (increment 2) — the high-water file rides that
  exclusion; `state/passkey-grants.json` is under `state/` and IS backed up, which is why the high-water
  rule exists.

## 6. External surfaces

- New routes under `/passkeys` (classified in `INTERNAL_PREFIXES` + `WriteDomainRegistry`); audit rows to
  `logs/playwright-profiles.jsonl` (action, target, applied/reason; email presence only, never the
  address; never a nonce or key).
- Peer delivery: an outbound HTTPS/HTTP POST to a registered peer's `/passkeys/cell-action` with the
  agent's Bearer token — the same peer-call pattern the pool reads use.
- CLAUDE.md bullet (new + migrated).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

PIN levers answer with what changed (`localSeq`, `covered`, `changed`, `reverted`) and, on refusal, a
named reason with a hint (`issuer-bootstrap-required`). No dashboard control yet (§5 increment).
<!-- tracked: CMT-544 -->

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN and by spec (§12, FD2): grants, issuers and nonces are per machine; a peer is
acted on ONLY through a signed mandate it verifies itself against ITS OWN issuer set and registry.
Nothing replicates in this increment (the advisory `passkeyGrants` store kind is a later increment); the
issuer keeps a non-secret copy of peer grants so a later revoke can name them.

## 8. Rollback cost

Pure code + three new machine-local JSON files that an older build ignores. Reverting leaves grants inert
(nothing consumes them until enrollment lands). The revoke high-water file is tiny and harmless to keep.

---

## Conclusion

The authority layer is complete for the local case and the two-machine case, fail-closed at every
boundary, isolated from the follow-me mandate by construction, and exercised end-to-end through the real
routes with real Ed25519 keys on two in-process machines. Nothing can mint or load a passkey yet. Clear to
ship after the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent subagent (Claude), 2026-09-23 — **Concern raised (3) + minor notes (7)**;
all addressed and re-verified below. The reviewer confirmed independently: verification order and
fail-closed behaviour, isolation both ways, FD21 derivation (single machine never blocked),
timingSafeEqual + self-issuer only after a good PIN, write-domain / devGatedFeatures / CapabilityIndex /
CLAUDE.md migration, and the 32 named tests green.

1. **Stored revoke cutoff was the REQUESTED cutoff (null when unknown), not the APPLIED one** — a
   redelivery of a crash-interrupted unknown-cutoff revoke would have recomputed "everything present"
   and removed a legitimate later re-grant. FIXED: the cutoff is resolved to a concrete number (issuer's
   seq, else the target's current instance, else 0) BEFORE the `received` write; replay and the boot
   sweep re-apply that number. New unit test drives exactly the scenario (write lands, hook throws,
   re-grant, redelivery ⇒ new grant survives).
2. **Body-supplied `principal` recorded as the verified principal.** FIXED: dropped; the principal is
   always `dashboard-pin@<machine>`; integration test asserts a supplied name is ignored.
3. **No PIN attempt limiting.** FIXED: the levers use the mandate routes' `checkMandatePin` (per-IP
   in-memory + durable `PinAttemptStore`); integration test drives 7 wrong PINs ⇒ 429.
4. (minor) TTL bound at the receiver — ADDED (`ttl-too-long`, tested).
5. (minor) mandate-path `issuer-add` did not check the receiver's registry status — FIXED for both
   origins (`machine-not-active`, tested both ways).
6. (minor) issued peer-grant copies never captured the peer's `localSeq` — FIXED; a peer revoke now
   sends it (integration test asserts `appliedCutoffSeq: 1` on the peer and the copy is forgotten).
7. (minor) no boot sweep existed — ADDED (`sweepReceivedPasskeyRevokes`, run before any authority
   route acts; tested).
8. (minor) high-water unreadable ⇒ 0 — scoped honestly in §1 above.
9. (minor) `meshSelfId` vs identity id divergence would surface as a confusing bootstrap 409 /
   `no-issuer-key` — fail-closed; a boot-time assertion is left for the enrollment increment, which is
   the first consumer of grants. <!-- tracked: CMT-544 -->
10. (minor) refusal reasons reveal issuer-set membership — accepted (low; noted in §2).

---

## Evidence pointers

- `tests/unit/passkey-grant-store.test.ts` — 5: deny-by-default, canonicalisation, sequence, revoke by
  cutoff (a later re-grant survives an older revoke), unknown cutoff covers all, high-water + restore
  guard, peer-grant copies, corrupt file fails closed.
- `tests/unit/passkey-issuer-set.test.ts` — 4: no TOFU, self/peer provenance, revoked removed vs
  pending/missing/unreadable/quarantined kept, corrupt file fails closed.
- `tests/unit/passkey-nonce-ledger.test.ts` — 5: received/applied with stored cutoff, re-signed dedupe,
  dismissal, retention (ordinary vs revoke), corrupt file fails closed.
- `tests/unit/passkey-cell-mandate.test.ts` — 6: every field signed, unlisted/wrong-key/mis-target/no-key,
  revoked-removed vs pending-kept, expiry ±skew with revoke exempt + not-yet-valid + ttl-too-long,
  replay (incl. re-signed), isolation both ways.
- `tests/unit/passkey-cell-actions.test.ts` — 5: local grant + duplicate + mis-target, FD21 bootstrap,
  mandate grant/issuer-add (incl. machine-not-active both origins)/issuer-remove/unavailable op, revoke
  cutoff + hooks + received-replay, UNKNOWN-cutoff crash → re-grant → redelivery keeps the new grant +
  boot sweep.
- `tests/integration/passkeys-grants-routes.test.ts` — 5 (two real in-process machines with real keys):
  401/503; PIN 403/503/429/400 and no self-issuer on a failed PIN; single-machine grant→list→revoke +
  ignored body principal + audit hygiene; multi-machine bootstrap refusal → peer grant refused until
  confirmed → accepted (peer seq recorded) → peer revoke names it; receiver refusals (follow-me bundle,
  duplicate, expired, non-issuer, forged) with no writes.
- `tests/e2e/passkeys-grants-lifecycle.test.ts` — 3: ALIVE (200 + grant + revoke + high-water file),
  PIN 403, fleet 503.
- `tests/unit/PostUpdateMigrator-passkeyLoginMethodBullet.test.ts` — extended: in-place bullet upgrade.
- Regression: capabilities-discoverability, write-domain ratchet, no-silent-fallbacks, devGatedFeatures
  wiring, playwright routes/e2e, revert-method routes/e2e, dev-preflight e2e — green (see the run log).

---

## Class-Closure Declaration (display-only mirror)

- `unbounded-self-action` — closure: **n/a** — reason: one-shot operator-driven actions only (a PIN
  lever or a verified mandate applies once and stops); no timer, retry loop or re-delivery exists on this
  build — the revoke outbox is a later increment and will register its controller then.
- No agent-authored-artifact defect — not applicable. New capability from an approved spec.
