53 checks executed; 6 CANNOT FAIL under the default/clean-tree invocation.

# Vacuous Check Audit

Tree provenance:
- `git log -1 --format='%h %ci'` => `2197591 2026-08-05 02:19:20 +0000`
- Control: `grep -rl CrashLoopPauser src | wc -l` => `4`

Execution baseline:
- Ran 35 target scripts with `node <script>`.
- Ran 18 target ratchet tests with `vitest run <file>` using `/Users/justin/.instar/agents/echo/node_modules/.bin` on `PATH`, because this worktree has no local `node_modules`.
- Final baseline: all 53 target checks exited 0.
- Note: an initial direct `./node_modules/.bin/vitest` attempt returned 127 for ratchet tests because the binary is absent in this worktree; those were rerun successfully with the main checkout's installed Vitest.

## Cannot-Fail Findings

1. `scripts/lint-degradation-emit-sites.js` cannot fail by construction.
   - Grounding: header says the lint "NEVER blocks" and "always exits 0" at `scripts/lint-degradation-emit-sites.js:9-10`; the missing-`src/` branch exits 0 at `scripts/lint-degradation-emit-sites.js:61-63`; the final summary says "exit 0 always" at `scripts/lint-degradation-emit-sites.js:114`; the only terminal exit is `process.exit(0)` at `scripts/lint-degradation-emit-sites.js:116`.
   - Broken input that still passes: add a new legacy `DegradationReporter...report(...)` emit site in `src/`. It increments `legacyCount` at `scripts/lint-degradation-emit-sites.js:92-100`, prints it, and still exits 0.

2. `scripts/lint-machine-local-justification.js` cannot fail under its default executable invocation.
   - Grounding: the rollout comment says the default run "REPORTS findings and exits 0" at `scripts/lint-machine-local-justification.js:40-47`; findings are accumulated at `scripts/lint-machine-local-justification.js:235-244`; only `--strict` makes findings fail at `scripts/lint-machine-local-justification.js:266`; the unconditional default exit is `process.exit(0)` at `scripts/lint-machine-local-justification.js:267`.
   - Broken input that still passes: a spec with `## Multi-machine posture` and an undefended `machine-local` assertion trips `A1-undefended-machine-local` at `scripts/lint-machine-local-justification.js:181-200`, but `node scripts/lint-machine-local-justification.js` reports it and exits 0.

3. `scripts/lint-self-heal-fields.js` cannot fail under its default executable invocation.
   - Grounding: the rollout comment says the default run "REPORTS findings and exits 0" at `scripts/lint-self-heal-fields.js:41-46`; findings are accumulated at `scripts/lint-self-heal-fields.js:222-231`; only `--strict` makes findings fail at `scripts/lint-self-heal-fields.js:253`; the unconditional default exit is `process.exit(0)` at `scripts/lint-self-heal-fields.js:254`.
   - Broken input that still passes: a spec with `remediation-actions:` but missing the required P19 fields trips `B1-missing-field` at `scripts/lint-self-heal-fields.js:138-154`, but `node scripts/lint-self-heal-fields.js` reports it and exits 0.

4. `scripts/lint-no-unregistered-self-action.js` cannot fail on protected violations in the current default configuration.
   - Grounding: the rollout comment says "REPORT-ONLY by default" and "ALWAYS exits 0" unless the class-closure flip is enforcing at `scripts/lint-no-unregistered-self-action.js:24-28`; absent config returns `{ enabled: false, dryRun: true }` at `scripts/lint-no-unregistered-self-action.js:73-85`; current worktree has no `.instar/config.json`; violations only exit 1 when `enforcing && violations.length > 0` at `scripts/lint-no-unregistered-self-action.js:187-198`; otherwise it exits 0 at `scripts/lint-no-unregistered-self-action.js:203`.
   - Broken input that still passes: add an unregistered self-action emit in a controller-shaped `src/*Monitor.ts` file. `evaluateSelfActionLint` records it at `scripts/lint-no-unregistered-self-action.js:120-145`, but the current default run logs report-only output and exits 0.

5. `tests/unit/keyword-intent-decision-ratchet.test.ts` has a tautological `it`.
   - Grounding: the test named "no allowlist entry is dead weight" computes `dead` at `tests/unit/keyword-intent-decision-ratchet.test.ts:244-245`, warns when `dead.length` is nonzero at `tests/unit/keyword-intent-decision-ratchet.test.ts:246-248`, then asserts only `Array.isArray(dead)` at `tests/unit/keyword-intent-decision-ratchet.test.ts:249-250`.
   - Broken input that still passes: make an `ALLOWLIST` entry stale. `dead` becomes non-empty, but it is still an array, so the assertion always passes.

6. `tests/unit/provenance-coverage-ratchet.test.ts` has a constant-true `it`.
   - Grounding: the test named "logs per-component callsite-count vs declared-decision-point mismatches (non-blocking)" builds `drift` at `tests/unit/provenance-coverage-ratchet.test.ts:932-956`, deliberately logs instead of asserting at `tests/unit/provenance-coverage-ratchet.test.ts:957-966`, then ends with `expect(true).toBe(true)` at `tests/unit/provenance-coverage-ratchet.test.ts:967`.
   - Broken input that still passes: change attribution callsites so discovered counts diverge from declared provenance coverage. `drift.length` becomes nonzero, but the test only logs and the final assertion is constant true.

## Executed Checks

| Check | Exit | Failability finding |
| --- | ---: | --- |
| `scripts/check-capability-registry-read-model.mjs` | 0 | Failable: any authority-path consumer of the advisory capability read model populates `offenders` and exits 1 at `scripts/check-capability-registry-read-model.mjs:22`. |
| `scripts/check-release-fragment.mjs` | 0 | Failable: malformed `PR_FILES_JSON` exits 1 at `scripts/check-release-fragment.mjs:103-105`; release-relevant files without a fragment exit 1 at `scripts/check-release-fragment.mjs:139-146` unless `WARN_ONLY=1`. |
| `scripts/check-repo-invariants.mjs` | 0 | Failable: repository invariant failures accumulate in `failures`; clean exits at `scripts/check-repo-invariants.mjs:98-100`, otherwise exits 1 at `scripts/check-repo-invariants.mjs:104-108`. |
| `scripts/check-spec-review-link.mjs` | 0 | Failable: stdin that looks like a spec-review handoff without a rendered `/view/` link exits 1 at `scripts/check-spec-review-link.mjs:52-60`. |
| `scripts/lint-cas-emit-placement.js` | 0 | Failable: new CAS emit placement violations populate `violations` and exit 1 at `scripts/lint-cas-emit-placement.js:77-84`. |
| `scripts/lint-degradation-emit-sites.js` | 0 | FLAGGED: warning-only catalogue; always exits 0 at `scripts/lint-degradation-emit-sites.js:114-116`. |
| `scripts/lint-dev-agent-dark-gate.js` | 0 | Failable: assertion A/B/C violations populate `violations`; clean exits at `scripts/lint-dev-agent-dark-gate.js:343-345`, otherwise exits 1 at `scripts/lint-dev-agent-dark-gate.js:352-359`. |
| `scripts/lint-emit-without-admit.js` | 0 | Failable: unlicensed/unadmitted self-action emit handling populates `violations` and exits 1 at `scripts/lint-emit-without-admit.js:296-300`. |
| `scripts/lint-expected-capacity-degradations.js` | 0 | Failable: malformed/empty contracts, duplicate markers, missing bindings, or unretired base contracts populate `findings` and exit 1 at `scripts/lint-expected-capacity-degradations.js:31-53` and `scripts/lint-expected-capacity-degradations.js:97-143`. |
| `scripts/lint-guard-manifest.js` | 0 | Failable: missing manifest components, malformed not-a-guard entries, or candidate mismatches exit 1 at `scripts/lint-guard-manifest.js:191-197` and `scripts/lint-guard-manifest.js:252-267`. |
| `scripts/lint-journal-actuation-ban.js` | 0 | Failable: actuator files importing/writing through journal append-only paths populate `violations` and exit 1 at `scripts/lint-journal-actuation-ban.js:46-61`. |
| `scripts/lint-llm-attribution.js` | 0 | Failable: real un-attributed funnel calls or stale allowlist entries exit 1 at `scripts/lint-llm-attribution.js:398-414`. |
| `scripts/lint-machine-local-justification.js` | 0 | FLAGGED: default report mode exits 0 even with findings at `scripts/lint-machine-local-justification.js:247-267`; only `--strict` fails. |
| `scripts/lint-migration-consumer-completeness.js` | 0 | Failable: registry shape errors exit 1 at `scripts/lint-migration-consumer-completeness.js:268-280`; completeness findings exit 1 at `scripts/lint-migration-consumer-completeness.js:290-298`. |
| `scripts/lint-no-blocking-process-scans.js` | 0 | Failable: forbidden blocking process-scan calls in scanned files exit 1 at `scripts/lint-no-blocking-process-scans.js:82-113`. |
| `scripts/lint-no-direct-destructive.js` | 0 | Failable: direct destructive commands/API use populate `violations`; clean exits at `scripts/lint-no-direct-destructive.js:696-699`, otherwise reports and exits 1 at `scripts/lint-no-direct-destructive.js:704-714`. |
| `scripts/lint-no-direct-llm-http.js` | 0 | Failable: forbidden direct LLM HTTP patterns populate `all`; clean exits at `scripts/lint-no-direct-llm-http.js:178-180`, otherwise exits 1 at `scripts/lint-no-direct-llm-http.js:186-190`. |
| `scripts/lint-no-direct-url-log.js` | 0 | Failable: risky URL variable logging populates `offenders` and exits 1 at `scripts/lint-no-direct-url-log.js:49-67`. |
| `scripts/lint-no-mainthread-cartographer-walk.js` | 0 | Failable: main-thread cartographer walks outside allowed context populate violations and exit 1 at `scripts/lint-no-mainthread-cartographer-walk.js:68-99`. |
| `scripts/lint-no-opus-claude-cli-gating.js` | 0 | Failable: config/router problems exit 1 at `scripts/lint-no-opus-claude-cli-gating.js:199-222`. |
| `scripts/lint-no-unbounded-llm-spawn.js` | 0 | Failable: forbidden unbounded LLM spawn patterns in scanned files exit 1 at `scripts/lint-no-unbounded-llm-spawn.js:100-135`. |
| `scripts/lint-no-unfunneled-credential-write.js` | 0 | Failable: unfunneled credential writes in scanned files exit 1 at `scripts/lint-no-unfunneled-credential-write.js:122-160`. |
| `scripts/lint-no-unfunneled-headless-launch.js` | 0 | Failable: unfunneled headless launch patterns in scanned files exit 1 at `scripts/lint-no-unfunneled-headless-launch.js:91-126`. |
| `scripts/lint-no-unfunneled-tmux-literal-send.js` | 0 | Failable: direct literal tmux send patterns populate `violations` and exit 1 at `scripts/lint-no-unfunneled-tmux-literal-send.js:51-75`. |
| `scripts/lint-no-unfunneled-topic-creation.js` | 0 | Failable: forbidden topic creation patterns in scanned files exit 1 at `scripts/lint-no-unfunneled-topic-creation.js:98-127`. |
| `scripts/lint-no-unreachable-messaging-gate.js` | 0 | Failable: unreachable messaging gate callsites populate `offenders` and exit 1 at `scripts/lint-no-unreachable-messaging-gate.js:75-91`. |
| `scripts/lint-no-unregistered-self-action.js` | 0 | FLAGGED: current default config is report-only; violations only fail when `enabled && !dryRun` at `scripts/lint-no-unregistered-self-action.js:187-198`. |
| `scripts/lint-no-wholefile-sync-read.js` | 0 | Failable: new whole-file sync reads outside the registry/baseline exit 1 at `scripts/lint-no-wholefile-sync-read.js:114-128`. |
| `scripts/lint-rollout-evidence-resolvable.js` | 0 | Failable: unresolved rollout evidence links not in the known unresolved set exit 1 at `scripts/lint-rollout-evidence-resolvable.js:113-178`. |
| `scripts/lint-routing-registry-freshness.js` | 0 | Failable: missing registry rows or stale allowlist entries exit 1 at `scripts/lint-routing-registry-freshness.js:97-124`. |
| `scripts/lint-scrape-fixture-realness.js` | 0 | Failable: malformed registered scrape fixtures/parsers return `exitCode: 1` at `scripts/lint-scrape-fixture-realness.js:354-382` and are passed to `process.exit(exitCode)` by the CLI at `scripts/lint-scrape-fixture-realness.js:389-408`. |
| `scripts/lint-self-heal-fields.js` | 0 | FLAGGED: default report mode exits 0 even with findings at `scripts/lint-self-heal-fields.js:234-254`; only `--strict` fails. |
| `scripts/lint-state-registry.js` | 0 | Failable: malformed registry rows or unregistered state write literals exit 1 at `scripts/lint-state-registry.js:75-117` and `scripts/lint-state-registry.js:249-313`. |
| `scripts/lint-store-retention-declared.js` | 0 | Failable: missing/invalid store retention declarations populate `errors` and exit 1 at `scripts/lint-store-retention-declared.js:66-85`. |
| `scripts/lint-sync-subprocess-chokepoint.js` | 0 | Failable: new raw sync subprocess calls outside the chokepoint/baseline exit 1 at `scripts/lint-sync-subprocess-chokepoint.js:192-203`. |
| `tests/unit/capability-registry-read-model-ratchet.test.ts` | 0 | Failable: wraps `check-capability-registry-read-model.mjs`; missing expected clean output fails at `tests/unit/capability-registry-read-model-ratchet.test.ts:5-7`. |
| `tests/unit/cartographer-freshness-ratchet.test.ts` | 0 | Failable: synthetic fixtures assert both passing and failing subprocess exits, including empty-authored index failure at `tests/unit/cartographer-freshness-ratchet.test.ts:70-76` and stale regression failure at `tests/unit/cartographer-freshness-ratchet.test.ts:112-119`. |
| `tests/unit/conversation-identity-mint-idiom-ratchet.test.ts` | 0 | Failable: new mint idiom outside the allowlist fails at `tests/unit/conversation-identity-mint-idiom-ratchet.test.ts:47-59`; detector-liveness guard fails if the consolidated module no longer matches at `tests/unit/conversation-identity-mint-idiom-ratchet.test.ts:62-64`. |
| `tests/unit/durable-output-chokepoint-ratchet.test.ts` | 0 | Failable: malformed chokepoints fail at `tests/unit/durable-output-chokepoint-ratchet.test.ts:55-91`; duplicate components fail at `tests/unit/durable-output-chokepoint-ratchet.test.ts:129-132`; empty wired coverage fails at `tests/unit/durable-output-chokepoint-ratchet.test.ts:113-121`. |
| `tests/unit/judges-claims-classification-ratchet.test.ts` | 0 | Failable: missing/dangling classifications, invalid claim kinds, baseline drift, or too-short reasons fail at `tests/unit/judges-claims-classification-ratchet.test.ts:72-136`; core sanity loop has a non-empty literal list at `tests/unit/judges-claims-classification-ratchet.test.ts:139-151`. |
| `tests/unit/keyword-intent-decision-ratchet.test.ts` | 0 | PARTLY FLAGGED: most tests are failable (`ENFORCE = true` at `tests/unit/keyword-intent-decision-ratchet.test.ts:213`; net-new offenders fail at `tests/unit/keyword-intent-decision-ratchet.test.ts:272-278`), but the dead-allowlist `it` is tautological at `tests/unit/keyword-intent-decision-ratchet.test.ts:244-250`. |
| `tests/unit/llm-attribution-ratchet.test.ts` | 0 | Failable: allowlist/funnel pinning, full-repo lint, detector self-tests, and category wiring assert concrete non-empty or negative cases at `tests/unit/llm-attribution-ratchet.test.ts:41-80`, `tests/unit/llm-attribution-ratchet.test.ts:83-160`, and `tests/unit/llm-attribution-ratchet.test.ts:188-230`. |
| `tests/unit/llm-bench-coverage-ratchet.test.ts` | 0 | Failable: missing/dangling coverage, pending/exempt baseline additions, exempt reason length, and critical coverage checks fail at `tests/unit/llm-bench-coverage-ratchet.test.ts:70-123`. |
| `tests/unit/llm-routing-nature-ratchet.test.ts` | 0 | Failable: missing/dangling classifications, enum validity, contradiction scans, synthetic lint fixtures, and router resolution examples fail at `tests/unit/llm-routing-nature-ratchet.test.ts:52-202`. |
| `tests/unit/nature-routing-injection-exposure-ratchet.test.ts` | 0 | Failable: missing/dangling entries, default resolution examples, enum validity, mandatory exposed components, and channel coverage checks fail at `tests/unit/nature-routing-injection-exposure-ratchet.test.ts:48-164`. |
| `tests/unit/parser-contract-classification-ratchet.test.ts` | 0 | Failable: missing/dangling classifications, wave and pending/false baselines, stale allowlists, and invalid wave checks fail at `tests/unit/parser-contract-classification-ratchet.test.ts:149-248`. |
| `tests/unit/provenance-coverage-ratchet.test.ts` | 0 | PARTLY FLAGGED: most tests are failable, including missing/dangling census checks at `tests/unit/provenance-coverage-ratchet.test.ts:178-192`, wired enrollment checks at `tests/unit/provenance-coverage-ratchet.test.ts:856-926`, and registry checks at `tests/unit/provenance-coverage-ratchet.test.ts:705-848`; the final informational drift test is constant-true at `tests/unit/provenance-coverage-ratchet.test.ts:930-967`. |
| `tests/unit/reviewer-fail-closed-ratchet.test.ts` | 0 | Failable: the non-empty `REVIEWER_CLASSES` literal set is instantiated and checked for fail-closed behavior at `tests/unit/reviewer-fail-closed-ratchet.test.ts:54-76`. |
| `tests/unit/silent-loss-route-outcome-ratchet.test.ts` | 0 | Failable: route outcomes must satisfy ack/remote-handled semantics and synthetic regressions fail at `tests/unit/silent-loss-route-outcome-ratchet.test.ts:40-93`. |
| `tests/unit/stall-coverage-ratchet.test.ts` | 0 | Failable: schema issues, missing matrix frameworks, missing phases, and detector/schema disagreement fail at `tests/unit/stall-coverage-ratchet.test.ts:30-72`. |
| `tests/unit/standards-coverage-ratchet.test.ts` | 0 | Failable: parser fixtures, reference resolution floors, anchor checks, generated asset checks, and regression fixtures assert concrete failures throughout `tests/unit/standards-coverage-ratchet.test.ts:395-950`. |
| `tests/unit/untrusted-input-classification-ratchet.test.ts` | 0 | Failable: missing/dangling classifications, argued-false baseline drift, too-short reasons, and stale reviewed allowlist entries fail at `tests/unit/untrusted-input-classification-ratchet.test.ts:60-120`. |
| `tests/unit/write-domain-conformance-ratchet.test.ts` | 0 | Failable: wave-1 anchor classification, dangling inventory references, TODO baseline drift, and synthetic route classification fixtures fail at `tests/unit/write-domain-conformance-ratchet.test.ts:87-164`. |
