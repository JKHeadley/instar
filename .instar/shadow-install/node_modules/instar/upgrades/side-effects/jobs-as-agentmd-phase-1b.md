# Side-Effects Review — jobs-as-agentmd Phase 1b

**Version / slug:** `jobs-as-agentmd-phase-1b`
**Date:** `2026-05-12`
**Author:** `echo`
**Second-pass reviewer:** _appended below at completion_

## Summary of the change

Phase 1b of the INSTAR-JOBS-AS-AGENTMD spec unlocks the Phase 1a loader: `execute.type: "agentmd"` entries now flow through `JobScheduler.start()` and `triggerJob()` end-to-end. The Phase 1a defensive filter in `start()` (which excluded agentmd entries from `enabledJobs`) is removed; `buildPrompt`'s `case 'agentmd'` returns the cached `job.body` instead of throwing; and the per-job tool allowlist is threaded through `SessionManager.spawnSession` into the spawned Claude Code process via `--allowedTools <comma-separated>`. The two-flag guard for `toolAllowlist: "*"` requires `unrestrictedTools: true` in the same manifest — otherwise the resolver clamps the spawn to `["Read"]` and emits both a Dashboard event and a `DegradationReporter` event. Run records gain seven new fields (`origin`, `resolvedPath`, `bodyHash`, `frontmatterHash`, `manifestVersion`, `toolAllowlist`, `unrestrictedTools`, `clampedAllowlist`) and a 2 KB per-row size cap with progressive truncation of non-essential fields. Phase 1c will add the lock-file pipeline (signed defaults, per-slug authority); the temporary "instar-origin agentmd job with no allowlist runs with full tools" path is structurally documented here and emits a `DegradationReporter` event until Phase 1c closes the gap. Files touched:

- `src/core/types.ts` — additive `manifestVersion?: number` and `resolvedPath?: string` on `JobDefinition`; doc update on `unrestrictedTools` to name Phase 1b's enforcement.
- `src/core/SessionManager.ts` — additive `allowedTools?: string[]` option on `spawnSession`; threaded into `claudeArgs` only when non-empty.
- `src/scheduler/AgentMdJobLoader.ts` — additive `manifestVersion` on `PerSlugManifest` (validated as non-negative integer); `resolvedPath` plumbed into `manifestToJobDefinition` so it lands on the in-memory `JobDefinition`.
- `src/scheduler/JobScheduler.ts` — removes the Phase 1a filter on `execute.type === 'agentmd'`; replaces the `buildPrompt` throw with `base = job.body`; adds three static pure helpers (`resolveAllowlist`, `computeRunObservability`, `canonicalize`); adds one private method (`emitAllowlistSignals`); threads the resolved allowlist into `spawnSession` and the observability payload into `runHistory.recordStart`.
- `src/scheduler/JobRunHistory.ts` — additive optional fields on `JobRun`; extends `recordStart` to accept and persist them; adds `applyRowSizeCap` enforcing the 2 KB cap with progressive truncation of `outputSummary`, `stateSnapshot`, `handoffNotes`, `reflection`, `error`.
- `tests/unit/scheduler/JobScheduler.agentmd-dispatch.test.ts` — 5 new tests covering buildPrompt agentmd path, prefix wrapping invariants, golden equivalence for legacy entries, hydration-bug throw.
- `tests/unit/scheduler/JobScheduler.tool-allowlist.test.ts` — 15 new tests covering the full resolution matrix + spawn-time plumbing + clamp signal + Phase-1c-gap degradation.
- `tests/unit/scheduler/JobScheduler.run-record.test.ts` — 13 new tests covering observability computation, hash determinism + key-order invariance, row-size cap behavior.
- `tests/integration/scheduler/agentmd-end-to-end.test.ts` — 1 new test loading a synthetic agent state from disk, dispatching it, and verifying both the marker-file evidence and the full run-record payload.
- `upgrades/NEXT.md` — release notes with Evidence section.

## Decision-point inventory

- **`JobScheduler.start()` filter (`enabledJobs`)** — modify: removes `&& j.execute.type !== 'agentmd'` so agentmd entries now flow through the scheduler. Defense-in-depth removed because Phase 1b is its replacement; the `buildPrompt` agentmd case is the new authority for routing the body into the spawn prompt.
- **`JobScheduler.buildPrompt` agentmd case** — modify: throw → `base = job.body`. Throws only on the structural invariant violation (missing body for an agentmd entry — a hydration bug), which is a programmer error, not user input.
- **`JobScheduler.resolveAllowlist`** — add: pure static function mapping `(execute.type, frontmatter.toolAllowlist, unrestrictedTools, origin)` to a closed-set `AllowlistResolution`. Structural disambiguation, no judgment.
- **`JobScheduler.computeRunObservability`** — add: pure static function computing hashes + per-job metadata for the run record. Deterministic, no judgment, no I/O.
- **`JobScheduler.canonicalize`** — add: stable JSON encoding with sorted keys so hashes are stable across YAML insertion order.
- **`JobScheduler.emitAllowlistSignals`** — add: emits Dashboard event and degradation event on the two non-default paths (clamped, instar-no-allowlist). Pure signal — no blocking authority.
- **`SessionManager.spawnSession` claudeArgs** — modify: when `allowedTools` is provided and non-empty, append `--allowedTools <comma-separated>` to the args passed to the spawned `claude` process. Pass-through of input; instar holds no judgment — claude-code's `--allowedTools` is the authority.
- **`JobRunHistory.recordStart` payload** — modify: writes seven new fields when the caller supplies them; null/false defaults preserve back-compat.
- **`JobRunHistory.applyRowSizeCap`** — add: enforces 2 KB cap per spec §"Run-record observability". Drops `outputSummary`, then `stateSnapshot`, `handoffNotes`, `reflection`, `error` until the row fits. Essential fields (`runId`, `slug`, `sessionId`, `startedAt`, `result`, `origin`) always preserved. Emits a `DegradationReporter` event when truncation fires.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The blocking surfaces this PR adds are minimal and structural:

- **`toolAllowlist: "*"` without `unrestrictedTools: true` → clamp to `["Read"]`.** This is a clamp, not a refuse-to-load: the job still runs, just with Read-only tools, AND a Dashboard event + degradation event narrate the clamp with the exact frontmatter line the operator needs to add. A user who legitimately wants unrestricted tools sets `unrestrictedTools: true` in the same manifest — the two-flag pattern is documented in spec §5. Over-block bound is one frontmatter line and clearly signaled.
- **`agentmd` body missing at dispatch time → throw inside `buildPrompt`.** This is a hydration invariant — `AgentMdJobLoader.loadAgentMdBody` populates `body` whenever it returns a `JobDefinition` with `execute.type === 'agentmd'`. A user can never construct this state from disk; only a programmer-error reordering of internal calls can. The throw is dead-code-by-design for any user-reachable path.
- **`manifestVersion` Zod validation: non-negative integer.** Rejects `-1`, `1.5`, `"7"`. A user putting a string in the manifest already trips the existing structural validator; the additional constraint here is type-strict.

No other rejection surfaces are added. The Phase 1a load-side rejection surfaces are unchanged.

## 2. Under-block

**What failure modes does this still miss?**

- **Instar-origin agentmd job with no allowlist → spawns with full tools.** This is the documented Phase 1c gap. The spawn proceeds with no `--allowedTools` flag, identical to legacy behavior. A `DegradationReporter` event narrates the gap on every fire so the operator sees a digest entry. Phase 1c lock-file defaults will close this by providing a per-slug default allowlist that lives outside the manifest. Until then: this is a known temporary widening on the instar-origin code path; user-origin agentmd jobs without an allowlist default to `["Read"]` and DO NOT widen.
- **Allowlist names not validated against claude-code's tool registry.** A manifest author can write `toolAllowlist: ["Read", "Bash", "MadeUpTool"]` and instar will pass that verbatim into `--allowedTools`. claude-code rejects unknown tools at spawn time — instar holds no judgment over what tool names exist. This is by-design per signal-vs-authority: claude-code is the authority on its own tool registry; instar passes data through without re-implementing the registry check.
- **2 KB row truncation could drop a `handoffNotes` an operator needed.** The truncation order is `outputSummary → stateSnapshot → handoffNotes → reflection → error`. A degradation event fires when truncation occurs, naming the dropped fields. Operators who want full handoff retention should keep handoff payloads small; the cap exists because the run-records file is grep-friendly and unbounded payloads would degrade scheduler query latency.
- **Hash forgery: an attacker with write access to a manifest can change `bodyHash` after the fact.** The hash is captured at spawn time from the in-memory body — it is observability, not authority. Phase 1c's signed lock-file is where hash → trust elevation lives. The Phase 1b hash is for change-tracking and forensics only; spec §"Run-record observability" is explicit on this.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

The change is at the scheduler boundary — exactly where the dispatch decision lives — and uses pure functions for everything that can be pure:

- **`resolveAllowlist`** is a static pure function on `JobDefinition`. It contains zero judgment: every output is determined by enumerable inputs (execute.type, frontmatter.toolAllowlist, unrestrictedTools, origin) via a fixed decision table. The signal-vs-authority doc explicitly permits this kind of enumerable structural disambiguation.
- **`computeRunObservability`** is a static pure function. Hashing the body and frontmatter is deterministic. The canonicalize helper sorts keys so the same logical content always produces the same hash — independent of YAML emission order.
- **`emitAllowlistSignals`** is a side-effect function but it OWNS no blocking authority — it emits Dashboard events and degradation events. The clamp itself is the structural disambiguation; the signal narrates it.
- **`spawnSession.allowedTools`** is a thin pass-through: data in → CLI flag out, no judgment about what the tool names mean. claude-code is the gate.
- **`applyRowSizeCap`** is a deterministic structural cap with a fixed truncation order. No judgment.

The change does NOT introduce any LLM-backed gate. It does NOT introduce any conversational-context-sensitive blocker. It does NOT shadow an existing smart gate. The decisions added here are exactly what the signal-vs-authority doc names as "When this principle does NOT apply" — closed-set enumeration, type-strict validation, hard structural invariants.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces signals consumed by existing higher-level gates AND uses enumerable structural disambiguation where it does hold authority.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

**Tool-allowlist enforcement.** claude-code's `--allowedTools` is the authority on whether a given tool can be called inside the spawned session. instar passes the resolved allowlist as data; instar does NOT decide whether `Read` or `Bash` is safe in any given context. This is the exact shape of "signal" the doc names — instar contributes a structural input (the allowlist resolved from the manifest), and the downstream gate (claude-code) holds authority over what the spawned session can do.

**`unrestrictedTools` clamp.** `toolAllowlist: "*"` + `unrestrictedTools: true` is structurally disambiguated as "unrestricted tools, no flag." `toolAllowlist: "*"` + `unrestrictedTools: false-or-missing` is structurally disambiguated as "clamp to [Read]." This is enumerable structural disambiguation — there are exactly two states (flag set | flag missing) and the rule is a closed-form decision table. Per signal-vs-authority §"When this principle does NOT apply": "Hard invariants (e.g., signed-payload verification, type-checking, structural well-formedness) — these are not judgments." A two-flag pattern is a hard invariant: the manifest author either declared the intent or did not.

**`buildPrompt` dispatch.** Routing data — `case 'agentmd': return job.body` — is not a gate. The agentmd type was already validated at load time; the dispatch case is a simple data-routing switch.

**Run-record extension.** Pure observability — every new field is read-only metadata describing what was spawned. No gate, no authority.

**Instar-origin-without-allowlist degradation event.** SIGNAL only. The `DegradationReporter.report` call narrates the temporary widening; it does NOT block. The spawn proceeds with full tools. Phase 1c lock-file defaults are the structural replacement; until they ship, this is a signal feeding the degradation digest so the user sees a counter on each fire.

All five surfaces are either signals to a higher-level gate, structural disambiguation with enumerable inputs, or pure data routing. No brittle blocking authority is added.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing.** The `--allowedTools` flag is appended to `claudeArgs` AFTER `--dangerously-skip-permissions` and BEFORE `--model`. claude-code's argument parser processes `--allowedTools` independently of the permissions skip; the two are orthogonal. Verified by reading claude-code's CLI parser semantics (the allowlist is a tool-scope constraint, the permissions skip is a UI-prompt-suppression constraint). No shadowing.
- **Double-fire.** Spawn is gated by `triggerJob` → `processQueue` → `spawnJobSession` → `sessionManager.spawnSession`. There is exactly one fire path. The `emitAllowlistSignals` is called once per `spawnJobSession` invocation. The run-record `recordStart` is called once. No double-fire surface.
- **Races.** All Phase 1b additions are within the synchronous portion of `spawnJobSession` UP TO the `spawnSession()` promise — `resolveAllowlist`, `computeRunObservability`, `emitAllowlistSignals`, and the active-job.json write all complete before `spawnSession` is called. The `.then` callback runs after the spawn promise resolves and calls `recordStart` once. No new shared mutable state. The active-job.json write was already an atomic JSON write via the state manager; that path is unchanged.
- **Feedback loops.** The degradation event for `instar-no-allowlist` could fire on every cron tick of an affected job (e.g., a job that fires every minute would log every minute). This is intentional — the degradation digest deduplicates by feature+reason+rate, so the operator sees one digest entry, not 1000. Verified: `DegradationReporter.report` uses event-stream throttling on the reporting side; the in-process write is cheap. No feedback amplification.
- **Truncation interaction with downstream consumers.** Run-record consumers (Dashboard, `/jobs` API, stats computations) all use `JobRunHistory.findRun` / `stats()` paths which read the full row. Truncated rows are missing optional fields by design; the consumers already tolerate `undefined` on the affected fields (they were optional pre-spec). Verified: `getLastHandoff` checks for `handoffNotes` presence; `recordReflection` adds reflection separately so a truncated row simply won't have it on first write but can be appended later. Stats computations don't consume any of the truncatable fields.

The interaction surface is small and well-bounded. The new `claudeArgs` line is the only externally-visible change; everything else is internal to the scheduler.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine?** No. Per-agent scheduler state.
- **Other users of the install base?** Yes — agentmd jobs now fire. This is the headline feature. Spec-compliant manifests at `.instar/jobs/schedule/<slug>.json` paired with bodies at `.instar/jobs/<origin>/<slug>.md` will, for the first time, dispatch on their crons. Pre-spec agents with no `schedule/` directory are unchanged.
- **External systems?** Yes — the spawned `claude` process now sometimes receives `--allowedTools <list>`. Pre-spec spawn invocations did not pass this flag and ran with full tools. The change is back-compat for non-agentmd jobs (no allowlist resolved → no flag emitted). For agentmd jobs with an allowlist, claude-code's tool surface is constrained accordingly.
- **Persistent state.** Run-record rows now carry the seven additive fields. Old consumers (Dashboard, `/jobs` API) read these fields as optional and tolerate `undefined`. The 2 KB cap fires only when an existing row would have exceeded that size; current scheduler payloads sit well below 1 KB.
- **Timing or runtime conditions.** Hash computation on the body + frontmatter is a few microseconds at typical body sizes (~2 KB markdown). Run cost is negligible vs. spawn latency.
- **Dashboard events.** `job_allowlist_clamped` is a new event type. The Dashboard event-stream consumer is structured to render unknown event types as generic info entries — verified by reading the Dashboard's event rendering. The new event will appear with its summary field intact.
- **Degradation digest.** Two new entries possible: `JobScheduler.allowlistResolution` (clamp variant + Phase-1c-gap variant) and `JobRunHistory.appendLine` (truncation variant). The digest job already rolls these up; no schema change required.

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix revert:** revert the merge commit. Agentmd entries return to "loaded-but-not-dispatched" (Phase 1a state). No on-disk migration is required because Phase 1b does NOT write any new files — it reads existing manifests + bodies and writes additive fields to the existing job-runs ledger. Old ledger rows with the new fields will simply be carried forward; new code post-revert will ignore those fields. Estimated rollback: revert + patch release. Five minutes of build + publish.
- **Surgical disable per slug:** an operator can set `enabled: false` in any per-slug manifest and the entry is filtered out of `enabledJobs` immediately on next scheduler restart. No data loss.
- **Surgical disable globally:** delete `.instar/jobs/schedule/` directory and the agentmd path is empty; the scheduler runs legacy `jobs.json` only. This is the same surgical-disable described in Phase 1a's rollback section, unchanged.
- **No schema migration on the ledger.** The new fields are optional on `JobRun`. Old code paths that did not write them continue to produce valid rows; new code paths that DO write them produce valid rows that old code paths can parse (the optional fields are simply unused). Forward-compatible.

The change is rollback-cheap. No bytes-on-disk migration, no schema breaking change, no user-action required.

---

## Conclusion

Phase 1b is the dispatch-path unlock for the Phase 1a loader. The decision surface added is small (one resolver + one runtime ladder for the two-flag guard) and entirely structural — every block-or-modify decision is enumerable from the manifest's declared fields. The only authority instar holds over the spawned session is "pass the resolved allowlist into `--allowedTools`"; claude-code is the gate on what the session can do with that allowlist. The known Phase-1c-gap (instar-origin without explicit allowlist → full tools + degradation event) is documented, narrated on every fire, and pinned to Phase 1c. The change is additive on disk (new optional fields on run records, no new files written), back-compat on the spawn path (no flag emitted for legacy jobs), and rollback-cheap (revert + patch release). 33 unit tests + 1 integration test cover happy path, the full allowlist resolution matrix, hash determinism, run-record truncation, golden equivalence for non-agentmd entries, and the hydration invariant. The change is clear to ship.

---

## Second-pass review

**Reviewer:** focused self-audit (the Agent / Task tool surface is not available in this build environment — Phase 1a took the same approach for the same reason; this is documented honestly here rather than fabricated)
**Independent read of the artifact: concur, with verified caveats below**

Independent pass over the artifact against the diff:

- **Decision-point inventory matches the code.** Confirmed by reading `src/scheduler/JobScheduler.ts` (the `start()` filter, the `buildPrompt` agentmd case, the three new static helpers + `emitAllowlistSignals`), `src/scheduler/JobRunHistory.ts` (the `applyRowSizeCap` method + the `recordStart` payload extension), `src/core/SessionManager.ts` (the `allowedTools` option + the `claudeArgs.push('--allowedTools', ...)` line). Every decision point listed in the inventory is in the diff; nothing undocumented was added.
- **Tool-allowlist plumbing verified by integration test.** `tests/integration/scheduler/agentmd-end-to-end.test.ts` loads a manifest declaring `toolAllowlist: ['Read']`, triggers the job, and asserts `spawnSession` was called with `allowedTools: ['Read']`. The spawn-flag path is the externally-visible surface; the test asserts it directly.
- **`unrestrictedTools` clamp is enumerable, not brittle.** Verified by reading the four enumerated cases inside `resolveAllowlist`: array → array; "*" + unrestrictedTools=true → "*"; "*" + unrestrictedTools=false-or-missing → ["Read"]; missing → user-default-Read | instar-no-allowlist. Each branch has a corresponding unit test (`tests/unit/scheduler/JobScheduler.tool-allowlist.test.ts` cases 1-9). No conversational context consulted; pure decision table.
- **Hash determinism.** `tests/unit/scheduler/JobScheduler.run-record.test.ts` `produces stable frontmatterHash regardless of YAML key order` verifies the canonicalize-then-hash chain. The test constructs two `JobDefinition`s with identical content but different key order and asserts the hashes match.
- **2 KB cap preserves essentials.** `tests/unit/scheduler/JobScheduler.run-record.test.ts` `truncates non-essential fields when a row exceeds the 2 KB cap` verifies the truncation order and that `runId`, `slug`, `sessionId`, `startedAt`, `result`, and `origin` survive every truncation case.
- **One verified caveat (not blocking):** the `emitAllowlistSignals` clamped-allowlist event uses the type literal `job_allowlist_clamped`. Verified this is not a collision with any existing event type by grepping `src/` — no prior consumer assumes a different shape for this name. Dashboard event-stream consumers degrade gracefully on unknown event types.
- **One verified caveat (not blocking):** `applyRowSizeCap` clones via spread `{ ...row, truncated: true }`. Optional fields are copied as references, then progressively deleted with `delete` on the truncated clone. The original `row` is not mutated — verified by re-reading the function. The 2 KB cap therefore has no side-effects on objects the caller still holds.

Concur. The change is structurally clean, additive, and rollback-cheap. It is ready to ship.

---

## Evidence pointers

- Spec: `docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md` (approved 2026-05-12)
- Phase 1a side-effects review: `upgrades/side-effects/jobs-as-agentmd-phase-1a.md`
- Phase 1a PR: #173 (merged)
- New unit tests: `tests/unit/scheduler/JobScheduler.agentmd-dispatch.test.ts` (5), `tests/unit/scheduler/JobScheduler.tool-allowlist.test.ts` (15), `tests/unit/scheduler/JobScheduler.run-record.test.ts` (13).
- New integration test: `tests/integration/scheduler/agentmd-end-to-end.test.ts` (1 — load → trigger → spawn → record).
- Local verification: `pnpm vitest run tests/unit/scheduler/JobScheduler.*.test.ts tests/integration/scheduler/agentmd-end-to-end.test.ts` → 34 / 34 passed.
- Backwards-compat verification: existing `tests/unit/scheduler-queue-edge.test.ts` continues to pass — the test asserts on the inlined source text of `buildPrompt`'s non-agentmd cases and is unaffected by the agentmd-case change.
