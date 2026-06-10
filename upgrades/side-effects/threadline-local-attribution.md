# Side-Effects Review — Threadline local-delivery fingerprint attribution

**Version / slug:** `threadline-local-attribution`
**Date:** `2026-06-09`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `independent reviewer subagent — CONCUR (Phase 5; high-risk: anti-hijack security surface + A2A routing)`

## Summary of the change

Fixes the anti-hijack guard isolating legitimate same-machine replies (the live Luna incident, thread
`199c20fe`). On local delivery the sender is stamped by NAME (`from.agent`), but the thread owner is a
FINGERPRINT (`publicKey[:32]`), so the guard mismatched and isolated. Driven by the converged spec
`docs/specs/threadline-local-delivery-fingerprint-attribution.md`. Three pieces:
(A) a new shared resolver `src/threadline/peerFingerprint.ts` — `resolvePeerFingerprint(entry) =
fingerprint || publicKey[:32] || null` (lowercased) + `resolvePeerFingerprintByName(stateDir, name)`
(collision/absent/malformed → null); (B) the `/messages/relay-agent` route resolves `from.agent` and
passes the result to `handleInboundMessage` via a NEW narrow optional param `opts.inboundSenderFingerprint`,
consumed ONLY in the anti-hijack `inboundFp` fallback — NOT a full relayContext; (C) the outbound
owner-record sites (`captureOrigin` / `recordSent` peerFp) adopt `resolvePeerFingerprint` so record and
compare derive identically. Tests: 13 resolver unit + 3 anti-hijack unit (incl. incident reproduction:
no-hint isolates, hint resumes) + 2 integration (resolver-from-real-file → guard, the publicKey-only
shape). 1710 existing threadline tests green; typecheck clean.

## Decision-point inventory

- `ThreadlineRouter.handleInboundMessage` anti-hijack `inboundFp` (identity the guard compares) —
  **modify** — add `opts.inboundSenderFingerprint` to the fallback chain; logic unchanged.
- `/messages/relay-agent` ingress — **modify** — resolve `from.agent` → fingerprint, pass the hint.
- Owner-record derivation (`captureOrigin`/`recordSent`) — **modify** — route through the shared helper
  (same chain, now lowercased).

---

## 1. Over-block

No legitimate input is newly rejected — the change is the opposite (legitimate replies that were
false-isolated now resume). The only new *match* is a sender whose NAME resolves to the thread owner's
fingerprint. An unknown / unresolvable name still falls back to the name and isolates a fingerprint-owned
thread (fail-safe), so nothing legitimate-but-unknown is newly *admitted* into a victim thread either.

## 2. Under-block

A process running as the same OS user that holds the receiver's relay-agent token could stamp
`from.agent = <a known peer's name>`, resolve to that peer's fingerprint, and resume that peer's thread.
This is the **committed trust tradeoff** (spec §C): bounded by token custody (the real authorization
boundary, unchanged); pre-fix the guard already operated on the self-asserted name and merely
always-isolated locally (no real protection); the cross-machine attacker path is Ed25519-verified and
untouched. Tightening *who may call* `/messages/relay-agent` is the correct hardening and is tracked
out-of-scope.

## 3. Level-of-abstraction fit

Correct layer. The resolution happens once at the ingress (the route), and the guard consumes a narrow
hint — not a full relayContext (which would change grounding/history/persistence, convergence B2/M1).
The shared resolver is the right primitive: record and compare funnel through ONE derivation so they
cannot drift (the round-1 blocking self-bug was exactly such a drift — a `fingerprint`-only resolver
no-op'd on the live `publicKey`-only sagemind).

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — the hint is a signal to the guard's comparison; it has no block/allow authority of its own.

The guard's block/allow LOGIC is byte-for-byte unchanged; only the identifier handed to it differs. An
unresolved sender still isolates. No brittle blocking authority is added.

## 5. Interactions

- **Shadowing:** the hint is consumed at exactly ONE site — the anti-hijack `inboundFp` (verified:
  `inboundFp`/`inboundName` referenced only at the 3 comparison/log lines). It cannot leak into
  grounding-preamble injection, history depth, affinity (still `verified`-gated, untouched), or the
  persisted `participants.peers` — those are gated on `relayContext` presence, and we pass `undefined`
  for relayContext on the local path.
- **Double-fire / races:** none — pure per-message resolution from the existing `known-agents.json`.
- **Owner-record case:** the refactored recorder now lowercases the fingerprint (the resolver
  lowercases); the inbound hint is also lowercased → consistent. Existing threads recorded before this
  PR keep their stored owner; hex fingerprints are already lowercase, so existing lowercase-hex owners
  still match (the incident owner `1db85f…` is lowercase). An existing owner stored in mixed case would
  not match a lowercased hint — but it would have isolated before this fix too (inbound was a name), so
  no regression.

## 6. External surfaces

- **Other agents / relay:** strictly improves A2A coherence — legitimate co-located replies resume
  instead of being isolated into dead threads. Cross-machine relay path untouched (it already carries
  the fingerprint).
- **No new route / config knob / dashboard / CLAUDE.md template.** Transparent correctness fix.
- **Persisted state:** no migration. The owner record now stores a lowercased fingerprint going forward
  (was the same value, possibly mixed case); resolution is computed per-message from `known-agents.json`.
- **Authenticated cross-machine ingress** (`ThreadlineEndpoints.ts:429`) is deliberately NOT given the
  TOFU name-hint (it's Ed25519-verified; `from.agent` is already a fingerprint) — verified by reading
  the code (convergence round 2).

## 7. Rollback cost

Pure code change across one new file + two existing files. Rollback = revert the PR; the route stops
passing the hint and the owner-record reverts to the un-lowercased chain. No data migration, no agent
state repair, no user-visible regression during rollback.

---

## Conclusion

A focused, fail-safe ingress fix: a shared resolver (closing the publicKey-only no-op the convergence
caught), a narrow hint to the guard (avoiding the relayContext side effects the convergence caught), and
record/compare funneled through one derivation. The committed trust tradeoff is documented and bounded by
the unchanged token boundary. 23 new tests incl. the on-real-guard incident reproduction; 1710 existing
threadline tests unaffected; typecheck clean. High-risk classification (anti-hijack security surface)
triggers the Phase-5 second-pass review below.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur**

Code-grounded audit of all 7 areas. Confirmed: the hint is consumed at exactly ONE site (the
anti-hijack `inboundFp` fallback) and leaks into NOTHING else — grounding/history/affinity/participants
are all gated on `relayContext` presence, and the local path passes `relayContext = undefined`. Fail-safe
verified (`?? undefined` on miss → name fallback → isolate). The resolver's `publicKey[:32]` provably
equals `computeFingerprint` (`publicKey.subarray(0,16).toString('hex')`), so it derives the canonical
fingerprint, not an arbitrary truncation; the collision Set-rule correctly does not false-collide a
fingerprint + its publicKey twin. Lowercasing is value-preserving (known-agents fingerprints come from
`Buffer.toString('hex')` = always lowercase). No caller breaks. The "hint resumes" test genuinely REDs
on main (main ignores the 3rd arg → isolates) and passes on the branch.

Two MINOR non-blocking notes: (1) the implementation funneled the shared helper through the two
owner-record sites (the load-bearing record/compare consistency); the other outbound `[:32]` matching /
self-guard sites (`routes.ts` ~L17404/17418/17450, ThreadlineMCPServer ~L508/853) retain their
byte-identical inline `(… || '').toLowerCase()` chain — verified equivalent (they feed matching/self-guard,
not the owner record), so consistency is intact; a full DRY funnel is a tracked follow-up, not a
correctness gap. (2) `ThreadlineEndpoints.ts:429` (Ed25519-authenticated cross-machine ingress) is
correctly NOT given the TOFU hint. Clear to ship.
