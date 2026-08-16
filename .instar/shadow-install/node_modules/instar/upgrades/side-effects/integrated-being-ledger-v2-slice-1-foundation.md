# Side-Effects Review — Integrated-Being Ledger v2, Slice 1 (Foundation)

**Version / slug:** `integrated-being-ledger-v2-slice-1-foundation`
**Date:** `2026-04-17`
**Author:** Echo
**Second-pass reviewer:** pending — will be appended before commit via reviewer subagent (slice is on the high-risk list per the /instar-dev skill: it introduces session lifecycle and an authenticated write channel into the ledger).

## Summary of the change

First of eight planned slices implementing `docs/specs/integrated-being-ledger-v2.md`. Adds the foundation for session-authenticated writes to the shared-state ledger. Ships dark behind `config.integratedBeing.v2Enabled=false` (default).

Slice 1 lands:

- A new `LedgerSessionRegistry` class that issues and verifies per-session binding tokens, with absolute + idle TTLs and persistence to `.instar/ledger-sessions.json` (mode 0o600, SHA-256 hashed tokens — no plaintext on disk).
- Two endpoints under `/shared-state/*`:
  - `POST /shared-state/session-bind` — registers a session id and returns a plaintext binding token once (idempotent replay within TTL returns the cached token).
  - `POST /shared-state/append` — authenticated session-write for `agreement | decision | note` entry kinds.
- Type surface for v2 commitment fields and session registration metadata (used by later slices; not callable from slice 1 — `commitment` kind returns 501 with `X-Pending-Slice: 3`).
- v1 ledger's `VALID_SUBSYSTEMS` extends with `'session'` and `VALID_PROVENANCE` extends with `'session-asserted'`, enabling session-authored entries to pass schema validation.
- Server-boot wiring: `LedgerSessionRegistry` instantiated when `v2Enabled=true`, passed through `AgentServer` options into `RouteContext`.

Files touched:

- `src/core/LedgerSessionRegistry.ts` (new, ~340 LOC)
- `src/core/types.ts` (v2 types + config knobs) — **landed in commit 50b2a2a** (see coordination note below)
- `src/core/SharedStateLedger.ts` (two const arrays extended)
- `src/server/routes.ts` (v2 endpoint block appended; `RouteContext` extended) — **landed in commit 50b2a2a** (see coordination note below)
- `src/server/AgentServer.ts` (constructor option added; RouteContext fed)
- `src/commands/server.ts` (registry instantiation when `v2Enabled=true`)
- `tests/unit/LedgerSessionRegistry.test.ts` (new, 27 tests)
- `tests/unit/sharedStateRoutesV2.test.ts` (new, 19 tests)
- `tests/unit/SharedStateLedger.test.ts` (one test updated — `'session-asserted'` is no longer an invalid provenance label)

**Coordination note:** `src/core/types.ts` and `src/server/routes.ts` were committed in parallel by another session (commit `50b2a2a feat(backup): BackupConfig plumbing + union-merge includeFiles`) that used a broad `git add` during its own /instar-dev run — my uncommitted v2 additions got swept into their commit. The v2 code IS on main; this slice's commit covers the remaining foundation pieces (registry class, ledger const-array extensions, server wiring, tests, plan, and this artifact). No work is lost; the split is noted here for audit traceability and will be called out in slice 2's artifact so reviewers don't hunt for "where did the v2 endpoints land."

## Decision-point inventory

| Decision point | Change | Description |
|---|---|---|
| `LedgerSessionRegistry.verify()` | **add** | Structural validator at auth boundary: checks token hash equality, idle/absolute TTL, revocation status. Brittle-blocker by design — this is a hard-invariant auth gate, not a judgment call. |
| `/shared-state/append` schema validation | **add** | Hard-invariant structural validator at the API edge (type, subject length, counterparty shape, dedupKey charset). Per signal-vs-authority doc §"When this principle does NOT apply" — structural validators at the boundary are allowed to be brittle. |
| `/shared-state/append` kind gate | **add** | Blocks `commitment` (501, slice 3) and `thread-*` (400, server-emitter-only). Enumerated allowlist. |
| `/shared-state/append` forbidden-field gate | **add** | Rejects client-supplied `commitment` / `provenance` / `emittedBy` / `source` / `id` / `t`. Server-bound fields; structural. |
| `v2Enabled` feature flag | **add** | Deterministic boolean gate on route registration. Closes the rollback path (flip false → endpoints 503). |

No judgment-shaped decisions are introduced in slice 1. All new decision points are carved-out brittle blockers at API/auth boundaries.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- A legitimate session making a `commitment`-kind write today gets 501 with `X-Pending-Slice: 3`. Intentional — slice 3 lands the mechanism-ref validator; shipping `commitment` without it would allow unvalidated commitments into the ledger.
- A session supplying `provenance: 'session-asserted'` explicitly (redundant, since server overrides anyway) gets a 400. Strict — clients can't know what the server will bind, and the spec explicitly reserves these fields as server-bound.
- A session supplying `counterparty.trustTier` as a hint currently gets NO 400 — the field is accepted but silently overridden server-side to `'untrusted'` in slice 1. (Spec §2 says trust-tier discrepancy hints are noted; slice 1 doesn't emit that note yet — added in slice 3 when `MechanismRefValidator` lands, since that's the natural host for trust-tier logic.)

**New over-block risks introduced by the change:**

- The `dedupKey` charset `[a-zA-Z0-9-_.:]` is strict. A session migrating a key from an external system that includes other characters (say, slashes from an issue tracker id) would 400. Mitigation: sessions MUST generate their own keys; dedupKey is an instar-internal idempotency token, not a passthrough of external ids.
- Slice 1's `/append` does NOT validate mechanism-ref timing, dedup-index hits, rate limits, or passive-wait caps. These are intentional deferrals — slice 1 is auth-only. v2Enabled=false gates the whole surface until later slices land; operators shouldn't flip the flag on until all slices are in.

---

## 2. Under-block

**What failure modes does this still miss?**

- A session with a valid binding token can write arbitrary volumes of `agreement | decision | note` entries today — per-session / per-agent-global rate limits are slice 3 scope. Mitigation: v2Enabled stays false until slice 3 lands; observation period is predicated on the full surface being present.
- Near-duplicate dedup index is slice 3 — so near-identical repeated writes within the dedupKey-unique set all land. Same mitigation.
- The session-bind endpoint is bearer-token-gated. The spec's "Open architectural questions" §1 documents that any bearer-token holder can call `session-bind` directly with a fabricated session id, bypassing the 0o600 file-handoff boundary. Explicit v2.1 deferral. Slice 1 does not close it and does not claim to.
- Dashboard revocation UI is slice 6; for slice 1, revocation is programmatic only. Acceptable — v2Enabled=false means no session is actually depending on revocation to protect itself today.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

- `LedgerSessionRegistry` sits alongside `SharedStateLedger` in `src/core/` — same conceptual layer, explicit spec-required separation from the existing tmux `SessionManager` (which handles process lifecycle, not ledger identity).
- Session-bind / append endpoints sit in `src/server/routes.ts` alongside the v1 `/shared-state/*` endpoints, behind the same bearer-token auth middleware. No parallel auth stack.
- Token hashing uses `crypto.timingSafeEqual` via a hex-decode helper — chosen over a direct string equality comparison to close timing side-channels on the auth path. Lowest-level primitive where it makes sense.
- Plaintext token caching is explicitly in-memory-only on the registry instance — the cache is never persisted. Supports the spec's idempotent hook-replay requirement without widening the disk footprint.

Nothing in slice 1 is at the wrong layer. Nothing in slice 1 bypasses an existing smarter gate.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no judgment-shaped block/allow surface. The brittle blockers in slice 1 are at carved-out categories per the principle doc: structural validation at the API edge (schema/kind/charset), hard-invariant auth (`verify()` token check), and deterministic feature-flag gating. None of them make judgment calls about message meaning or agent intent.

Narrative: the principle doc explicitly permits brittle blocking on (a) hard-invariant validation at boundaries, (b) safety guards on irreversible actions, and (c) idempotency/dedup at transport. Slice 1's decision points fall into (a) and (c). The future judgment-shaped decisions in v2 (effective commitment status, resolution-tier trust calibration, dispute aggregation) are all explicitly signal-shaped in the spec — no brittle blocker holds authority over any semantic question.

The one risk to watch in slice 3: when the dedup index lands, it MUST stay as a transport-layer idempotency mechanic (normalized hash → 409). If anyone extends it to "maybe this is similar enough" — that would move it from mechanics into judgment and violate the principle. Slice 3's side-effects artifact will need to explicitly verify this.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** the new `/shared-state/append` endpoint does NOT shadow any existing write path. v1 had no session-write endpoint — the append channel is new surface. Server-side emitters (`registerLedgerEmitters`) continue to write directly via `SharedStateLedger.append()` without going through the new endpoint.
- **Double-fire:** session-asserted writes could double-fire with a threadline-emitted entry IF a session happens to write about a thread event the threadline subsystem also emitted. This is expected — the spec explicitly contemplates shadow-session writes as complementary to subsystem emitters, not overriding them. The dedupKey is per-writer-scope in slice 1; dedup-index (slice 3) adds cross-writer near-dup detection.
- **Races:** the registry persists to `.instar/ledger-sessions.json` with a `tmp.<pid>` + rename pattern, so concurrent registrations on the same session id can race at the file level. The in-memory Map is authoritative within a process; multi-process race is not a realistic failure mode in the single-server instar topology (only one agent server per agent).
- **Feedback loops:** session-write does NOT trigger any subsystem emitter today. If a session writes a `decision` with `counterparty.name = 'self'`, no other subsystem re-emits or echoes it. Closed loop.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** no. Each agent has its own server, its own registry, its own ledger.
- **Other users of the install base:** no effect with `v2Enabled=false` (default). Endpoints 503; nothing else changes. v1 reads and emitters unchanged.
- **External systems:** no. Session-write is local-only; no outbound network I/O in slice 1.
- **Persistent state:** adds `.instar/ledger-sessions.json` (0o600, SHA-256 hashed tokens). Cleanup on rollback: the file is orphan-safe (stale state with no readers), and `instar ledger cleanup` will be extended in slice 5 to purge it. For slice 1, `rm .instar/ledger-sessions.json` is the hand-cleanup.
- **Timing / runtime conditions we don't fully control:** the registry's persist() uses synchronous FS writes under a temp-and-rename — no async ordering hazards. Reliant on the filesystem supporting atomic rename (standard on all supported platforms).

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release:** pure code revert. With `v2Enabled=false` default, no install has the endpoints exposed yet; the revert has zero user-visible impact on live agents. Ship as next patch.
- **Data migration:** none. The registry file is additive, not replacing anything. Orphan cleanup recoverable by `rm .instar/ledger-sessions.json` or the extended `instar ledger cleanup` in slice 5.
- **Agent state repair:** none. No agent has active bindings until `v2Enabled` flips (explicit opt-in per config).
- **User visibility during rollback window:** none. v1 surface unchanged; v2 endpoints 503 during rollback — identical to pre-slice-1 state since `v2Enabled` was never expected to be true yet.

Estimated rollback effort: <5 minutes for the code revert; 0 minutes for state cleanup (automatic via existing mechanisms in the spec's explicit rollback plan §5).

---

## Conclusion

Slice 1 lands the foundation: session identity registry + session-authenticated write endpoint, both gated dark behind `v2Enabled=false`. Zero user-visible impact. 25 registry unit tests and 19 HTTP route tests pass; v1 tests unchanged (one updated for the new valid `'session-asserted'` provenance label). Typecheck clean.

The spec's two stated open architectural items (session-bind privilege separation, interactive-bind challenge-response) are NOT addressed in slice 1 — they're v2.1 work, documented in the spec, and do not block the foundation. Slice 2 handles the session-start hook wiring and migration command; slice 3 adds mechanism-ref validation, the dedup index, and rate limits; subsequent slices complete the resolution flow, sweepers, and dashboard.

The slice is ready to ship behind the `v2Enabled=false` flag. Second-pass reviewer will audit this artifact before the actual commit.

---

## Second-pass review (required — this slice is on the high-risk list)

**Reviewer:** independent reviewer subagent (Phase 5 of /instar-dev).
**Independent read of the artifact:** concern raised — one blocking, two minor.

### Concerns raised by reviewer (verbatim)

1. **Absolute TTL can be refresh-revived across server restart (LedgerSessionRegistry.ts:245-264).**
   When the server restarts, the plaintext cache is lost. If a caller re-calls `register()` with the same sessionId before absolute expiry, the code issues a new token and sets `absoluteExpiresAt = now + absoluteTtlMs()` — recomputed from the current time, not from the original `registeredAt`. This lets a session effectively refresh-revive its absolute TTL indefinitely by re-registering across restarts, contradicting spec §"Token absolute TTL" which states "A token is invalid past this age regardless of session activity. Prevents a leaked token from being refresh-revived indefinitely." Resolution: compute `absoluteExpiresAt = new Date(registeredAt).getTime() + absoluteTtlMs()` on the same-sessionId rebind path; if that's already past, refuse the rebind.

2. **Minor (non-blocking): corrupt-hydrate is silent (LedgerSessionRegistry.ts:162-164).**
   A corrupt `ledger-sessions.json` starts the registry empty with no degradation event — operator sees no signal that all active sessions just got invalidated. Recommend emitting a `DegradationReporter` event on hydrate catch. Not blocking for slice 1 since v2Enabled=false means no live callers, but worth landing before slice 2.

3. **Minor (non-blocking): forbidden-field gate runs after schema validation (routes.ts:10262-10277).**
   A request that supplies `commitment` alongside a valid kind will hit the 400-forbidden-field path only after subject/counterparty/dedupKey validation. Cosmetic; the current order is fine for slice 1.

### Resolution

**Concern 1 (blocking) — FIXED in this slice.**
`LedgerSessionRegistry.register()` now anchors `absoluteExpiresAt` to `registeredAt + absoluteTtlMs()` on the rebind path. If the anchored value is already past `now`, the call throws (HTTP 400 surfaces via the session-bind endpoint) with the message `sessionId absolute TTL exhausted; generate a new sessionId to rebind`. Two regression tests added to `tests/unit/LedgerSessionRegistry.test.ts`:

- `absolute TTL is ANCHORED to registeredAt, not refresh-revived across restart` — simulates a server restart at +90min with 2h TTL, verifies the rebind does NOT extend the window.
- `throws when absolute TTL has fully elapsed (refuses same-sessionId rebind)` — verifies the refuse path.

Both pass (27/27 registry unit tests green).

**Concerns 2 + 3 (minor) — carried to slice 2.**
Slice 2 touches the session-start hook and migration command, which is the natural place to add degradation reporter wiring to registry hydrate; and slice 2's reviewer audit will catch route-handler error-ordering patterns that might benefit from consolidation. Neither is blocking for slice 1 since `v2Enabled=false` means there are no production callers depending on either property.

### Final verdict

With concern 1 fixed, the reviewer's blocking finding is closed. Minor items are explicitly carried forward to slice 2 with documented traceability. Signal-vs-authority compliance is otherwise clean; claims-vs-reality verification passed; rollback path holds.

**Slice 1 ready to commit.**

---

## Evidence pointers

- Unit test results: `tests/unit/LedgerSessionRegistry.test.ts` (25 passed, 321ms) and `tests/unit/sharedStateRoutesV2.test.ts` (19 passed, 1112ms).
- Full v1+v2 test sweep: `tests/unit/SharedStateLedger.test.ts` (29 passed) + `tests/unit/sharedStateRoutes.test.ts` (13 passed) — all unchanged behavior confirmed.
- Typecheck: `npx tsc --noEmit` returns exit 0.
- Spec: `docs/specs/integrated-being-ledger-v2.md` (approved 2026-04-17).
- Implementation plan: `docs/specs/plans/integrated-being-ledger-v2-implementation-plan.md`.
