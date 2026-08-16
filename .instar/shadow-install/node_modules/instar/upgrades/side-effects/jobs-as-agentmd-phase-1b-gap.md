# Side-effects review — Phase 1b-gap closure (lockTrust → allowlist gate)

## What changed

`JobScheduler.resolveAllowlist` now refuses tool elevation for `origin:instar` agentmd jobs whose `lockTrust` is in a real-tamper state. Three lockTrust values are real-tamper:

- `untrusted-bad-signature`
- `untrusted-not-in-lockfile`
- `untrusted-hash-mismatch`

When any of those values is present on an `origin:instar` job, the resolver returns a new resolution kind `lock-untrusted-clamped` with `allowlist: ['Read']`. This applies both to the explicit `toolAllowlist:"*" + unrestrictedTools:true` elevation path AND to the implicit `instar-no-allowlist` full-tools fallback.

Two states intentionally do NOT trigger the clamp:

- `trusted` — elevation proceeds normally.
- `untrusted-no-lockfile` — the documented transitional state. Until Phase 1c-build ships the signing pipeline, every existing agent's instar-origin job will be in this state on the very first boot after applying the update. Clamping here would break the seamless-migration property — agents would lose tool access until they get a new release.

A new event `job_lock_untrusted_clamped` is emitted to the state event stream and a degradation event is reported when the clamp fires. The `clampedAllowlist` run-record field is already set, so the run-history table surfaces the clamp without any schema change.

## Side-effects review (mandatory gate)

### 1. Over-block / under-block

- **Over-block:** transitional `untrusted-no-lockfile` is excluded from the tamper set. Without this carve-out, the very first boot after applying this PR would clamp every existing agent's instar default to `[Read]`, breaking working jobs that have legitimate full-tool authorization. The Seamless Migration Guarantee invariants 1, 2, and 4 require existing-agent operation to be preserved on update; clamping here would violate them.
- **Under-block:** all three real-tamper states are covered. The Phase 1c loader already excludes `hash-mismatch` entries from `jobs[]` (skip-until-ack), so in practice that state never reaches the resolver — the test exercises it for defense-in-depth.

### 2. Level-of-abstraction fit

The clamp lives in `resolveAllowlist`, the pure decision point for allowlist resolution. It is NOT layered on top in the caller. Putting it inside `resolveAllowlist` means:

- Every call site is covered without needing to remember the gate.
- The decision is auditable in one place.
- Unit tests exercise the gate as a pure function on `JobDefinition`.

A new pure classifier `JobScheduler.isLockUntrustedTamper` exists so the same predicate can be reused by future callers (e.g., grounding-audit gate, Dashboard "this job's trust is degraded" indicator). It is exported alongside `resolveAllowlist`.

### 3. Signal-vs-authority compliance

`lockTrust` is computed by `AgentMdLockFile.readLockFile` — a low-level Ed25519 verifier with full per-slug hash check context. That layer is the canonical signal. `resolveAllowlist` consumes the signal and applies a structural rule. The resolver is the authority for "what tools does this job spawn with"; the lock-file is the signal for "is this job's content trusted." Authority sits at the spawn-decision layer, not the verifier — correct separation.

### 4. Interactions

- **Grounding-audit gate** (`JobLoader.auditGrounding`) — also consumes `lockTrust`. Behavior is preserved: tamper states already cause the entry to be excluded from `jobs[]` for `untrusted-hash-mismatch`; for the other two, the audit gate's separate decision is unchanged.
- **`emitAllowlistSignals`** — extended to emit one Dashboard event (`job_lock_untrusted_clamped`) and one degradation event when the new clamp fires. Both surfaces are best-effort (existing pattern: try/catch around `DegradationReporter.report` with `@silent-fallback-ok`).
- **Run record** — `clampedAllowlist: true` already gets written for any clamp; the new clamp surfaces through the same field. No schema migration needed. `unrestrictedTools` correctly reports `false` for the new clamp.
- **Existing tests** — no behavioral regression. All 27 tests in `tool-allowlist.test.ts` pass (15 original + 12 new). All 130 unit-scheduler tests pass.

### 5. Rollback cost

Trivial. The clamp is one branch in a pure function and one branch in the signal emitter. Reverting is a one-commit `git revert`. There is no on-disk state change associated with this PR — the resolver computes per call, no caching.

### 6. Seamless Migration Guarantee compliance

This PR is the first one to LAND under the new guarantee (PR #180 merged the spec). The carve-out for `untrusted-no-lockfile` is exactly the spec's "existing agents do not lose tool access on the very first boot after applying the update" invariant. The test
`'allows elevation when lockTrust=untrusted-no-lockfile (transitional, pre-Phase-1c-build)'`
is the structural assertion of that invariant for this code path.

## Test coverage

`tests/unit/scheduler/JobScheduler.tool-allowlist.test.ts` adds 12 new tests under a new `describe('JobScheduler.resolveAllowlist lockTrust gap-closure')` block:

- 3× real-tamper elevation refusal (one per tamper state, explicit `"*"` + `unrestrictedTools:true`)
- 3× real-tamper implicit-fallback refusal (one per tamper state, no-allowlist path)
- `trusted` elevation allowed
- `untrusted-no-lockfile` elevation allowed (seamless-migration invariant)
- `untrusted-no-lockfile` no-allowlist preserves transitional behavior
- User-origin not gated even with stale lockTrust value (defense-in-depth)
- `isLockUntrustedTamper` classifier — positive cases
- `isLockUntrustedTamper` classifier — negative cases including `undefined`

All 27 tests in the file pass locally. Broader 130-test scheduler suite is green.

## Spec reference

INSTAR-JOBS-AS-AGENTMD-SPEC §Trust Model + §Per-job tool allowlist + the new §Seamless Migration Guarantee invariants 1, 2, 4 (merged via PR #180).

## What is NOT in this PR

- The grounding-audit gate's structural integration with `lockTrust` (already shipped in Phase 1c-runtime).
- Dashboard surface for the new `job_lock_untrusted_clamped` event — Phase 4.
- Build-pipeline signing that moves agents from `untrusted-no-lockfile` to `trusted` — Phase 1c-build (next PR).
