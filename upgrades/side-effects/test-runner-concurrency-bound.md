# Side-Effects Review — Test-Runner Concurrency Bound (host-wide vitest semaphore)

**Version / slug:** `test-runner-concurrency-bound`
**Date:** `2026-07-03`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `required (concurrency gate touching git-push and /build paths) — see below`

## Summary of the change

Adds a host-wide, per-machine concurrency bound on vitest test runs — the structural fix for the 2026-06-19/2026-07-02 meltdowns where ~29 concurrent test suites (agent builds + husky pre-push + build gates) starved the event loop and made health watchdogs kill healthy servers. A parameterized semaphore core is extracted from the proven `hostSpawnSemaphore` (`src/core/hostSemaphoreCore.ts`); a new test lane (`src/core/hostTestRunnerSemaphore.ts`) implements two symmetric slot lanes (suite cap 1 — operator-ratified — and targeted cap 6 for ≤5-file inner-loop runs), a capacity-only ReclaimPolicy (TTL frees slots, never signals by default), a durable event ledger, and a host-uniform tuning file. The chokepoint is a vitest `globalSetup` + config-eval seam (`tests/setup/test-runner-semaphore.globalSetup.ts`, `tests/setup/test-runner-bound.config-eval.ts`) wired into all five vitest configs. **Ship posture is dry-run (watch-only): full bookkeeping, zero enforcement — a run that would block logs `would-block` and admits.** Enforcement exists only behind a deliberate tuning-file flip after a 14-day soak. Server-side: `GET /test-runner-limiter` (pure read) + `POST /test-runner-limiter/prune` (recovery lever), CapabilityIndex entry, `intelligence.testRunnerCap` config knob (route report only — NOT a chokepoint lever), CLAUDE.md awareness via templates + PostUpdateMigrator. Serverless-host surfacing: loud stderr WARNs at the chokepoint + WARN-only ledger-pattern checks in `dev:preflight`/pre-push.

Spec: `docs/specs/test-runner-concurrency-bound.md` (review-convergence round 10, operator-approved 2026-07-03). ELI16: `docs/specs/test-runner-concurrency-bound.eli16.md`.

## Decision-point inventory

- `tests/setup/test-runner-semaphore.globalSetup.ts` (chokepoint admit/wait/skip) — **add** — decides admit-now / wait / (enforcing-only) typed capacity refusal for every vitest root on the host.
- `tests/setup/test-runner-bound.config-eval.ts` (lane classification + clamps) — **add** — classifies targeted vs suite; applies worker-pool clamps ONLY when clamp-active/enforcing; dry-run ledgers `would-clamp` and reshapes nothing.
- `src/core/hostTestRunnerSemaphore.ts` ReclaimPolicy — **add** — frees slots (capacity direction); the opt-in `TTL_SIGNAL` arm (off by default, off through the soak, tuning-file-armable only) is the sole path that can signal a process, behind four mandatory gates + sleep-wake re-arm.
- `src/core/hostSpawnSemaphore.ts` — **pass-through** — refactored to ride the extracted core; public exports and on-disk byte format pinned unchanged by golden tests.
- `GET /test-runner-limiter` — **add** — pure read, no blocking authority.
- `POST /test-runner-limiter/prune` — **add** — forced reclaim pass (same policy as the acquire path; single-flight, rate-limited).
- `dev:preflight` / pre-push self-disable pattern check — **add** — WARN-only by structure on pre-push (exit 0 unconditionally); advisory on preflight.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

At ship posture: **nothing can be blocked** — dry-run admits every run (would-blocks are ledger entries only). The clamps likewise reshape nothing in dry-run (`would-clamp` is logged; the real pool is untouched). The over-block analysis therefore applies to the post-soak enforcing flip, and the design's §1.1 fail-direction inversion exists precisely for it:

- A legitimate suite queued behind a hung holder: bounded by TTL capacity-reclaim (default 1h, row-stamped, sanity-ranged [5min, 4h]) + the typed capacity-timeout that names the holder pids/ages and the levers. Worst legitimate wait = wait budget (2 min background / 10 min interactive-class default).
- A legitimate targeted run mis-classified suite-class (multi-match positional, pool flags): deliberate safe-superset — it queues on the suite lane rather than being rejected; in the worst case it waits, never errors below the budget.
- A wedged lock: fail-OPEN admit (with witness), never a block — up to the 8-slot storm ceiling where the fail direction deliberately inverts (8+ concurrent open admissions IS the meltdown; refusing the 9th is the lesser harm).
- Enforcement cannot be armed per-process by a stray env: `INSTAR_HOST_TEST_ENFORCE=1` against a dry-run authority is honored but LOUD (bidirectional posture-divergence WARN), and the kill-arm (`TTL_SIGNAL=1`) is structurally ignorable from env (arm is tuning-file-only).

Residual over-block risk accepted and mitigated: pre-push waits at cap=1 behind a genuinely long suite. Mitigation: interactive/push class gets the 5× wait budget, CLAUDE.md guidance ("a rejected push may be contention, not red tests"), and starvation is a named soak metric with a pre-authorized post-soak refinement (waiter tickets / priority admission).

---

## 2. Under-block

**What failure modes does this still miss?**

- **Old-branch worktrees** predating the chokepoint run unbounded until rebased (spec "coverage honesty": tracked as UNCOVERED in the soak, closed by normal rebase cadence).
- **Ad-hoc `npx vitest --config <arbitrary>`** at a shell bypasses the guarded configs (documented residual; the repo lint guards `package.json` scripts, and the config-riding chokepoint covers editor/ad-hoc invocations that load the five real configs).
- **Nested-child aggregate count**: each nested child is clamped ≤4 workers CLI-proof, but the COUNT of nested children is bounded by test authorship, not a hard cap (spec-stated assumption; per-child attribution via `nested-skip` ledger events makes a pathological spawner loud).
- **A same-user adversary** who forges the tuning file AND the baseline marker AND rewrites the ledger tail defeats the mutation-visibility mechanism — stated threat floor for every same-user-file surface in this design, not a gap this change created.
- **Watch mode** holds no slot (deliberate — a lingering watcher holding the cap-1 lane would be a standing false-BLOCK); an agent-context watch is loud + soak-metered + `diverged`-graded, never quiet.

All are stated in the spec (§2.6, §2.9, §3, §6) — no silent misses identified beyond the spec's own honesty list.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The bound must exist where test processes are BORN — inside the vitest config load path — because the incident population is bare worktree checkouts with no agent server running; any server-side gate would be silent exactly there. The primitive reuses the proven `hostSpawnSemaphore` mechanics via a parameterized core rather than re-implementing (lower layer reused, not duplicated) — and deliberately does NOT reuse the spawn lane's semantics where the workload differs (fail-direction inversion, no busy-spin, capacity-only reclaim, age-only lock reclaim: each a reviewed divergence, §2.1/§2.4). The spawn cap's own defects found during extraction (non-atomic lock reclaim, torn lock read, non-df-gated reclaim) are quarantined (test lane doesn't ride them) and tracked as a §4 back-port — not silently inherited, not silently "fixed" in a way that would change spawn behavior in this PR (golden tests pin it).

The route feeds existing surfaces (`/guards` grading, CapabilityIndex) instead of inventing parallel observability.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — at ship posture this change produces signals only (would-block/would-clamp/skip ledger events + loud WARNs). Blocking authority exists but is dormant behind an operator-deliberate tuning-file flip gated on 14 days of soak evidence.
- [x] Yes-qualified for the post-flip state — and the authority is a **deterministic policy evaluator in a genuinely enumerable domain** (the signal-vs-authority carve-out): process admission by counting slots. This is the same class as the existing fork-bomb spawn cap. Every brittle sub-check inside it is deprived of dangerous authority by construction: classifier uncertainty routes to the STRICTER lane (never fail-open to the roomy lane); reclaim uncertainty fails OPEN (admit); corrupt state fails OPEN + quarantines; only the provable-storm ceiling (8 live O_EXCL witnesses) refuses — the one point where over-admission IS the harm being prevented.
- The kill path (the only process-harming authority) is quadruple-gated (pid sanity, identity corroboration, group leadership, durable tombstone escalation + sleep-wake re-arm), off by default, un-armable from env, and never armed during the soak.

No brittle detector holds block authority. The 2026-04-15 four-layers-of-filters anti-pattern does not recur here: there is exactly ONE admission authority per lane, fed by detectors (classifier, df probe, pid evidence) that individually only produce signals or route toward safety.

---

## 5. Interactions

- **Shadowing:** the chokepoint runs BEFORE the integration config's `build-dist.globalSetup.ts` (prepended; teardown reverse order) — the dist build is deliberately inside the held slot (spec-stated, acceptable at cap 1). It does not shadow any existing gate: no other admission control exists on test runs today. The husky pre-push suite ride-through was verified: pre-push invokes the guarded configs, so pushes queue rather than stack.
- **Double-fire:** the spawn cap and the test cap are separate pools (separate holders/lock files, separate caps) — a `claude -p` spawn and a vitest root never contend for the same slot; no event is double-governed. Within the test lane, the process-global lane-scoped flag prevents one process double-acquiring via multiple globalSetups (workspace/aggregate runs), and the §5 guard-test fails on any `vitest.workspace.*` introduction until reviewed.
- **Races:** the load-bearing ones are addressed in-design and tested: atomic O_EXCL lock + race-safe age-reclaim with dev+ino verification (two concurrent reclaimers → one winner, no lost holders row); O_EXCL storm slots (no count-then-act); atomic temp+rename on every holders/tuning/marker write; torn tuning read → code-defaults without quarantine until a confirming re-read; `ps` evidence gathered outside the lock. The globalSetup ↔ config-eval seam pair cannot disagree in the dangerous direction because routing verifies live resolved state (pool bound ≤ 4), never a stamp.
- **Feedback loops:** the wait itself was the found feedback risk — a waiting run reading as a hang would re-trigger the sentinel kills this spec exists to stop (§2.10). Closed by making the once-a-minute wait line carry the sentinels' recognized active-work indicator (braille spinner + "active work, not a hang"), validated against the LIVE sentinel predicate by a dedicated test (ship gate). The ledger feeds `/guards` grading; a `diverged` grade raises an attention item but never feeds back into admission.

---

## 6. External surfaces

- **Other agents on the same machine:** yes — that is the point. The bound is host-wide across every checkout that contains the chokepoint (per-user `~/.instar` rendezvous). Cross-actor uniformity is a FILE (tuning), not env exports; divergent-env actors are loud (bidirectional posture WARN, >4× cap WARN) and visible in per-run ledger stamps. Mixed-version hosts are safe by the versioned+tolerant schema rule (unknown fields preserved; unknown states excluded from the count, loud, bounded).
- **Other users of the install base:** the chokepoint files reach builder/worktree hosts via git (repo source); the route/config/CLAUDE.md awareness ship to deployed agents via the update path (Migration Parity: types + ConfigDefaults + templates.ts + PostUpdateMigrator.migrateClaudeMd — the spec's audience split). Dry-run default means zero behavior change for every population at ship.
- **External systems:** none (no Telegram/GitHub/Cloudflare surface). No dashboard render added in this PR; route fields are charset/length-clamped at projection since holder rows are same-user-writable (untrusted) data.
- **Persistent state:** all new state is machine-local under `~/.instar` at frozen paths, `0600`/`0700`, size-bounded (ledger rotation ~5MB + retained segments; keep-newest-5 quarantines; poison ceiling 64 rows), and inert-safe-to-delete after revert (§6 rollback list).
- **Timing/runtime conditions:** laptop sleep-wake (TTL re-arm gate + named residual in the arm announcement), pid reuse (start-time corroboration), clock skew (bounded early/late slot-free, no signal), vitest version drift (classifier + fanout invariants proven per pinned version by ship-gate tests; drift caught by tests, not production).
- **Operator surface (Mobile-Complete):** no operator-facing ACTION ships in this change — the enforce flip is deliberately a maintainer action on a dev host (tuning file via CLI/route on the machine), not an end-user operator action; the soak-review decision is likewise maintainer-side. No PIN-gated approval flow is added. (If the flip is ever productized for operators, it needs a dashboard surface then.)

## 6b. Operator-surface quality

No operator surface — not applicable (no dashboard renderer/markup, approval page, or grant/revoke/secret form is touched; the route is agent/maintainer-facing JSON).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, with the reason:** a test-runner concurrency bound governs the CPU/processes of ONE machine — the resource being protected is physically per-host, so the holders/lock/ledger/tuning files must be per-machine truths (a cross-machine bound would be wrong: capacity on the Mini says nothing about the laptop). The design actively DEFENDS machine-locality: `df -P` host-local determination with marker revalidation, foreign-hostname holder drop + loud synced-home signal — because the one way this state could leak across machines (a synced `~/.instar`) is a misconfiguration the spec detects and refuses to act on rather than obeys.

- User-facing notices: none (stderr WARNs to the invoking terminal + ledger only; server-side grading rides the existing `/guards` attention path with its own dedup — no new notice channel, no one-voice concern).
- Durable state: per-machine by design; nothing strands on topic transfer (state is keyed to the host, not to a conversation).
- URLs: none generated.
- The pool-wide question ("is any machine's test lane saturated?") is answerable later via the existing `?scope=pool` pattern on the route — additive, not required for correctness, deliberately not in this PR (the bound's correctness never depends on a peer).

---

## 8. Rollback cost

- **Chokepoint (incident population):** env kill switch `INSTAR_HOST_TEST_SEMAPHORE=off` — immediate, no release, ledger-visible (never silent). Posture rollback from a bad enforce flip: clear `enforcing` in the tuning file (or `INSTAR_HOST_TEST_ENFORCE=0` per-process) — back to dry-run, not off.
- **Full rollback:** revert the PR. All on-disk artifacts are inert and enumerated in spec §6 (holders, lock, witness dir, df marker, tuning file, baseline marker, ledger + segments, quarantines) — safe to delete, no migration needed. Stale env exports become no-ops.
- **Agent state repair:** none — deployed agents received only a read route + a config knob + CLAUDE.md text; removal regresses nothing they depend on.
- **User visibility during rollback:** none at ship posture (dry-run changes no behavior); post-flip, rollback of a misbehaving enforce is one tuning-file field on the affected host.

---

## Conclusion

The review confirms the design holds its two load-bearing inversions everywhere: (1) fail-OPEN on every uncertainty because a false BLOCK (wedged pushes/builds host-wide) is the catastrophic direction — with the single deliberate, provable-storm exception at the 8-slot ceiling; and (2) ship-dark-as-dry-run so the soak itself is the safety net before any blocking exists.

**One named deviation from spec §2.9 text:** "an armed ttlSignal and any above-code-default cap as distinct `/guards` rows" is implemented as route-level fields (`ttlSignalArmed` frozen top-level + `capAboveDefault` additive detail) plus ONE load-bearing guard row for the limiter itself (soaking classification, `off-runtime-divergent` on kill-switch, loud gap on lapsed soak) — NOT as separate guard rows per lever. Reason: the GuardRow model is a closed boolean-posture allowlist where a `defaultEnabled:false` code-default row can never grade "on"; a per-lever row would LIE as "off" while armed — the exact dishonest-surface class the guards inventory exists to prevent. The spec's intent (armed ttlSignal and cap inflation are VISIBLE where a server exists) is met on the route + the chokepoint's own loud WARNs + ledger stamps; the letter (distinct rows) is deliberately not, and this is flagged for the second-pass reviewer to affirm or overturn. The kill machinery is structurally disarmed (env cannot arm it; the soak never arms it; four gates + sleep-wake honesty when armed). The riskiest residuals are all named in the spec rather than discovered here: pre-push starvation at cap=1 (soak-metered, pre-authorized refinement), nested-child count (authorship-bounded, loud), ad-hoc `--config` bypass (documented). Second-pass review is REQUIRED (this is a gate touching session-lifecycle-adjacent paths: git push, /build verification) and follows below. Ship gates before commit: the acquire-before-fanout instrumentation test and the §2.10 sentinel-predicate frame validation must pass (or the wrapper fallback / known-blocked registration must be wired per spec).

---

## Second-pass review (if required)

**Reviewer:** second-pass-reviewer (independent subagent)
**Independent read of the artifact: CONCUR**

The artifact's load-bearing claims hold true against the spec (§1.1, §2.4, §2.6, §2.9, §2.11) and against the actual code (`hostTestRunnerSemaphore.ts`, `test-runner-semaphore.globalSetup.ts`, `routes.ts`, `guardManifest.ts`); no ship-blocker found — this change is clear to proceed to trace + commit.

- **A — Signal vs authority (compliant).** Verified there is exactly ONE admission authority per lane: `live < cap` in `acquire()` (`hostTestRunnerSemaphore.ts` ~L1575). The classifier (targeted-vs-suite) is a router feeding two symmetric throwing lanes, not a blocker; the `df` probe routes only to fail-open-admit; pid/start-time evidence feeds capacity-reclaim, never a block. The one refusal at ship posture (the storm ceiling) is a deterministic count of live `O_EXCL` witnesses — an enumerable-domain policy evaluator, same class as the fork-bomb spawn cap, firing only when 8 concurrent open admissions IS the meltdown. No brittle detector holds block authority. The 2026-04-15 four-filters anti-pattern does not recur.
- **B — Fail-direction inversion holds in code.** The `globalSetup` catch block (L287-303) admits on ANY internal error (loud WARN + `fail-open-admit` ledger); it re-throws only the two typed capacity errors. Traced that `TestRunnerCapacityTimeoutError` is unreachable in dry-run (the dry-run branch returns an admit before the deadline-throw), so nothing blocks a run at ship posture except the disclosed storm ceiling. Corrupt/unparseable holders → admit+quarantine; `df`-unknown → admit, reclaim disabled; a per-poll lock miss retries (never admits); provable wedge → race-safe age-reclaim then retake. Confirmed no leaked holder on any throw path (throwing process never wrote its own row; `claimStormSlot` only throws when it holds zero slots).
- **C — Kill machinery disarmed at ship + un-armable from env.** `signalHungHolder` is called ONLY under `ctx.armed && ctx.posture === 'enforcing'` (double-gated); ship posture is dry-run with no tuning arm, so it is unreachable through the soak. The four gates are real and in order: pid-sanity (L1177), identity corroboration (L1183), group-leadership (L1200), durable tombstone + three completers (L1217-1230), with the sleep-wake re-arm short-circuiting before any signal (L1191). `resolveTtlSignal` makes env asymmetric: `=1` against an unarmed authority resolves `armed:false, envArmIgnored:true` + loud WARN — env can only DISARM. The DEFAULT TTL path is capacity-reclaim-only (`stale-holder-reclaimed`, no signal).
- **D — Over/under-block honesty (complete, with one disclosed nuance).** The §1/§2 lists are complete; the storm-ceiling refusal CAN fire in dry-run (it is posture-independent), a slight tension with the §1 headline "nothing can be blocked at ship posture," but it is explicitly named two bullets down in §1 and in the Conclusion, and is reachable only under a genuine sustained lock wedge (age-reclaim clears normal contention first) — honestly disclosed, not a hidden over-block. Adversarial checks for an unnamed under-block (multi-OS-user host, tuning-cap raise within `[1,ceiling]`, dry-run holders accumulation vs the 64 poison ceiling) all resolve to states the spec's own honesty list (§3/§2.9/§2.11) already names or to intended authority paths surfaced via `tuning-changed` + `capAboveDefault`.
- **E — §2.9 "distinct /guards rows" deviation: AFFIRM (do not overturn).** Verified `guardManifest.ts` L779-804 registers exactly ONE load-bearing row (`intelligence.testRunnerCap`, `loadBearing:true`, `soakWindowDays:14`, `defaultEnabled:true`) graded by resolved posture — `off-runtime-divergent` on the kill switch, `loadBearingSoaking` during the window, lapsing to a loud gap. A `defaultEnabled:false` per-lever `ttlSignalArmed` row would invert the guards model's semantics (the inventory answers "should this safety system be ON?"; an armed kill-signal being ON is the DANGEROUS state, so it cannot be a guard row without lying as a quiet "off" while armed). The spec's INTENT (armed arm + cap inflation VISIBLE where a server exists) is met on the route — verified `routes.ts` L8509 `ttlSignalArmed` (frozen top-level) + L8519 `capAboveDefault` — plus the chokepoint's loud env-arm-ignored / cap-divergence WARNs and every ledger event's `ttlSignalArmed`/`suiteCap`/`targetedCap`/`tuningHash` stamps. Route fields are the more honest surface than a semantically-inverted guard row; the deviation is sound.
- **F — Interactions/races.** No dangerous two-seam disagreement: the globalSetup routes to the targeted lane only after independently re-reading the LIVE resolved pool bound (`resolvedPoolBound(ctx.config) <= 4`, L204-207) — a stamp is never trusted, so "unclamped AND targeted-routed" is impossible by construction. Tombstone completion across the three completers is serialized under the holders lock (both `acquire` and `prune` run `applyReclaimPass` inside the lock) and each completer re-corroborates before SIGKILL — no double-kill, no lost obligation (unparseable-corruption salvages/enumerates tombstones). The spawn pool and test pool use separate holders/lock files and caps — no cross-pool double-governance. `GET` route is genuinely pure (verified `status()` does a virtual-prune for display only, no write, no signal); `POST /prune` delegates to `prune()` which gates the kill on the same `armed && enforcing` — the route re-implements no policy.
- **G — Multi-machine posture: correct.** Machine-local by design is right — the resource protected is one host's CPU, so holders/lock/ledger/tuning must be per-host truths. §7 defends it correctly: `df -P` host-local determination with `statSync().dev` + 24h-TTL marker revalidation (a failed probe is NEVER cached — the §1.2 spawn-lane lesson applied), plus foreign-hostname holder drop on a df-confirmed-local disk (the synced-`~/.instar` misconfiguration is detected and refused, not obeyed). No cross-machine leak missed; the pool-scope question is correctly deferred as additive.

---

## Post-build findings (meta-verification + unit tiers) and their resolution

The test build surfaced defects; each was resolved before commit (no deferrals):

1. **`clampConfigPool` min-bound crash (LOAD-BEARING, fixed).** The clamp set `maxWorkers`/`maxForks` to 4 but left `minWorkers`/`minForks` UNSET, so vitest's Tinypool resolved the pool min to `(numCpus − 1)` → on a ≥6-core host min 15 > max 4 → `RangeError`, crashing the root at pool creation whenever the clamp is real (clampActive/enforcing). A §1.1 false-BLOCK. Fixed in `src/core/testRunnerRunClassifier.ts` `clampConfigPool` — min bounds are now set explicitly to `Math.min(existing ?? 1, clampedMax)` (ceiling, never floor). The two ship-gate tests (targeted + nested actual-worker-count ≤4) now pass; verified ≤4 measured actual workers.
2. **argv neutralization is a no-op on vitest 2.1.9 (documented; not a hole).** vitest's `cac` parser reads the CLI before the config module loads, so mutating `process.argv` at config-eval cannot reach the already-parsed pool flags. The CLI-proofness is delivered instead by the config `poolOptions.*.{min,max}` hard-set, which outranks a CLI `--maxWorkers` (measured ≤4). The one residual the config clamp can't reach — a CLI `--poolOptions.forks.maxForks=N` same-keying the config — is caught LOUD by the globalSetup `poolOverride` WARN (`nested-skip clamped:false, poolOverride:true`), never silently unbounded, and nested spawns are authorship-bounded per §2.5. The neutralization is kept as a harmless belt (works for wrapper-routed spawns; version-stable). Code comment added.
3. **Meta finding "nested-skip `clamped:true` in dry-run" — assessed and DECLINED (no change).** The reviewer read `clamped` as "a reshape physically happened" and flagged it against §2.11. But spec §2.5 DEFINES `clamped` as the guarded-vs-unguarded dimension (`true` = went through the guarded config-eval path; `false` = unguarded config skipped the clamp, + WARN) — NOT the reshape dimension. The dry-run reshape nuance is carried by `clampStash:'dry-run'`, and the §4(e) real-clamp soak count is derived from the separate `would-clamp`/clamp events, not this boolean. Changing it would contradict the converged spec and break the unit test that correctly encodes §2.5; left as spec-specified, with a clarifying code comment.
4. **`jitteredPoll` could go negative below a sub-jitter poll seam (fixed, defaults unaffected).** Floored at 0 in `hostTestRunnerSemaphore.ts`. The related enforcing-poll holders-file churn (§2.2 item 3 write-only-on-change) was fixed by the unit tier (`applyReclaimPass` now returns `changed`; callers skip the rewrite when nothing changed; inode-stability tested).

Unit-tier module fixes (5, each proven red→green in `hostTestRunnerSemaphore.ts`): poison-ceiling off-by-one (`>` → `>=` at 64 rows); tombstone salvage regex (single-line holders file was un-salvageable); mis-grabbed lock-aside age-sweep (was accumulating forever); write-only-on-change (above); `ps` fingerprint/pgid moved OUTSIDE the holders lock (sub-ms critical section). Four unit-tier spec-vs-code deltas were assessed as acceptable (documented, not defects): ledger appends under the lock are sub-ms best-effort; torn-tuning-read uses the strictly-safer good re-read value; the extraction shares primitives without a single `acquire(admit)` seam (golden test pins spawn behavior unchanged); a stale env marker never CREATES a skip (ancestry+holders is the authority — spec-intended ordering).

## Evidence pointers

- Spec + convergence report: `docs/specs/test-runner-concurrency-bound.md`, `docs/specs/reports/test-runner-concurrency-bound-convergence.md` (10 rounds, 6 internal reviewers + codex/gemini externals per round; final round zero must-fix).
- Test tiers: `tests/unit/host-semaphore-core.test.ts` (golden/extraction), `tests/unit/host-test-runner-semaphore.test.ts` + `tests/unit/test-runner-run-classifier.test.ts` (unit matrix), `tests/integration/test-runner-limiter-route.test.ts`, `tests/e2e/test-runner-limiter-lifecycle.test.ts`, `tests/integration/test-runner-bound-meta.test.ts` (meta-verification incl. both ship gates), `tests/unit/test-runner-config-guard.test.ts`, `tests/unit/test-runner-wait-frame.test.ts`, `tests/unit/test-runner-selfdisable-patterns.test.ts`.
- _Final test results to be appended at commit time._

## Post-merge CI-fix addendum (2026-07-03)

Three CI failures on the feature PR were resolved (no behavior deferred):

1. **`renameAsideVerified` identity check hardened — dev+ino → dev+ino+mtime (LOAD-BEARING, real side effect).** The §2.4 wedged-lock age-reclaim proved "I moved the exact object I lstat'd" using `dev`+`ino` ONLY. A freed inode can be REUSED by the filesystem for a peer's FRESH lock created in the reclaim race (reproduced on CI's filesystem; not local APFS), producing a false identity match — the reclaimer would then treat a live peer's fresh lock as its own reclaimed stale lock (a genuine correctness hole, not just a flaky test). Fixed in `src/core/hostTestRunnerSemaphore.ts` by adding `after.mtimeMs === before.mtimeMs` to the identity conjunction. `rename(2)` preserves mtime, so the happy-path reclaim (same object moved aside) still matches exactly; a swapped-in fresh file — written "now", against a provably-wedged/dead object whose mtime is old — never matches, so the abort-and-leave-aside path fires deterministically on any filesystem regardless of inode reuse. Both callers (`ageReclaimWedgedLock`, `claimStormSlot`) are covered; the storm-slot path is unaffected because a dead claimant's slot mtime still equals the pre-rename lstat on the happy path.

2. **Golden dark-gate attribution map re-generated (test-only).** The new `intelligence.testRunnerCap` ConfigDefaults block (`enabled: true` — NOT an attributed dark-gate `enabled: false` literal) shifted every `monitoring.*` attributed line down by a uniform +13. `tests/unit/lint-dev-agent-dark-gate.test.ts` EXPECTED map updated (24 paths unchanged, all +13); no new attributed dark gate introduced.

3. **CLAUDE.md migrator section tracked (test-only).** `Test-Runner Concurrency Bound` added to `legacyMigratorSections` in `tests/unit/feature-delivery-completeness.test.ts` — same safety-floor, migrator+template, capability-already-in-CapabilityIndex class as its sibling `Fork-Bomb Spawn Cap` (no template-shadow-marker parity required).
