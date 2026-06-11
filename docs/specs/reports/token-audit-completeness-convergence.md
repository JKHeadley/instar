# Convergence Report — Token-Audit Completeness

## ELI10 Overview

Justin made a rule: any feature that spends AI tokens has to show its receipts — how many tokens, which feature spent them, on which model. And the cartographer's background doc-sweep (the one feature that pays a third-party model on its own schedule) stays off until its receipts provably work.

The good news discovered up front: the receipt system mostly exists. Every internal AI call already passes through one funnel that writes a ledger row — feature, tokens, latency, model, framework — readable at `/metrics/features`. The bad news: the ledger had four blind spots, and one of them sat exactly on the feature Justin asked about. Codex-routed calls (the sweep's route) record zero tokens, because the codex CLI's plain output carries no usage numbers. Beyond that: failed calls lose their cost entirely, tokens aren't split per model, and the "which feature was this?" tag is optional — untagged calls quietly pool in an "unlabeled" bucket.

This spec closes all four: codex switches to its JSON-event mode so per-call tokens land in the ledger; failed calls record the tokens they actually burned; the ledger splits tokens per feature×model (including cached vs fresh); and attribution becomes mandatory — every existing untagged callsite gets tagged in the same PR, a build check stops new untagged calls from ever shipping, and the rule enters the constitution as a written standard ratified by Justin's directive. Tripwires (a coverage percentage, a one-shot alarm, a live canary test) make sure the fix can't silently rot back to blindness when a future codex version changes its output.

## Original vs Converged

The first draft had the right shape and several wrong load-bearing facts. The biggest: it claimed a 1 MB output buffer was safe because the result "was decoupled from stdout" — actually, Node kills the child process outright when that buffer overflows, and codex's JSON mode produces *more* stdout, so the draft would have made long calls (exactly the sweep's calls) fail MORE often than today. The converged version streams the output line-by-line with strict memory caps instead, and the final answer comes from a file codex writes directly — model output can never be mistaken for the result.

Review also killed three quiet disasters. The drift alarm, as drafted, would have fired hourly forever (each firing files an external bug report — that's ~24 spam reports a day, per machine, indefinitely) because today's untagged callsites would keep tripping it; the converged design tags all of them now, so the baseline is zero and any alarm is real — and alarms fire at most once per process. The "which providers can't report usage" exemption list was factually wrong in both directions — it exempted pi (which DOES report usage, so a future pi breakage would have been masked) and missed the interactive pool (which NEVER reports, so the June-15 subscription path would have falsely depressed Claude's coverage number and trained everyone to ignore the tripwire). And the kill-switch's recovery instruction wouldn't have worked on one of the paths most likely to display it; it now has a config lever AND an env lever, both honest everywhere, including when an operator hand-edits the config under pressure and leaves a JSON typo.

Review pressure also turned several soft promises into mechanisms: "the allowlist only shrinks" became a CI test that pins three lists at once; "clean up temp files" became a rate-limited, capped, ownership-verified sweep that can't delete a live call's files and routes through the audited deletion funnel; and that funnel's audit log — which would have ballooned — gained size-capped rotation with marker entries so a shrunken log is explainably rotated, never mysteriously truncated.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, lessons, gemini | ~20 | Full rewrite: spawn streaming replaces execFile; file-only result; usage precedence rule; error-path cost recording; drift tripwires (coverage + event + live canary); kill-switch wiring enumerated; per-call 0700 out-dir; lint hardening; tokens_cached column; registry-entry format; append-only migration reality |
| 2 | security, scalability, adversarial, integration, lessons (gemini clean) | ~17 | Second rewrite: carry-buffer caps + stderr drain; sweep brakes (rate-floor/caps/lstat/in-flight); prompt off argv (stdin); exemptions keyed per provider (pi NOT exempt; interactive-pool exempt); baseline driven to ZERO (no grandfathering); once-per-process degradation emissions; success-only coverage denominator; cached-token subset invariant; env-fallback lever |
| 3 | security, scalability, adversarial, integration, lessons (gemini clean) | ~12 | Consistency pins: settle-at-close (timer never settles) + 5s grace; stdin EPIPE contract; FUNNEL_FILES exemption class (ratchet-pinned); audit-log rotation; presence-count coverage SQL; scan-neutral summary; empty-stream classified as drift; componentCategories registration |
| 4 | scalability, adversarial, integration, lessons (security + gemini clean) | 7 | One-sentence pins: TTL-cached kill-switch closure body; Set removal in finally; TaskClassifier added to violator list; rotation posture; three-list ratchet; close-or-grace wording; corrected migration marker literals |
| 5 | adversarial, integration (security, scalability, lessons, gemini clean) | 3 | Final pins: config-else-env lever precedence (corrupt-config un-strand); re-stat-before-rename rotation; Set delete nesting; tail-truncated line-leading shadow markers; lint self-test for non-funnel files. Violator list independently confirmed complete (full src/ sweep) |
| 6 | (converged) | 0 | none |

## Full Findings Catalog

### Round 1 (initial review — all five internal perspectives + gemini external)

**Security:** (HIGH) last-message file in the cached scratch dir whose reuse branch never re-verifies ownership → fresh per-call 0700 mkdtemp dir. (MED) untrusted model JSONL parsed into the result path → result became file-only; usage parsing line-wise, shape-validated, clamped. (MED) model output persisted to tmp with best-effort cleanup → `finally` cleanup + stale sweep. (LOW) JSONL echoed into error messages → bounded scrubbed stderr tails only. (LOW) lint gamed by empty attribution → literal `component:` rules.

**Scalability:** (HIGH) execFile maxBuffer kills the child under `--json` volume — the spec's "decoupling" claim was factually wrong → spawn + incremental line parsing, O(1) memory. (MED) stream volume profile unpinned → live canary + chatty fixtures. (LOW) scratch file leak on error paths → finally + sweep. Retention confirmed already wired (30d + 6h prune); percentiles deliberately excluded from the new dimension.

**Adversarial:** (HIGH) maxBuffer rationale wrong (same as above, independently). (HIGH) no tripwire when usage parsing rots — the exact regression the spec exists to fix → usageCoverage + drift event + canary. (HIGH) last-one-wins conflates cumulative vs per-turn usage shapes → explicit precedence rule. (MED) error-path token loss (usage in scope but dropped at the funnel) → error rows carry cost; onUsage on reject. (MED) kill-switch stranding (read site unnamed, no off-signal) → live-read + construction log + coverage visibility. (MED) token-weighted unlabeledShare blind to token-blind unlabeled calls → unlabeledCallShare added. (MED) "list only shrinks" was prose → ratchet test. (MED) lexical usage matching forgeable → parse-then-shape-check mandated.

**Integration:** (HIGH) kill-switch had NO wiring path (provider receives no config; six construction sites enumerated) → resolveExecJson closure + per-site threading + `?? true` rule. (MED) apply semantics + per-machine rollback unstated → pinned. (MED) migrateClaudeMd cannot "update" in place (append-only house policy) → appended addendum keyed on a new marker. (MED) STANDARDS-REGISTRY entry format unspecified (silent parse-drop risk) → family/heading/Rule/In-practice/Applied-through pinned. (LOW×7) dark-gate hedge moot; lint-chain wiring; no-new-DDL note; dashboard scope; shadow-mirror; version-skew read-ordering; TokenLedger double-surface note.

**Lessons-aware:** (HIGH) silent usage-parse drift undetectable (L5) → tripwires. (HIGH) foundation flaw: funnel error path drops usage (P18) → fixed in-spec. (MED) 2026-05-26 clean-call hygiene unpinned across the mode switch → five properties enumerated + both-modes test. (MED) false decoupling claim (B6) → corrected. (LOW×5) cached-token blindspot (→ tokens_cached column); dark-gate sentence; allowlist willpower; Close-the-Loop owner; ELI16/frontmatter process.

**Gemini external:** result-extraction fallback fragility (→ file-only, stronger than requested); allowlist friction noted (house convention kept, mechanized).

### Round 2

**Security:** (MED) unbounded memory replaced the old 1MB ceiling (carry buffer + result file) → 2MB carry cap + 16MB stat cap. (MED) sweep deletes prefix-matched names in hostile /tmp unverified, outside SafeFsExecutor → lstat verification + funnel. (MED) repo content in world-readable argv at sweep scale + ARG_MAX → prompt via stdin. (LOW) lint literal edge cases → non-empty-after-trim, case-insensitive reserved name. (flag) sweep age vs long timeouts → 6h threshold.

**Scalability:** (HIGH) chunk-boundary line splitting unspecified — naive split silently drops usage events; carry reintroduces unbounded memory → setEncoding + capped carry + fixtures. (MED) sweep on the hot path unpinned → rate floor + caps. (MED) sweep can delete a live call's dir → in-flight Set + age. (MED) undrained stderr wedges the child on a full pipe → continuous drain + fixture. (LOW) onUsage ordering vs close → pinned (refined again in R3). (note) single-query partition pin.

**Adversarial:** (MED) result semantics diverge between modes (trim; legitimately-empty answers) → trim + empty-exit0-resolves-''. (MED) systematic reconciliation-drop recreates token-blindness with the tripwire never firing → drift = zero usage RECORDED. (MED) coverage denominator noise (error rows) normalizes the tripwire below 1.0 → success-only denominator. (MED) sweep vs live call (independently). (MED) canary fails on weather (auth/rate-limit/network) → skip-vs-fail boundary. (LOW×3) onUsage JSDoc; SafeFs lint; partial-cadence drift (→ divergence oracle).

**Integration:** (HIGH) contract test unsatisfiable for InteractivePoolIntelligenceProvider (never invokes onUsage, framework=claude-code) — June-15 path would depress claude coverage and deafen the tripwire → per-provider exemption keying. (HIGH) unlabeled-llm-call fires perpetually for grandfathered callsites; DegradationReporter files an external bug report per event with no cooldown → baseline-zero + once-per-process gating. (MED) kill-switch recovery instruction false on the crossModelReviewer path → env fallback. (MED) tokensCached semantics unpinned (subset-vs-disjoint; cache creation ~1.25× vs reads ~0.1×) → subset invariant, claude=cache_read only. (LOW×3) reflect.ts signature; unknown-framework bucket; shadow-marker shape.

**Lessons-aware:** (HIGH) exemption list factually wrong in both directions (pi DOES report usage; interactive-pool never does) → corrected. (HIGH) the loop-closer alarm floods its own signal channel (P17; legacy .report() = external feedback per event) → once-per-process + fixed constants. (MED) DegradationReporter API/event-shape visibility cliff → legacy .report() pinned with rationale. (MED) sweep P19 brakes → added. (LOW×3) SafeFsExecutor naming; spawn helper belongs in codexSpawn.ts (2s grace); tokensCached onUsage widening.

**Gemini external:** clean (no material new findings).

### Round 3

**Security:** (MED) stdin EPIPE on the designed loud-fail path = uncaughtException server crash → stdin error contract + fixture. (MED) reject-at-timer-fire contradicts error-rows-carry-cost (independently found by three reviewers) → settle-at-close. (LOW-mat) destructive-ops.jsonl becomes a hot-path log with no rotation → rotation in same PR.

**Scalability:** (MED) usageCoverage uncomputable from the pinned single query (NULL-test ≠ SUM) → presence counts in the same GROUP BY. (LOW-MED) close indefinitely deferred by a held fd → 5s post-exit grace. (LOW-MED) sweep work location + candidate cap → async fire-and-forget + 200-candidate cap. (LOW) summary() can land scan-neutral → DISTINCT scan dropped.

**Adversarial:** (HIGH) settle ordering (independently). (HIGH) empty-allowlist ratchet has no compliant path for the funnel's own forwarders → FUNNEL_FILES exemption class, ratchet-pinned. (MED) exit-0+empty-stream unclassified → drift reason: empty-stream + canary FAIL case. (MED) stdin EPIPE (independently). (LOW-MED) empty-answer file-creation behavior unverified → documented asymmetry, decided + verify-once.

**Integration:** (mat) FUNNEL_FILES (independently, with the verified forwarder list). (verification) baseline-zero feasible — actual violator list produced (7 sites; CoherenceGate/SendGateway/AutoDispatcher exonerated; LLMSanitizer property-assignment caveat). (minor) base section never in shadow mirror; lint-degradation-emit-sites auto-discovers.

**Lessons-aware:** (HIGH) settle ordering (independently; house-pattern citation). (HIGH) FUNNEL_FILES (independently). (MED) destructive-ops rotation (independently, with the forensic-dilution argument). (MED) componentCategories registration missing → required + wiring test. (nit) onModel JSDoc stale for pi.

**Gemini external:** clean.

### Round 4

**Security:** clean (verdict with grounded TOCTOU/sweep/settlement analysis). **Gemini:** clean.
**Scalability:** (mat) kill-switch closure body — in-memory closure can't see a disk flip; per-call loadConfig() drags a synchronous keychain subprocess onto the hot path → TTL-cached single-key raw read. (low) in-flight Set has no removal path → finally + fixture.
**Adversarial:** (mat) TaskClassifier.ts:123 missing from the violator list → added (8 sites).
**Integration:** (mat) `unlabeledShare` sniff literal is a substring of neither real field → re-append-forever; fixed to `unlabeledCallShare`. (mat) base heading exists in 3 divergent variants; single literal skips populations → addressed (refined in R5).
**Lessons-aware:** (mod) rotation race posture + rotation-marker entry → pinned. (low-mod) wiring-test exclusions = third unpinned surface → joins the ratchet. (minor) onUsage locus wording → close-or-grace.

### Round 5

**Security, Scalability, Lessons, Gemini:** clean.
**Adversarial:** (mat) env lever dead on closure-threaded paths + parse-failure→true strands the corrupt-config case → config-when-present-else-env precedence + warn + fixture. (mat) rotation-race loss bound mischaracterized (clobbers the FRESHEST segment) → re-stat-before-rename. (minor) Set delete nesting → pinned. (verification) full src/ sweep independently confirms the violator list complete; parity/smoketest non-funnel files flagged for a lint self-test.
**Integration:** (mat) head-truncated shadow marker is mechanically unsafe (mid-line anchor, body-prose boundary truncation — the addendum itself would be the first victim) → two tail-truncated line-leading literals. (minor) template must emit the sniff literal → pinned.

### Round 6

All reviewers: **NO MATERIAL NEW FINDINGS.** Converged.

## External-reviewer coverage note

GPT-tier and Grok-tier external reviewers could not run: no codex CLI binary is installed on this machine and no OpenAI/xAI API key exists in the vault. Per the skill's abbreviated-convergence provision, the mandatory lessons-aware pass ran in every round, and the Gemini external ran in every round (clean from round 2 onward). The five internal perspectives ran in full every round.

## Convergence verdict

Converged at iteration 6. No material findings in the final round. The spec is ready for user review and approval.
