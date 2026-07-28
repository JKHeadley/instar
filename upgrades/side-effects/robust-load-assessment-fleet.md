# Side-Effects Review — Robust Load Assessment (fleet-wide + compaction-surviving)

**Version / slug:** `robust-load-assessment-fleet`
**Date:** 2026-06-19
**Author:** echo
**Second-pass reviewer:** echo-spawned reviewer subagent (required — touches compaction)

## Summary of the change

Ships a read-only machine-load diagnostic (`load-assess.sh`) to every agent as a script template, wires a static "use load-assess.sh / never trust the uptime load average" awareness block into the in-code session-start hook ABOVE its compact-`exec` delegate (so it survives compaction), and adds an Agent-Awareness CLAUDE.md section (generate + migrate). Born from a 2026-06-19 incident where the agent misread the spike-prone, Spotlight-I/O-inflated 1-minute load average as "heavy load" while the CPU was ~60% idle. Three source files + two test files; 14 new tests, 568 existing PostUpdateMigrator/scaffold tests still green.

## Decision-point inventory

- `load-assess.sh` verdict (OK/ELEVATED/SATURATED) — **add** — produces a SIGNAL (a load verdict printed to stdout); holds **zero** blocking authority. Nothing consumes it as a gate.
- session-start hook output — **modify** (additive) — adds a static doc block; no conditional logic, no decision.
- `migrateScripts` / `migrateClaudeMd` — **add** (install + append) — idempotent, content-sniffed; no decision surface.

---

## 1. Over-block
No block/allow surface — over-block not applicable. The script reads CPU/ledger and prints; the hook emits a static string. Nothing is rejected or gated.

## 2. Under-block
No block/allow surface — under-block not applicable. The change adds no enforcement, so there is no failure mode to "miss." (The script's verdict is advisory: a human/agent reading "OK" still makes the call. Scope honesty is built in — the verdict explicitly states it is CPU-capacity only, not a universal health oracle, so a reader does not over-trust an OK on a memory/thermal-pressured box.)

## 3. Level-of-abstraction fit
Right layer. A diagnostic script lives in `.instar/scripts/` alongside `secret-get.mjs`/`emit-session-clock.sh` (the established sibling pattern); the awareness lives in the session-start hook (the existing always-fires-on-lifecycle surface) and the CLAUDE.md template (the canonical agent-awareness surface). No smarter gate should own this — there is no gate; it is read-only observability feeding the agent's own judgment. The time-windowed signal it surfaces (ResourceLedger) is consumed, not duplicated.

## 4. Signal vs authority compliance
Compliant (`docs/signal-vs-authority.md`). `load-assess.sh` is a pure **detector/signal** — it computes a load verdict and prints it, with no power to block, delay, or rewrite anything. It does not add brittle logic with blocking authority; it adds a read-only signal a smart authority (the agent) consumes. The hook block and CLAUDE.md section are documentation, not decision points.

## 5. Interactions
- The hook block is placed ABOVE the `exec compaction-recovery.sh` branch so it is emitted on every event (startup/resume/clear/compact); it does not shadow or get shadowed by the recovery delegation (verified by a test asserting `blockIdx < execIdx`). It adds a few lines of static stdout to a hook that already emits many — no latency (no network), and the block precedes no `exit N` (the hook ends on an `echo`, which exits 0), so it cannot change the exit code. (Compaction-survival rests on bash builtin `echo` writing directly to fd 1 with no userspace stdio buffer for the subsequent `exec` to discard — verified empirically by the second-pass reviewer across tty/pipe/file-redirect.)
- `migrateScripts` adds a sibling install next to `secret-get.mjs`; independent try/catch, cannot affect the other script installs.
- `migrateClaudeMd` appends a content-sniffed section (`!includes('Machine Load Assessment')`) — idempotent, does not duplicate on re-run (tested), does not edit other sections in place.
- The CLAUDE.md section text is single-sourced (`MACHINE_LOAD_ASSESSMENT_CLAUDEMD_SECTION()`) and used by BOTH generate (new agents) and migrate (existing) — they cannot drift (tested).

## 6. External surfaces
- The script reads the existing `GET /resources/summary` endpoint (read-only; no new surface) and degrades to local-only if it is unreachable (fail-soft, tested). No new external API.
- `--json` is documented human-diagnostic-only and unversioned — no system consumes it; a future programmatic consumer must add a `schemaVersion` first (stated in the script + spec).
- The hook output is agent-internal stdout, not visible to other agents/users/systems.
- No timing/conversation-state dependence: the script samples CPU on demand; the hook block is static. A test-only `LOAD_ASSESS_FORCE_IDLE` env seam exists (read-only, affects only the printed verdict for boundary testing; never set in production).

## 7. Multi-machine posture (Cross-Machine Coherence)
- `load-assess.sh` — **machine-local BY DESIGN**: load is a property of the machine the script runs on; there is nothing to replicate. Cross-machine load reads are already served separately by `/guards?scope=pool` and `/resources/summary`.
- The hook block and CLAUDE.md section — **machine-local static template content**, installed identically on every machine by each machine's own migration; no replication needed, no strand-on-transfer risk (no durable per-topic state), no generated URLs.

## 8. Rollback cost
Low. Revert the PR (3 source files). The change is additive and idempotent: reverting stops shipping the script template + hook block + CLAUDE.md section to future migrations. Agents that already migrated keep a harmless read-only `load-assess.sh` on disk (no cleanup required; it gates nothing). No data migration, no agent-state repair. A hot-fix release is sufficient if needed.

---

## Second-pass review (required — touches compaction)

**Reviewer:** echo-spawned independent reviewer subagent. **Verdict: Concur with the review.**

The reviewer independently audited the 4 additive blocks, ran the 14 tests, AND ran live simulations rather than trusting the framing:
1. **Compaction-survival — TRUE (verified by execution):** simulated the hook with stdout to a tty, a pipe, and a file redirect with the compact `exec` actually firing — the MACHINE LOAD block appeared before the delegate's output in every case. Robust because bash builtin `echo` writes via `write(2)` directly to fd 1 (no userspace stdio buffer for `exec` to discard); bytes are in the kernel before `exec` runs. The non-executable-recovery fallback also behaves correctly (exec skipped, block still emitted, hook continues).
2. **Timeout/exit code — no risk:** static echoes, zero network; precedes no `exit N`.
3. **Script safety — sound:** `set -uo pipefail` with NO `set -e`; ran under stripped env / empty-IDLE / faked unknown-OS — all exit 0 with a clean verdict (UNKNOWN + null JSON on genuine no-CPU-read, never a crash). All `set -u`-sensitive vars assigned before use; verdict chain exhaustive (VERDICT+REASON on every branch); `bash -n` clean.
4. **Test `blockIdx < execIdx`** pins the real property; combined with both-boundary script tests + the empirically-confirmed flush-survives-exec behavior, the guarantee is covered.
5. **Packaging — sound:** `loadRelayTemplate('load-assess.sh')` resolves via `src/templates/scripts/`, which IS in package.json `files` (ships to npm) — the same proven mechanism as `secret-get.mjs`. Content-sniff anchor `'Machine Load Assessment'` is unique (no cross-section collision); idempotency confirmed count==1 after repeated runs.

No concerns raised.

---

## CI-conformance follow-up (post-open, #1231)

CI shard 4/4 surfaced two required-conformance gaps (caught by the full suite, not my local subset run):
- `load-assess.sh`'s localhost API call to `/resources/summary` lacked the `X-Instar-AgentId` header that `template-agent-id-header.test.ts` requires of every Bearer call in a template. Added (AGENT_ID derived from `INSTAR_AGENT_ID`/config.json projectName, same as session-start.sh). No behavior change — the header is identification only; the call already fail-softs.
- The `Machine Load Assessment` migrateClaudeMd section was not registered in `feature-delivery-completeness.test.ts`'s `legacyMigratorSections` tracking list. Added (observe-only, ships ON, no framework-shadow marker → legacy migrator list, not featureSections). No runtime change — a test-registry entry.

Both are conformance fixes to the same change; the design + second-pass review above stand unchanged.
