# Side-Effects Review — Remote Session Close (POST /sessions/:name/remote-close)

**Version / slug:** `remote-session-close`
**Date:** `2026-06-12`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `required (session lifecycle: kill path) — appended below before ship`

## Summary of the change

Implements the approved converged spec `docs/specs/REMOTE-SESSION-CLOSE-SPEC.md`: the dashboard's × works on remote tiles by relaying an OPERATOR-origin close to the owning machine over a NEW route (`POST /sessions/:name/remote-close`, body `{machineId, sessionUuid}`) — machineId is a registry lookup key only, the Bearer token only travels past the shared `peerUrlGuard` allowlist, the relayed request is the peer's PLAIN UUID-targeted local DELETE (single-hop by construction), and the path is rate-limited. Outcomes are delivery-honest (peer-404 → calm already-closed; timeout → outcome-unknown, never "closed nothing"; non-JSON tunnel error pages normalized). Both ends keep a trail: the relayer appends to `logs/remote-close-audit.jsonl` (new `RemoteCloseAudit`, state-registry-registered) and the owner's reap-log gains an additive UNTRUSTED `viaClaim` (plumbed `terminateSession.opts.via` → `sessionReaped` event → `ReapLog`). `GET /sessions` rows gain an additive `protected: boolean` so the dashboard confirm can flag protected sessions (informed consent — the close still executes with operator authority, exactly like the local ×). Dashboard UX + CLAUDE.md template line + migration ship in the same PR. Files: routes.ts, SessionManager.ts, ReapLog.ts, commands/server.ts, RemoteCloseAudit.ts, dashboard/index.html, templates.ts, PostUpdateMigrator.ts, CapabilityIndex.ts, state-coherence-registry.json + three test tiers.

## Decision-point inventory

- `POST /sessions/:name/remote-close` — **add** — relays an operator COMMAND (same authority class as the existing local DELETE; reach expands from localhost to the pool — contained by rate limit + allowlist + dual audit).
- `DELETE /sessions/:id` — **modify (additive only)** — reads the untrusted `X-Instar-Close-Via` header into `viaClaim`; targeting, authority, and behavior unchanged (Tier-1 pinned).
- `peerUrlGuard` check before token attach — **pass-through** — the existing exempt-class hard guard, reused.
- Rate limiter on the relay path — **add** — transport mechanics (anti-kill-sweep), not judgment.
- `protected` flag on GET /sessions — **add** — pure signal for the UI confirm; consulted by NO server-side decision.

## 1. Over-block

The relay can refuse a LEGITIMATE close three ways, all visible and recoverable: `url-rejected` for a peer on a non-allowlisted URL (operator lever: `multiMachine.peerUrlAllowlist`; the close can still be issued directly against the peer), 429 when >10 relayed closes/minute (deliberate anti-sweep bound; single closes are unaffected), and 404 for a machineId not in the registry (correct — never guess a target for a destructive verb). No message/agent-behavior flow is gated.

## 2. Under-block

- A valid token holder can still close any session on any allowlisted machine — BY DESIGN (§2.0: operator authority; the containment is reach-limiting, not permission-narrowing). The rate limit bounds the blast rate, not the right.
- The peer's success answer is its word (peer-attested); the authoritative record stays the owner's reap-log — the dashboard presents observed state, stated in spec §2.3.
- `viaClaim` is forgeable by any token holder — accepted and labeled: it is a SIGNAL recorded for the trail, never consulted in authority (Tier-1 pin: forged via cannot alter kill handling).

## 3. Level-of-abstraction fit

The relay sits at the route layer and reuses the LOCAL close's full machinery on the owner (terminateSession with route-stamped origin) — it adds reach, not a parallel kill path. The URL check reuses the shared `peerUrlGuard` (single funnel, adopted exactly as the guards spec's tracked hardening intended). The audit is a dumb append-only JSONL like reap-log — no new query/abstraction surface.

## 4. Signal vs authority compliance

**Reference:** docs/signal-vs-authority.md

- [x] No — the relay executes an explicit operator command (the same class as the existing Bearer-authed DELETE); the new brittle checks are exempt classes: charset validation of machineId (boundary input validation), the URL allowlist (hard safety guard on credential egress with visible refusal), and the rate limit (transport mechanics). `viaClaim` and `protected` are pure signals; a Tier-1 test pins that the forged via changes no authority decision.

## 5. Interactions

- **terminateSession**: untouched semantics — `via` is carried, never read by the authority gates (operator bypass logic keys on `origin`, which only the route layer stamps).
- **Reap-log consumers** (`GET /sessions/reap-log`, ReapNotifier): `viaClaim` is additive; existing readers ignore unknown fields (verified shapes).
- **In-flight lock / CAS**: a relayed close lands as a normal operator DELETE on the owner — the existing idempotency (already-killed → 404) is what the relay maps to the calm already-closed UX; close-vs-transfer interleave inherits the same locks as today's local close.
- **Pool fan-out**: `protected` rides the existing GET /sessions enrichment and flows through `scope=pool` unchanged (additive field).
- **No shadowing**: the new POST path cannot collide with the existing DELETE (different method+path); a pre-feature server 404s the new path cleanly — the §2.1 mixed-version wrong-machine-kill shape is impossible by construction.

## 6. External surfaces

- New authenticated destructive verb reachable over the pool — the reason for: rate limit, allowlist-before-token, dual-end audit, and NO bulk endpoint (explicit non-goal).
- New durable file `logs/remote-close-audit.jsonl` (state-coherence-registered, write-site annotated). Reap-log rows gain optional `viaClaim`. Note: the zero-outbound 404 paths (unknown/invalid machineId) deliberately write NO relay-audit row — the registry defines the file as a record of every relayed ORDER, and a 404'd lookup never became an order; a probing sweep under the rate limit therefore leaves no relayer-side trace (second-pass finding, accepted as consistent with the registry definition).
- `GET /sessions` rows gain `protected` (additive; pre-feature peers' rows simply lack it — the dashboard renders "protection status unknown" for those, stated skew behavior).
- Dashboard confirm text changes for local closes too (gains the protected warning — deliberate, spec AC#6).
- CLAUDE.md template + migration (Migration Parity, both ways on rollback).

## 7. Rollback cost

Revert and ship a patch: the POST route disappears and old/reverted servers 404 it cleanly (the dashboard remote × degrades to an honest error toast — true by construction with the distinct path). Audit/reap-log rows are append-only history (no migration). The template line needs a removal migration on rollback (stated).

## Conclusion

The review confirms the spec's central honesty claim survives implementation: this adds REACH to an existing operator authority, not a new authority class — and every reach-expanding edge carries its containment (lookup-key-only targeting with zero-outbound 404s, allowlist-before-token, single-hop construction, rate limit, dual-end audit, delivery-honest outcomes). Clear to ship once the dashboard/template chunks land, all three tiers are green, and the second-pass reviewer concurs.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (session-lifecycle kill path → second pass REQUIRED), 2026-06-12.

**Verdict: Concur with the review.**

Key verifications (each checked against code, file:line):
- Allowlist-before-token holds: `isPeerUrlAllowedForCredentials` runs and returns 502 `url-rejected` (with audit row) BEFORE the fetch that attaches the Bearer token (routes.ts:6025-6031 vs :6039); no path sends the token to a non-allowlisted URL.
- Zero-outbound 404 verified: charset clamp + registry lookup both return before any network call; `machineId` is never concatenated into a URL — pinned by a live mock peer asserting zero hits for URL-shaped/traversal/unknown machineIds.
- Single-hop + wrong-machine-kill impossibility confirmed: the relayed request is a plain UUID-targeted DELETE with no relay marker; the peer's DELETE has no relay capability; pre-feature servers 404 the new POST path cleanly (E2E distinguishes route-alive 404 from route-missing).
- `viaClaim` never touches authority: operator-bypass logic keys solely on route-stamped `origin`; forged/junk via pinned by tests.
- Rate limit behind auth, keyed on req.ip with no `trust proxy` set — X-Forwarded-For cannot split buckets.
- Both-ends audit wired and verified on real disk in E2E; every relay outcome branch records; failed appends log loudly.
- Signal-vs-authority compliant: the three brittle blockers map onto documented exempt classes; `protected` and `viaClaim` are pure signals.

Non-blocking notes (recorded, none change the verdict): (1) zero-outbound 404 probes leave no relayer-side audit trace — accepted, definition-consistent, now stated in §6; (2) spec §3 test-list drift (close-vs-transfer interleave + explicit pre-feature-peer test not present verbatim; behavior substantially covered by the peer-404 calm path, in-flight lock inheritance, and the unchanged UUID-first DELETE); (3) the relay sends the relayer's own authToken to the peer — identical to existing scope=pool and /guards fan-outs, degrades visibly to `unauthorized` 502 in a non-shared-token fleet; callsite flagged for the eventual X-Instar-AgentId deprecation-window-close sweep.

## Evidence pointers

- Tier-1+2: `tests/integration/remote-session-close.test.ts` (16 — zero-outbound pins, no-token-on-url-rejected, single-hop assertion, via-forge pin, ghost-safe UUID targeting, delivery-honest outcomes, protected flag).
- Tier-3: `tests/e2e/remote-session-close-lifecycle.test.ts` (11 — feature-alive, full real-HTTP relay with both trails verified on disk, wired source guards on the via plumb).
- Spec: `docs/specs/REMOTE-SESSION-CLOSE-SPEC.md` (approved 2026-06-12, topic 13481), convergence report in docs/specs/reports/.
