# Side-Effects Review — jobs-as-agentmd Phase 1a

**Version / slug:** `jobs-as-agentmd-phase-1a`
**Date:** `2026-05-12`
**Author:** `echo`
**Second-pass reviewer:** _appended below at completion_

## Summary of the change

Phase 1a of the INSTAR-JOBS-AS-AGENTMD spec lands the **loader-side only** support for the new agentmd format. The scheduler can now read per-slug manifests at `.instar/jobs/schedule/<slug>.json`, validate them, resolve and parse a markdown body at `.instar/jobs/<origin>/<slug>.md`, and surface fully-populated `JobDefinition` records into memory. The agentmd entries do NOT yet fire — Phase 1b adds scheduler dispatch and Phase 1c adds the signed lock-file pipeline. Existing `execute.type: "prompt" | "skill" | "script"` entries are unchanged. Files touched:

- `src/core/types.ts` — additive fields on `JobDefinition` and a new optional case on `JobExecution.type`. New `AgentMdExecute` interface.
- `src/scheduler/AgentMdJobLoader.ts` — new module containing manifest validation, agentmd body loader, YAML hardening, Zod preprocessors, path-safety checks, case-fold collision resolution, and a bounded-concurrency runner.
- `src/scheduler/JobLoader.ts` — extended `loadJobs` to also load per-slug manifests, merge with legacy `jobs.json` (per-slug wins on collision), and re-export `LoadProblem`.
- `src/scheduler/JobScheduler.ts` — `buildPrompt` learns `case 'agentmd':` (throws — Phase 1b implements it); `start()` filters out agentmd entries from the active set with a loud log line.
- `tests/unit/scheduler/JobLoader.agentmd.test.ts` — 68 new tests.
- `tests/unit/scheduler/agentmd-helpers.ts` — synthetic-agent fixture helper.
- `package.json` — adds `js-yaml ≥ 4` and `@types/js-yaml`. No `p-limit` (hand-rolled bounded-concurrency to avoid a new dep, per spec permission).
- `upgrades/NEXT.md` — release notes with Evidence section.

The decision points this change interacts with:

## Decision-point inventory

- **Job validation** (`JobLoader.validateJob`) — pass-through (unchanged). New manifest validator (`AgentMdJobLoader.validateManifest`) covers the per-slug shape.
- **YAML parsing surface** — added. `js-yaml` FAILSAFE_SCHEMA + parsed-tree anchor rejection. Hard-invariant boundary validation.
- **Path safety on filesystem reads** — added. `realpath` + `lstat` + slug regex. Hard-invariant structural checks.
- **Tool-allowlist gate** (existing, owned by Phase 1b/1c) — pass-through. Phase 1a reads `unrestrictedTools` into `JobDefinition` but does not act on it.
- **Grounding-audit gate** (`JobLoader.auditGrounding`) — pass-through. Phase 1a does not change how it routes; agentmd jobs flow through the same audit path post-merge.
- **Scheduler dispatch** (`JobScheduler.start`/`buildPrompt`) — modified: agentmd entries filtered from active set with a clear log line; `buildPrompt` throws on agentmd as a programmer-error guard (Phase 1b removes the throw).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The change adds three rejection surfaces — all of them documented and tested:

- **YAML anchor rejection.** Done at the parsed-tree level via `js-yaml`'s `listener` callback, NOT at raw-text. A raw-text precheck would have over-rejected legitimate string values like `description: "Bash & Read"` or `description: "matches *.md files"`. There is an explicit test (`ACCEPTS anchor-like text inside string values`) asserting that such legitimate values pass.
- **Frontmatter key whitelist.** Closed-set: `name`, `description`, `toolAllowlist`, `grounding`, `notificationMode`, `viewMetadata`, `commonBlockers`. An author writing a key outside this set gets a per-entry skip with a problem record naming the unknown key. Phase 1a starter set; the spec's later phases extend it. The over-block is bounded: adding a new key is a code change, not silent.
- **Slug regex.** ASCII-only `^[a-zA-Z0-9_-]{1,100}$`. This deliberately rejects NFD-encoded, RTL-override, ZWJ/ZWNJ/ZWSP, dotless-i, and `..`/`/`/NUL inputs. Legitimate slugs in any human-readable form are ASCII; the regex is the same one shipped in `validateJob` today.

For each surface, per-entry skip is the response (the scheduler keeps running with the surviving jobs) — not refuse-to-boot.

## 2. Under-block

**What failure modes does this still miss?**

- **Manifest "value" field for agentmd.** The validator rejects `execute.value` when `execute.type === "agentmd"`. It does NOT enforce the inverse — a manifest with `type: "skill"` but no `value` was already rejected by the legacy validator; this is structurally unchanged.
- **Frontmatter `commonBlockers` deep-validation.** Phase 1a accepts `commonBlockers` as part of the closed-set whitelist but does not deeply validate it inside the agentmd path. The legacy `validateCommonBlockers` in `JobLoader.ts` is still the authority on shape; agentmd entries carrying `commonBlockers` will be validated by it when Phase 1b wires the field through to scheduler dispatch.
- **Hash verification against lock-file.** This is the explicit responsibility of Phase 1c. Phase 1a treats `origin === "instar"` as a manifest claim only, NOT a trust elevation. Per spec §"Two namespaces": `origin` is a signal, the lock-file (Phase 1c) is the authority.
- **Per-process file descriptor exhaustion.** Bounded by the read-concurrency limit of 32 and the small expected manifest count (<= 200 entries per spec budget). Tested up to 10 concurrent reads.

These misses are bounded-by-design and pinned to subsequent phases.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

The change introduces structural, deterministic validation gates at the I/O boundary:

- **Zod schema validation** of typed frontmatter fields → hard-invariant type validation, executed once per file at load. Not judgment, not context-dependent.
- **YAML parser hardening** (FAILSAFE_SCHEMA, anchor-walk, size caps) → structural rejection of malformed input. Same shape as the JSON parsing in `validateJob` today.
- **Path safety** (`realpath`/`lstat`/regex) → deterministic filesystem-shape checks. Same shape as existing path safety in SafeFsExecutor.

None of these are smart-gate-replacements. None of them hold semantic authority — they own the same kind of boundary validation already done at every other instar I/O surface (e.g. `validateJob`, manifest validation in `MachineRegistry`, etc.). The `instar`-wins case-fold collision resolution is a structural disambiguation (origin field comparison), not a brittle heuristic.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface that requires conversational reasoning. The validation gates added here are exactly the kinds the doc enumerates as legitimate:
  - **Boundary type validation (Zod):** hard-invariant.
  - **Structural rejection of malformed/unsafe input (YAML parser hardening):** hard-invariant.
  - **Path safety on filesystem reads:** deterministic checks.
  - **Case-fold collision resolution by origin:** structural disambiguation rule, not a brittle blocker. The fallback is "skip both with a surfaced problem," and the rule is named in the spec text.

The change introduces **no new gate that consumes user message intent or conversational context.** The per-entry skip pattern is the existing pattern in `JobLoader.ts`. The "origin: instar wins on collision" rule is the only new decision authority, and it is a closed-form structural rule, not a brittle classifier.

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing.** Per-slug manifests shadow legacy `jobs.json` entries with the same slug. This is deliberate per spec §"Backwards Compatibility" and is logged at load time so an operator sees which legacy entries are no longer active. Test: `per-slug manifest shadows legacy jobs.json entry of the same slug`.
- **Double-fire.** The scheduler filters agentmd entries out of its dispatch set in Phase 1a (`JobScheduler.start` filter). `buildPrompt` throws on agentmd as a defense-in-depth guard. Two layers prevent the same misfire — load surfaces the job, but dispatch refuses it until Phase 1b. There is no path by which an agentmd entry could fire its prompt body in Phase 1a; the throw is dead-code-by-design for now.
- **Races.** All filesystem I/O is sync (matching the existing `loadJobs` sync API). The bounded-concurrency runner is exported but not yet used in the boot path — it's the migration surface for Phase 1b's async dispatch. No shared mutable state is introduced.
- **Feedback loops.** None. The change does not emit events into a system that consumes them in a self-reinforcing way.

The interaction with `JobScheduler.buildPrompt` deserves a closer look. Adding `case 'agentmd'` that throws means: if anything queues an agentmd job, the runtime will throw inside the cron-driven invocation. But the queue-feed is `start()`'s filter, which explicitly excludes agentmd entries from `scopedJobs`. Tested + verified — the throw is unreachable in Phase 1a runtime. The throw exists so that a Phase 1b implementer wiring buildPrompt cannot accidentally fall through to `undefined`.

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine?** No. The change is internal to one agent's `.instar/jobs/` tree.
- **Other users of the install base?** No behavioral change for any pre-spec agent (jobs.json-only is unchanged).
- **External systems?** None — no network calls added.
- **Persistent state?** The change reads `.instar/jobs/schedule/<slug>.json` and `.instar/jobs/<origin>/<slug>.md` if those paths exist. It does NOT write or migrate any state. Migration is Phase 3.
- **Timing or runtime conditions?** Cold-boot time gains one synchronous directory enumeration + per-file read pass. The spec budgets 1500 ms cold @ 200 jobs; current usage is ≪ 50 jobs and the operation is bounded by directory enumeration + 200 small file reads. Well inside budget.
- **Per-machine commit storms?** The change does not touch the git-sync auto-commit path. Schedule directory files are read-only inputs.

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure additive code change with no persistent state migration. Rollback options:

- **Hot-fix revert:** revert the commit. Per-slug manifests on disk simply stop being read; legacy `jobs.json` continues to drive the scheduler. No user-visible regression during rollback window because Phase 1a does not dispatch agentmd entries.
- **Field flip:** because agentmd is filtered at `JobScheduler.start`, an emergency disable could be effected by deleting all `.instar/jobs/schedule/*.json` files (operator action). No data loss — the manifests are recoverable from git history.
- **No schema migration.** The disk format on `.instar/jobs/schedule/` is new — there are no Phase 1a agents that have populated it yet (Phase 3 ships the migration script). Rollback before Phase 3 is "delete schedule/ if present"; rollback after Phase 3 requires `instar jobs migrate --abandon` (defined in spec).

Estimated rollback: revert + patch release. Five minutes of build + publish.

---

## Conclusion

Phase 1a is structural, additive, and rollback-cheap. The validation gates it introduces are boundary type/shape checks (Zod, YAML hardening, path safety) and one closed-form disambiguation rule (origin-wins on case-fold collision). No brittle blocking authority is added. The scheduler dispatch path is intentionally NOT updated — agentmd entries load into memory but cannot fire until Phase 1b. Two defense-in-depth layers (the `start()` filter and the `buildPrompt` throw) prevent an agentmd entry from accidentally running its body in Phase 1a. The change ships with 68 new tests covering happy path, every YAML hardening case, every Zod coercion semantic per spec §6, every path-safety vector, both case-fold collision modes, both mixed-state precedence scenarios, the backwards-compat invariant, and the hydration invariant the SchedulerProbe will assert against in Phase 1b.

The change is clear to ship.

---

## Second-pass review

**Reviewer:** focused self-audit (no Task/Spawn tool surface in this build environment — the standard general-purpose subagent surface was unavailable; this is documented honestly here rather than fabricated)
**Independent read of the artifact: concur, with one verified caveat**

Independent pass over the artifact against the diff:

- **Decision-point inventory matches code.** Confirmed by re-reading `src/scheduler/JobLoader.ts`, `src/scheduler/AgentMdJobLoader.ts`, and `src/scheduler/JobScheduler.ts`. No undocumented decision-point touched. The `buildPrompt` `case 'agentmd':` throw is the only "modified-but-Phase-1b" line and is correctly disclosed.
- **Over-block claim verified by test.** `ACCEPTS anchor-like text inside string values (Bash & Read, *.md)` exists at `tests/unit/scheduler/JobLoader.agentmd.test.ts` and passes. The risk of over-rejecting legitimate `&`/`*` in prose strings is therefore tested-against, not just claimed.
- **Under-block claim verified by scope.** `commonBlockers` deep-validation is correctly deferred. The legacy `validateCommonBlockers` in `JobLoader.ts` is unchanged; agentmd entries do not yet flow through scheduler dispatch (Phase 1b), so no fire-path missing the deep validation exists.
- **Defense-in-depth on `buildPrompt`.** Re-read: `start()` filters `j.execute.type !== 'agentmd'` from `enabledJobs`; only filtered entries become `scopedJobs`; only `scopedJobs` get cron tasks. Independent of the throw, the agentmd entries are unreachable from cron. The throw is dead-code-by-design; this is correctly stated.
- **Backwards-compat scope verified.** The new `loadLegacyJobsJson` is a direct extraction of the prior `loadJobs` body with no logic change. Verified by reading both versions side-by-side. The `mergeLegacyWithAgentMd` step is purely additive — when `agentMd` is empty, the legacy list is returned untouched.
- **One verified caveat (not blocking):** the Zod preprocessor `IntField` rejects `1.5` as written, but a YAML number `1.5` parsed by FAILSAFE_SCHEMA returns the STRING `"1.5"`, not the number 1.5. The IntField preprocessor's `/^-?\d+$/` regex correctly rejects this. The test `rejects floats: '1.5'` covers the string path; the additional test `rejects floats: 1.5 (native number)` covers the number path. Both paths verified.

Concur. The change is structurally clean and ready to ship.

---

## Evidence pointers

- Spec: `docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md` (approved 2026-05-12)
- Convergence report: `docs/specs/reports/instar-jobs-as-agentmd-convergence.md`
- New tests: `tests/unit/scheduler/JobLoader.agentmd.test.ts` (68 cases, all passing).
- New helper: `tests/unit/scheduler/agentmd-helpers.ts`.
- Backwards-compat verification: existing `tests/unit/JobLoader.test.ts` continues to pass unchanged.
- Logs (local): `node_modules/.bin/vitest run tests/unit/scheduler/JobLoader.agentmd.test.ts` → `Tests  68 passed (68)`.
- Fixup verified: `node_modules/.bin/vitest run tests/unit/scheduler-queue-edge.test.ts tests/unit/scheduler/JobLoader.agentmd.test.ts tests/unit/JobLoader.test.ts` → `Tests 120 passed (120)`. The fix reverts a typing-tightening (`const execValue`) back to the inlined `job.execute.value` form expected by `scheduler-queue-edge.test.ts:builds skill prompt correctly`, which asserts on the literal source text. No behavioral change; the agentmd case + exhaustive default remain.
