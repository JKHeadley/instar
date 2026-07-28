# Round 2 — Synthesis (convergence check on the rewritten spec)

Externals: codex gpt-5.5 = MINOR (was SERIOUS R1), gemini 2.5-pro = MINOR.
Converged lenses: decision-completeness (0 user-decisions parked), lessons-aware (0 new material, §6.5 airtight, §6.4 = legit caller-handled).
Conformance R2: 1 finding (No Deferrals → §6.4 garbage-output: resolved as caller-handled, not a deferral).

## NEW material (must fix → round 3)
- **N1 (security HIGH + codex#1) — §4.5 orphaned promise + subprocess.** The per-attempt timeout abandons `tp.evaluate()`; its later rejection hits the fail-toward-crash unhandledRejection policy (uncaughtExceptionPolicy.ts:174 — CLI error shapes not allowlisted) → server crash mid-outage. AND a racing timeout leaves a CLI SUBPROCESS running (quota/CPU/late-logs). FIX: `.catch(()=>{})` the abandoned promise + clear/`unref()` the timer; pass an AbortSignal so a timed-out attempt actually kills the subprocess where supported, else swallow the late result + accept the bounded orphan; regression test.
- **N4 (integration MEDIUM) — §8 migration is a no-op + leaves stale-wrong text.** migrateClaudeMd sniff on "Per-Component Framework Routing" matches the EXISTING heading on every agent → migration does nothing; and the OLD template text ("routing is opt-in"; "rate-limited → heuristic, no herd") becomes FALSE. FIX: migrateClaudeMd sniffs a NEW marker (e.g. "run off Claude by default"/"INTERNAL_FRAMEWORK_PREFERENCE") + APPENDS a corrective subsection; generateClaudeMd EDITS the opt-in/heuristic sentences for new agents. §8 names both halves.

## Prose / precision (fold in)
- **N2 (scalability+adversarial) — §4.5 bound basis wrong.** The per-attempt CAP is the universal ceiling (NOT "caller budget" — only 1/7 callers has one; tone-gate budget = 20s OUTBOUND_GATE_REVIEW_BUDGET_MS, not 5s). The cap RACES and thus DOMINATES the provider's inner 120s rateLimitWaitMs (acquireOrWait in CircuitBreakingIntelligenceProvider). total = cap × (1+tailLen), 20s route budget = outer ceiling. Drop the false "5s caller budget" claim + the non-existent `gateTimeoutMs` constant (use a literal/named real const).
- **N3 (adversarial+lessons) — §6.4 relabel.** "scoped OUT/deferred" → "CALLER-HANDLED": MessagingToneGate.parseResponse fail-opens on malformed JSON + validates the B1..B20 rule allowlist; MessageSentinel try/catch fail-opens. Only residual = well-formed-but-semantically-wrong (pre-existing LLM-gate property). Optionally a <!-- tracked --> follow-up commitment for hygiene.
- **N5 (scalability) — §4.2 probe shares router cache.** active-probe via buildProvider must reuse providerFor's `this.cache` (don't double-build).
- **N6 (security) — §4.4 ordering contract.** Restate "RAW on-disk value" as: snapshot the in-memory componentFrameworks at the construction site (server.ts:4687, runs BEFORE CartographerSweep auto-vivify at 11266); loadConfig copies by reference (no separate raw object).
- **N7 (codex#2) — §4.2 buildProvider side-effect contract.** State buildProvider must be idempotent / non-networking / non-spawning (minimal CLI detection), safe once at boot — or define canBuildProvider.
- **N8 (codex#3) — §4.4 boot-snapshot vs live-read.** Clarify: boot decides default-vs-operator-config (a post-boot ADD of componentFrameworks needs a restart, consistent with §4.3 boot-primary); contents of an already-set operator block are live-read. Document honestly.
- **N9 (gemini) — operator examples.** §8 add concrete examples: explicit block vs default interaction + the `{}` rollback.
