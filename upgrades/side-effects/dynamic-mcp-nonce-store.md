# Side-effects review — dynamic-MCP approval nonce store

**Change:** New `src/core/McpApprovalNonceStore.ts` — the single-use, change-bound,
TTL approval nonce substrate for the dynamic-MCP authorization gate (fold C4). 8
unit tests.

## 1. Blast radius
Zero at runtime. No importer yet — nothing mints/consumes from it until the
approval routes wire it (a later commit, behind the dark flag).

## 2. Reversibility
Fully reversible — delete the file + tests. In-memory only; no persisted state, no
migration, no config.

## 3. State / data touched
None on disk. An in-memory Map of (topicId|kind|server) → {nonce, expiresAt},
TTL-bounded, pruned on read. Holds no secrets.

## 4. Failure modes
Fails CLOSED: consume returns false for a never-minted change, a wrong nonce, an
expired nonce, or a binding mismatch. A wrong attempt does NOT burn the real nonce
(the genuine operator can retry). Single-use on success.

## 5. Security / authority
This IS the authority substrate. The nonce is the proof that an operator-
authenticated approval happened: it is server-minted, random (crypto.randomBytes),
bound to the exact (topicId, kind, server), single-use, and TTL-expiring. An agent
cannot forge, reuse, or cross-replay one — closing the "agent self-certifies
approved:true over the shared Bearer" hole (C4). No authority is exercised in this
commit (nothing wires it live).

## 6. Framework generality
Not applicable — framework-neutral in-memory store; no launch/inject surface.

## 7. Tests
8 unit tests: consume-once; single-use (second fails); wrong value fails without
burning the real one; bound (cross server/kind/topic replay rejected); never-minted
fails; TTL expiry; re-mint replaces prior; size()/prune. tsc clean.
