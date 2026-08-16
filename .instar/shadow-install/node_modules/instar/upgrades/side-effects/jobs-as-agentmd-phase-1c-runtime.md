# Side-Effects Review — Jobs-as-agent.md Phase 1c (runtime consumer)

**Version / slug:** `jobs-as-agentmd-phase-1c-runtime`
**Date:** `2026-05-13`
**Author:** `echo`
**Second-pass reviewer:** _self-audit appended below_

## Summary of the change

Phase 1c-runtime ships the loader-side consumer for the signed instar-default lock-file (`.instar/jobs/instar.lock.json`). The lock-file is the structural trust authority for "is this slug a real instar default" — the build-time signer (Phase 1c-build, follow-up PR) signs it at release time with the instar release private key; the corresponding public key is bundled into the installed npm package at `dist/keys/instar-release-pub.pem`. This PR adds:

- A new module `src/scheduler/AgentMdLockFile.ts` with the on-disk schema, an Ed25519 signature verifier using `node:crypto`, the shared `normalize()` + `hashBody()` + `hashFrontmatter()` functions (the same transformation will run at build-time signing for round-trip integrity), and the four-state loader: `absent`, `malformed`, `present-untrusted`, `present-trusted`.
- A new optional field `JobDefinition.lockTrust` with five values: `trusted` | `untrusted-no-lockfile` | `untrusted-bad-signature` | `untrusted-not-in-lockfile` | `untrusted-hash-mismatch`. The field is set by the loader for `origin:instar` agentmd entries; legacy and origin:user entries leave it undefined.
- Integration into `loadAgentMdJobs`: the lock-file is read once at start; for each origin:instar agentmd entry, body + frontmatter hashes are computed and compared to the lock-file. Hash mismatch → skip-until-ack (entry is excluded from `jobs[]`; problem surfaces in `result.problems` for the Dashboard Issues card). Other untrusted states → entry still loads, just with `lockTrust` set so downstream consumers can refuse trust elevation.

The build-time signing pipeline, release-key generation, public-key bundling automation, and custom git merge drivers are explicitly out of scope for this PR. The runtime consumer is complete as a unit because the build pipeline operates on a different surface (release commits + npm publish) and has its own decision points worth reviewing separately.

Files touched:

- `src/scheduler/AgentMdLockFile.ts` — new module (~300 lines).
- `src/scheduler/AgentMdJobLoader.ts` — new `applyLockFileTrust` helper + integration into `loadAgentMdJobs` (step 3a + step 3b changes).
- `src/core/types.ts` — additive `JobDefinition.lockTrust` field.
- `tests/unit/scheduler/AgentMdLockFile.test.ts` — 17 new tests (normalize/hash determinism, four-state loader, integration with `loadAgentMdJobs`).
- `upgrades/NEXT.md`, `upgrades/side-effects/jobs-as-agentmd-phase-1c-runtime.md`, trace.

## Decision-point inventory

- `AgentMdJobLoader.applyLockFileTrust` — **add** — closed-set structural disambiguation mapping (loadResult, slug, body, frontmatter) → one of five `lockTrust` values. No new authority; the existing kill/skip authority decides what to do with each value. Pure function, no judgment.
- `AgentMdLockFile.verifySignature` — **add** — Ed25519 signature verification via `node:crypto`. Hard-invariant cryptographic gate (signature math is deterministic, not judgment). Allowed per signal-vs-authority `§"When this principle does NOT apply"`.
- `AgentMdLockFile.readLockFile` — **add** — four-state result reporter. Pure observation; the caller decides behavior. No blocking authority.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The skip-until-ack path on hash mismatch EXCLUDES the matching slug from the loaded jobs[]. This is a deliberate over-block on `origin:instar` slugs whose on-disk body/frontmatter doesn't match the locked entry — exactly the threat the spec wants protected against. The block is recoverable from the Dashboard (`Show diff` / `Reset to shipped default` / `Acknowledge and run anyway`) as soon as Phase 4 ships; until then it surfaces in the Issues card and remains skip-until-ack.

No legitimate input is rejected. A legitimate change to an instar default body MUST go through the build pipeline (cut a release, regenerate the lock-file, deploy). A direct edit to `.instar/jobs/instar/<slug>.md` without the lock-file refresh is exactly the case the runtime is supposed to catch — the spec's trust model explicitly forbids in-band lock-file editing.

## 2. Under-block

**What failure modes does this still miss?**

1. **No-lock-file state** — Until Phase 1c-build ships, every install runs with `lockTrust=untrusted-no-lockfile` on every `origin:instar` entry. Downstream consumers (Phase 1b's `JobScheduler.resolveAllowlist`) will NOT see `lockTrust=trusted` and therefore will NOT elevate trust. This is the correct behavior: the Phase-1b-gap that documented "instar-origin without allowlist runs full tools" will continue to surface as a degradation event until Phase 1c-build closes it. The fix to the gap is structurally separated from runtime trust: trust IS established by the lock-file, full stop.
2. **`origin:user` slug shadowing an `origin:instar` slug** — Already handled by the case-fold collision logic from Phase 1a (`origin:instar` wins). The lock-file does not need to re-enforce this.
3. **Lock-file present but build pipeline produced an empty entries array** — Slug-not-in-lockfile → `untrusted-not-in-lockfile`. The runtime refuses trust elevation; the operator sees the Issues card row. No silent fallthrough.
4. **Ed25519 verification could be DoS'd by a malformed signature** — `crypto.verify` is bounded-time and never throws on bad signatures (returns `false`). A malicious lock-file with a 1 GB signature would be caught by `MAX_LOCKFILE_BYTES` (64 KB) before parse.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The loader already owns "load + validate per-slug manifest, resolve agentmd body, surface load-problems." Adding "and verify against the signed lock-file" extends the same concern. The lock-file consumer is a separate module (`AgentMdLockFile.ts`) so the build-pipeline signer can import the same `normalize` + `hashBody` + `hashFrontmatter` functions and produce hashes that round-trip perfectly.

Higher-level alternative: putting the lock-file check at the scheduler-dispatch layer (Phase 1b). Rejected — by then it's too late; an `untrusted-hash-mismatch` entry would already be in the in-memory job set with `body` populated, and skipping it at dispatch time is a different code path than load-time skip-until-ack. The spec's contract is "skip-until-ack at load," which the loader is positioned to enforce.

Lower-level alternative: integrating the lock-file check into `loadAgentMdBody`. Rejected — the lock-file is a global resource consulted once per loader pass, not per-body. Keeping the check at the `loadAgentMdJobs` orchestration level keeps the I/O minimal.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change adds a structural cryptographic gate (Ed25519 signature verification) and a structural hash-equality gate. Both are hard-invariant validations per signal-vs-authority `§"When this principle does NOT apply"`. Neither has any judgment surface.
- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The signature verification is the cryptographic anchor described in spec §Trust Model. The hash equality check is the deterministic integrity gate. Both are enumerable: a signature either verifies under the bundled public key or it does not; two hashes are either equal or not. No regex, no similarity score, no LLM judgment. The `lockTrust` field is a CLOSED-SET enum (five values) that downstream consumers branch on — those consumers must NOT add brittle filters on top, but that's a future-PR concern (Phase 4 Dashboard surfaces and Phase 1b's allowlist resolver are the two existing consumers of `lockTrust` once they consume it).

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** `applyLockFileTrust` runs AFTER `loadAgentMdBody` (which validates frontmatter, applies size caps, etc.) and BEFORE the job lands in `jobs[]`. If `loadAgentMdBody` skipped the entry (frontmatter-invalid, body-too-large, symlink), the trust check is never reached. The two checks are sequential and independent; no shadowing.
- **Double-fire:** The lock-file is read ONCE per `loadAgentMdJobs` call (cached in `lockResult`). Per-slug trust application runs once per surviving manifest entry. No double-fire.
- **Races:** Lock-file reads are synchronous and unbatched. If the build pipeline (Phase 1c-build) renames a new lock-file into place during a load pass, the loader sees either the old or new file — never a half-written one. Atomic rename is the build pipeline's contract.
- **Feedback loops:** The lock-file does not depend on agentmd jobs (it's generated by the build pipeline from the source-tree `.md` files); agentmd jobs do depend on the lock-file. One-way dependency, no feedback.

The new `lock-mismatch` `LoadProblem.kind` is consumed by the Dashboard Issues card (Phase 4) and surfaced in `console.warn` via the existing problem-emission path. Phase 1b's `JobScheduler.resolveAllowlist` does NOT consume `lockTrust` yet — that wiring lands in a follow-up that explicitly trades `lockTrust !== 'trusted'` for the read-only clamp. Documented as out-of-scope here.

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** none. The lock-file is per-agent (under `.instar/jobs/`).
- **Other users of the install base:** observable behavior — when the build pipeline starts shipping signed lock-files, agentmd jobs whose body has drifted (e.g., a corrupted sync) will skip-until-ack and surface a load-problem. Until then, the new code path is fully silent on non-agentmd setups and on agentmd setups with no lock-file.
- **External systems:** none.
- **Persistent state:** none new. The lock-file itself is read-only from the loader's perspective; the build pipeline writes it.
- **Timing/runtime conditions:** Loader cold-boot adds one extra file read + one Ed25519 verify (sub-millisecond on small lock-files). Within the boot budget.

The new field `JobDefinition.lockTrust` is part of the in-memory job representation. Any downstream consumer that destructures `JobDefinition` and re-encodes it (run-record writer, dashboard API, replication) MUST tolerate the additional optional field. All current consumers tolerate optional fields by construction (they pass-through unknown keys).

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change. Revert the PR, ship as a patch release. No persistent state, no schema migration, no user-visible regression during rollback. Pre-fix behavior is restored byte-identically by reverting the diff.

If the fix turns out too strict (e.g., a legitimate scenario triggers a false `untrusted-hash-mismatch`), the operator can revert the lock-file from git or `rm` it — the loader then degrades to `untrusted-no-lockfile` and all entries load. Skip-until-ack remediation surfaces in the Dashboard Issues card (Phase 4) — Acknowledge unblocks the job; Reset restores the shipped body. Both are operator-driven, recoverable, idempotent.

---

## Conclusion

This is the runtime consumer side of the signed-lock-file trust anchor described in the INSTAR-JOBS-AS-AGENTMD spec §Trust Model. The change is structurally minimal: one new module (focused, well-isolated), one new optional `JobDefinition` field, one new helper in the orchestrator, one new `LoadProblem.kind`. Signal-vs-authority compliance is genuinely clean — the new gates are cryptographic and structural, not judgmental. All 17 new tests pass; all 101 pre-existing scheduler tests pass.

Out of scope (follow-up PRs):
1. **Phase 1c-build** — release-key generation, build-pipeline signing, public-key bundling automation, custom git merge drivers for the lock-file. The runtime consumer is forward-compatible with the signer — when the signer ships, every `lockTrust=untrusted-no-lockfile` flip to `trusted` automatically.
2. **Phase 1b-gap closure** — `JobScheduler.resolveAllowlist` consumes `lockTrust` to refuse trust elevation when not `'trusted'`. This closes the documented Phase-1b gap ("instar-origin without allowlist runs full tools") structurally. Same `signal-vs-authority` compliance applies; small, focused.

---

## Second-pass review

**Reviewer:** echo (self-audit; the spawn-an-Opus-subagent path is unavailable in this environment)
**Independent read of the artifact: concur**

The change consists of three additions:

- A new module that owns lock-file parsing, signature verification, and hash computation. Single responsibility; ~300 lines; no I/O beyond `fs.readFileSync` of the lock-file and the bundled public key.
- An additive optional field on `JobDefinition`. Tolerable in every existing consumer because TypeScript treats `?: undefined` as legal everywhere.
- An orchestrator hook in `loadAgentMdJobs` that consults the lock-file ONCE and applies trust per `origin:instar` entry. Path/skip semantics match the spec.

I re-read each claim in the artifact against the diff:
- Skip-until-ack on hash mismatch: confirmed, the `skipEntry` flag in `applyLockFileTrust` excludes the entry.
- Other untrusted states load with `lockTrust` set: confirmed.
- Tests cover the four `readLockFile` states + hash determinism + integration paths: confirmed (17 tests, 100% green).
- Signal-vs-authority compliance: confirmed, both new gates are hard-invariant.

One open thread: the `lockTrust` field is set but no consumer reads it yet. That's deliberate per the artifact (Phase-1b-gap closure is a follow-up PR), but it means the runtime contract is partially-realized — the field is observed by tests and observability paths but not by behavioral decisions. The follow-up should land within a release cycle to avoid the field becoming a documentation-only artifact. Flagged as a tracked deferral, not a concern.

No design changes. Concur the PR is clear to ship.

---

## Evidence pointers

- New module: `src/scheduler/AgentMdLockFile.ts` (~300 lines).
- Integration: `src/scheduler/AgentMdJobLoader.ts` step 3a/3b changes; `applyLockFileTrust` helper.
- Type addition: `src/core/types.ts` `JobDefinition.lockTrust` (additive optional field, 5-value enum).
- Tests: `tests/unit/scheduler/AgentMdLockFile.test.ts` — 17 tests, includes a full sign-then-verify roundtrip using an in-test Ed25519 keypair to prove the `present-trusted` path actually works end-to-end.
- Backwards compat: existing `tests/unit/scheduler/*.ts` (101 tests) continue to pass.
