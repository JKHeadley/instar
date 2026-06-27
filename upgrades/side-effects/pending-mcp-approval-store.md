# Side-effects review — PendingMcpApprovalStore (operator-approval tap-surface foundation)

**Change:** New `src/core/PendingMcpApprovalStore.ts` — an in-memory registry that
lets the operator-approval tap surface put an OPAQUE requestId in the link while the
server-minted nonce stays server-side (vs. a nonce-in-URL leak). 6 unit tests.

## 1. Blast radius
Zero at runtime. No importer yet — the approval-page routes (the next increment,
sequenced after the live-test informs the UI) will use it. Inert + dark-feature.

## 2. Reversibility
Fully reversible — delete the file + tests. In-memory only; no persisted state.

## 3. State / data touched
None on disk. An in-memory Map keyed by an opaque requestId → {topicId, kind, server,
nonce, expiresAt}, TTL-pruned.

## 4. Failure modes
Fail-closed: peek/consume return null on absent/expired; consume is single-use
(removes regardless). peek NEVER returns the nonce (the page can't leak it).

## 5. Security / authority
The nonce is the approval secret; this store keeps it SERVER-SIDE and exposes it only
once via `consume` (called by the PIN-gated submit), never via `peek` (the page). The
opaque requestId carries no secret. No authority is exercised — it's a holding ledger;
the PIN gate + nonce consume in the route are the authority.

## 6. Framework generality
Framework-neutral in-memory store; no launch/inject surface.

## 7. Tests
6 unit tests: opaque id + peek-never-leaks-nonce; single-use consume; peek-doesn't-
consume; unknown-id null; TTL expiry (peek + consume); size/prune. tsc clean.
