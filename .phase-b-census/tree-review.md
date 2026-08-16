Provenance/control: `git log -1 --format='%h %ci'` returned `2197591 2026-08-05 02:19:20 +0000`; `grep -rl CrashLoopPauser src | wc -l` returned `4`, so the control passed.

# Q1 - Internal Contradictions

1. B0 ordering is contradictory in action-bearing text. The header says B0.1 is "not ready to build" and B0.5 is the prerequisite (`/tmp/tree-for-review.md:17`, `/tmp/tree-for-review.md:21`). Section 2 says B0.5 now precedes B0.1 (`/tmp/tree-for-review.md:150-154`), but the original row still labels B0.1 the "FIRST BUILD ITEM" (`/tmp/tree-for-review.md:163`) and "What happens next" says B0.1 spec is the charter's first build item (`/tmp/tree-for-review.md:312-313`). A worker following section 4 would schedule the wrong thing.

2. B0.2 is both done and still pending. The header says B0.2 is DONE (`/tmp/tree-for-review.md:18`), but the node table still says the census is IN FLIGHT (`/tmp/tree-for-review.md:164`) and section 4 says the census "lands" next (`/tmp/tree-for-review.md:314`). The appendix supports the header, not the later action text: `.phase-b-census/guard-counter-census.md:1` and `/tmp/tree-for-review.md:322-337`.

3. B5 is two different branches with the same node id. The original tree defines B5 as "LIVE FAULTS WITH MEASURED HARM" (`/tmp/tree-for-review.md:138`, `/tmp/tree-for-review.md:254-262`). The header reuses B5 for "guard-invocation re-architecture" (`/tmp/tree-for-review.md:33`), and the later section also names that branch B5 (`/tmp/tree-for-review.md:680-685`). This is not just stale prose; it creates two current-looking B5 meanings.

4. The authoritative header is stale about the finding range. It says "Findings raised this window (F9-F13)" (`/tmp/tree-for-review.md:35`) but the document contains F14 as a substantive late finding (`/tmp/tree-for-review.md:1350-1411`). Because the header is declared authoritative (`/tmp/tree-for-review.md:10-11`), omitting F14 is a header contradiction.

5. The synthesis count is internally stale. The header says the synthesis now has 13 instances (`/tmp/tree-for-review.md:47-49`), while the named SYNTHESIS section still says "seven defects" and lists seven rows (`/tmp/tree-for-review.md:627-642`). Later F12-F14 add more examples, but the load-bearing synthesis section was not revised.

6. F10's named list contradicts its own evidence. The plan names twelve decision-making surfaces (`/tmp/tree-for-review.md:837-842`). The evidence file says the count 12 is right but four named files are false positives and four real blockers are absent (`.phase-b-census/f10-triage.md:62`, `.phase-b-census/f10-triage.md:92-104`, `.phase-b-census/f10-triage.md:124`). The later plan section acknowledges overstatement generally (`/tmp/tree-for-review.md:920-930`) but never corrects the wrong named list.

7. F11 is marked fixed, but the named fixing artifact is absent. The header says F11 is "fixed structurally" (`/tmp/tree-for-review.md:41`). The body names `docs/audits/phase-b/lane-waiter.sh` as the mechanism (`/tmp/tree-for-review.md:994-1001`). Absence controls `ls -l docs/audits/phase-b/lane-waiter.sh` and `find . -path '*lane-waiter.sh' -print` returned no file in the reviewed worktree. That makes "fixed structurally" unsupported.

8. B3.1/CrashLoopPauser wording is too broad against source. The plan says "build it", "never constructed", and "still never constructed" (`/tmp/tree-for-review.md:30`, `/tmp/tree-for-review.md:223`). Source has an implemented class (`src/monitoring/CrashLoopPauser.ts:67-82`) and unit tests constructing it (`tests/unit/crash-loop-pauser.test.ts:62-75`, `tests/unit/crash-loop-pauser.test.ts:130-141`). The source control `rg -n "new CrashLoopPauser|CrashLoopPauser\\(" src tests` finds constructions only in tests, not production. The live problem appears to be runtime/boot wiring, not "build it".

# Q2 - Unsupported / Spot-Checked Quantitative Claims

Held:

- B0.2 4 full / 7 partial / 62 none / 7 unknown / 80 total holds against `.phase-b-census/guard-counter-census.md:1`, `.phase-b-census/guard-counter-census.md:10-15`.
- `GUARD_MANIFEST` has 72 entries. The array is `src/monitoring/guardManifest.ts:67-1112`; counting top-level `key:` rows returned 72. The reconciliation file also states this at `.phase-b-census/denominator-reconciliation.md:34-42`.
- `COHERENCE_MANIFEST_EXCLUSIONS` has 24 entries and the test checks raw `.length > 20`: source array at `src/core/machineCoherenceManifest.ts:274-302`; test at `tests/unit/machine-coherence-manifest.test.ts:128-131`.
- 26 `.sh`/`.js`/`.mjs` files under `src/templates` holds. Evidence: `.phase-b-census/f10-triage.md:7-10`, `.phase-b-census/f10-triage.md:13-42`; my `find src/templates ... | wc -l` also returned 26.
- 18 ratchet tests holds. Evidence: `.phase-b-census/f10-triage.md:10`; my `find tests/unit -maxdepth 1 -type f -name '*ratchet*.test.ts' | wc -l` returned 18.
- F12's 53 checks / 6 cannot fail holds against the lane artifact: `.phase-b-census/vacuous-check-audit.md:1`, `.phase-b-census/vacuous-check-audit.md:9-18`, `.phase-b-census/vacuous-check-audit.md:21-38`.
- F13's 11 tautological / shape-only assertion blocks holds against `.phase-b-census/tautology-sweep.md:7-14`, with examples at `.phase-b-census/tautology-sweep.md:22-78`.

Did not hold or is unsupported:

- The F10 named twelve do not hold even though the total 12 does. The plan's list at `/tmp/tree-for-review.md:839-842` includes `session-start.sh`, `model-tier-reconciler.js`, `instar-watchdog.sh`, and `emit-session-clock.sh`; the triage file marks those false positives and names the four missing blockers (`.phase-b-census/f10-triage.md:92-104`).
- "F11 fixed structurally" is unsupported by source because the named file is absent. Claim: `/tmp/tree-for-review.md:41`, `/tmp/tree-for-review.md:996-1001`. Absence controls returned no `docs/audits/phase-b/lane-waiter.sh` and no `*lane-waiter.sh`.
- The cited durable artifact `docs/audits/phase-b/guard-verifiability-28-and-44.md` is absent. The plan cites it for B0.1/B5 scope (`/tmp/tree-for-review.md:693-695`). Controls `find . -path '*guard-verifiability-28-and-44.md' -print` and `test -f docs/audits/phase-b/guard-verifiability-28-and-44.md` found no file; the local substitute is `.phase-b-census/chokepoint-survey.md:123-126`.
- "Sweep of 2,248 test files" is only true under an unstated narrow denominator. The artifact says it means `tests/unit/*.ts` recursively (`.phase-b-census/tautology-sweep.md:7`). Broad controls returned 3167 files under `tests` and 3057 `*.test.ts` files. The plan's wording at `/tmp/tree-for-review.md:1234-1237` says "test files" without the `tests/unit` denominator.
- CrashLoopPauser "never constructed" is false if read literally: tests construct it (`tests/unit/crash-loop-pauser.test.ts:64`, `tests/unit/crash-loop-pauser.test.ts:74`, `tests/unit/crash-loop-pauser.test.ts:83`). It is true only if narrowed to production/runtime construction; the plan does not say that.

# Q3 - Central Thesis

The thesis is useful but over-fitted.

Strong instances: `NOT_A_GUARD.reason` and `COHERENCE_MANIFEST_EXCLUSIONS.reason` really are proxy-vs-claim checks (`/tmp/tree-for-review.md:632-636`; `tests/unit/machine-coherence-manifest.test.ts:128-131`); `/health` status over a 24-hour window really certifies "now" from historical data (`/tmp/tree-for-review.md:1116-1161`; `src/server/routes.ts:3638`; `src/monitoring/FeatureMetricsLedger.ts:163-194`); the F13 trust tests really assert array-ness while the names/comments certify behavior (`tests/unit/AgentTrustManager-fingerprint.test.ts:145-155`; `/tmp/tree-for-review.md:1251-1275`).

Strongest case against: several named defects are not the same defect.

- F10 is primarily coverage absence caused by a language/path boundary. The ratchet scans only selected `src` subdirs and `.ts` files (`tests/unit/keyword-intent-decision-ratchet.test.ts:43-45`, `tests/unit/keyword-intent-decision-ratchet.test.ts:124-133`), while the problematic scripts live in `src/templates` and shell/JS (`/tmp/tree-for-review.md:776-806`). That is not a check passing too narrowly over those scripts; it is no applicable check.
- Original B5 groups operational faults by harm, not cause. The plan itself admits these may be unrelated and arguably outside the alignment tree (`/tmp/tree-for-review.md:254-266`, `/tmp/tree-for-review.md:304-306`). An argv-size failure or `claude -p` cwd hang is not naturally "passing condition narrower than certification."
- F11 is a missing return/collection mechanism (`/tmp/tree-for-review.md:979-999`). It can be rhetorically cast as "I remember" certifying "lane collected", but the concrete defect is workflow orchestration absence. The proposed remedy is a waiter, not a B-case.
- CrashLoopPauser is a runtime integration/classification problem. Source has a class and tests (`src/monitoring/CrashLoopPauser.ts:67-82`; `tests/unit/crash-loop-pauser.test.ts:62-75`), while the manifest classifies it as not-a-guard (`src/monitoring/guardManifest.ts:1149`) and production source has no `new CrashLoopPauser`. The root fix is boot/scheduler wiring plus classification, not just a narrower passing condition.

Verdict on thesis: as an explanatory motif it is sound for many verification/reporting defects. As a claim that "every defect found is one defect" (`/tmp/tree-for-review.md:47-49`) it overstates. Treat it as a recurring failure mode, not the single causal model for all remediation.

# Q4 - Node Quality

B1.1: premise checked and live, but the plan is not yet cleanly actionable. The source supports the re-diagnosis: the ratchet is TypeScript-shaped and scoped to five `src` dirs (`tests/unit/keyword-intent-decision-ratchet.test.ts:43-45`, `tests/unit/keyword-intent-decision-ratchet.test.ts:124-133`), while the plan's examples live in `src/templates` shell/JS (`/tmp/tree-for-review.md:783-806`). However, the current actionable F10 list is wrong in the plan: `/tmp/tree-for-review.md:837-842` contradicts `.phase-b-census/f10-triage.md:92-104`. B1.1 should not be scheduled until the corrected list replaces the stale one.

B2.3: premise live, but not actionable enough. The plan refutes the original unbounded path question and restates the node as "which other guard POPULATIONS deserve a complete-population forced-error ratchet" (`/tmp/tree-for-review.md:745-765`). It then names only loose examples: "the sentinel population, the gate population, the lint population" (`/tmp/tree-for-review.md:767-770`). There is no population definition, registry, exit artifact, or first candidate. My controls show why this matters: broad fail-closed/fail-open/abstain searches range from 268 source files to 551 source/scripts/tests files depending terms. A worker would have to invent the denominator.

B5 guard-invocation: premise is supported, but artifact routing is not. `.phase-b-census/chokepoint-survey.md:10-25` supports 28 current TICK-LOOP+FUNNEL candidates and 44 not currently caller-owned. The plan, however, cites `docs/audits/phase-b/guard-verifiability-28-and-44.md` (`/tmp/tree-for-review.md:693-695`), which is absent. The node is directionally actionable only if the evidence artifact is published or the plan cites `.phase-b-census/chokepoint-survey.md`.

B0.3: this is the cleanest LIVE node I checked. The plan says the health surface uses a 24-hour window (`/tmp/tree-for-review.md:1116-1129`), and source confirms `/health` asks `reliability({ sinceHours: 24 })` (`src/server/routes.ts:3638`) with minimum calls defined in `FeatureMetricsLedger` (`src/monitoring/FeatureMetricsLedger.ts:163-194`). The fix shape at `/tmp/tree-for-review.md:1152-1161` is still not a design, but the premise is checked.

# Q5 - What Is Missing

- A canonical current tree. The plan needs one non-historical work tree with retired nodes removed or tombstoned, unique node ids, current dependencies, and current next actions. The append-only history can stay below it.
- A published evidence index. Quantitative claims should point to committed or intentionally included artifacts. Several true claims live only in untracked `.phase-b-census/*`; several cited `docs/audits/phase-b/*` artifacts are absent.
- A node status derivation table. The contract says status is derived, never cached (`/tmp/tree-for-review.md:104-112`), but the plan uses cached prose statuses throughout. A remediation plan should state "status source, command/artifact, last measured, remeasure trigger."
- A dependency graph after the B0.5 reordering. The document says B0.5 is the spine (`/tmp/tree-for-review.md:377-380`), but section 4 still schedules B0.1 first.
- Concrete acceptance criteria for LIVE re-scoped nodes, especially B2.3 and B5 guard-invocation. "Populations" and "migrate" need explicit denominators, first slices, controls, and non-goals.
- Separation of alignment remediation from operational fault repair. Original B5 faults should either become ordinary reliability work or get individual causal links to the alignment thesis.
- A contradiction register. The plan's own stale sections should be explicitly marked superseded at the section or row level, not left for readers to reconcile from the header.

# Q6 - Is It Reviewable?

Partially, but it does not pass the stated exit gate yet.

I could reconstruct much of the state by reading the header, the appendices, and the `.phase-b-census` artifacts. I had to backtrack in three places:

- B5 means two different things (`/tmp/tree-for-review.md:254-262`, `/tmp/tree-for-review.md:680-685`).
- F10's count is correct but its named list is wrong; the correction exists only in `.phase-b-census/f10-triage.md:92-104`, not in the plan's current prose.
- B0.1/B0.5 ordering is corrected in one section but contradicted by the next-action list (`/tmp/tree-for-review.md:150-154`, `/tmp/tree-for-review.md:312-314`).

The exit gate asks whether an independent reader can read it without hitting a contradiction. I cannot. It is understandable with reconstruction, but reconstruction is not the bar.

# MATERIAL Findings

1. Gate-blocking incoherence: duplicate B5 node id. One B5 is operational faults (`/tmp/tree-for-review.md:254-262`); another is guard-invocation re-architecture (`/tmp/tree-for-review.md:680-685`). This must be renamed or split before scheduling.

2. Gate-blocking stale action order: B0.5 is prerequisite, but section 4 still schedules B0.1 first (`/tmp/tree-for-review.md:150-154`, `/tmp/tree-for-review.md:312-314`).

3. Gate-blocking unsupported "fixed" claim: F11 is marked structurally fixed (`/tmp/tree-for-review.md:41`), but the named `lane-waiter.sh` artifact is absent (`/tmp/tree-for-review.md:996-1001`; absence controls returned no file).

4. Material evidence mismatch: F10's named twelve are wrong. Correct total 12, wrong members (`/tmp/tree-for-review.md:837-842`; `.phase-b-census/f10-triage.md:62`, `.phase-b-census/f10-triage.md:92-104`, `.phase-b-census/f10-triage.md:124`).

5. Material artifact mismatch: B0.1/B5 cite `docs/audits/phase-b/guard-verifiability-28-and-44.md`, but that file is absent (`/tmp/tree-for-review.md:693-695`; `.phase-b-census/schema-r3.md:41`, `.phase-b-census/schema-r3.md:61` record the same absence).

6. Material overfit: the "one defect" synthesis is too broad for F10, F11, CrashLoopPauser wiring, and original B5 operational faults (`/tmp/tree-for-review.md:47-49`, `/tmp/tree-for-review.md:825-852`, `/tmp/tree-for-review.md:979-999`, `/tmp/tree-for-review.md:304-306`).

# MINOR Findings

1. The "2,248 test files" denominator needs its qualifier. The artifact says `tests/unit/*.ts` recursively (`.phase-b-census/tautology-sweep.md:7`); the plan says "test files" broadly (`/tmp/tree-for-review.md:1234-1237`).

2. CrashLoopPauser wording should say "not production-wired" or "not boot-constructed", not "build it" or "never constructed" (`/tmp/tree-for-review.md:30`, `/tmp/tree-for-review.md:223`; `src/monitoring/CrashLoopPauser.ts:67-82`; `tests/unit/crash-loop-pauser.test.ts:62-75`).

3. Header "F9-F13" should include F14 or explicitly say F14 is meta/process-only (`/tmp/tree-for-review.md:35`, `/tmp/tree-for-review.md:1350-1411`).

4. Header and synthesis section should agree on 13 versus seven instances (`/tmp/tree-for-review.md:47-49`, `/tmp/tree-for-review.md:627-642`).

5. B2.3 should replace "129 source files reference fail-closed behaviour" with the exact query and denominator or drop the count (`/tmp/tree-for-review.md:747-750`).

# Verdict

INCOHERENT - does not pass the exit gate. The plan contains enough valid evidence to salvage, but not in its current form: the current-state header, later action sections, node ids, named F10 list, and artifact references cannot all be true at once.
