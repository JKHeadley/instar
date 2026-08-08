# Phase B tautology sweep

Control outcome: PASS. The sweep found both known cases:
- `tests/unit/keyword-intent-decision-ratchet.test.ts:250` has `expect(Array.isArray(dead)).toBe(true)`.
- `tests/unit/provenance-coverage-ratchet.test.ts:967` has `expect(true).toBe(true)`.

Files swept: 2,248 files matching `tests/unit/*.ts` recursively under `tests/unit`.

Counts by category, counted by flagged test block:
- A tautological / shape-only assertion blocks: 11
- B computed finding only logged / not asserted blocks: 2
- C vacuous-when-empty loop blocks: 5
- D skipped blocks: 1

Notes:
- I did not count `describe.skipIf(...)` / `it.skipIf(...)` as Category D because the requested skipped forms were unconditional `it.skip`, `describe.skip`, `xit`, and commented-out tests. Conditional skips found by grep were environment/live-test gates.
- I dropped repeated-call determinism checks such as `expect(fn(input)).toBe(fn(input))`; those can fail if the implementation is impure, so I did not treat them as self-comparisons.
- I dropped shape assertions when the same block also asserts concrete content, lengths, status codes, or behavior.

## Category A: tautological / shape-only assertion blocks

1. `tests/unit/AgentTrustManager-fingerprint.test.ts:148`
   - Test: `returns empty array for unknown fingerprint (untrusted)`
   - Quote: `expect(Array.isArray(ops)).toBe(true)`
   - Broken input that still passes: `getAllowedOperationsByFingerprint('unknown-fp')` could return `['sendMessage']` for an unknown fingerprint. The test title promises an empty array, but any array passes.

2. `tests/unit/AgentTrustManager-fingerprint.test.ts:155`
   - Test: `returns operations based on trust level`
   - Quote: `expect(Array.isArray(ops)).toBe(true)`
   - Broken input that still passes: the implementation could return the same empty array for `verified`, `trusted`, and `untrusted` agents. The test still passes because it only checks array-ness.

3. `tests/unit/CoherenceGate.test.ts:516`
   - Test: `reads and caches AGENT.md Intent section`
   - Quote: `expect(true).toBe(true)`
   - Broken input that still passes: `evaluate()` could ignore `AGENT.md` entirely and never cache the Intent section. The unconditional assertion still passes.

4. `tests/unit/PostUpdateMigrator-parityRenderings.test.ts:275`
   - Test: `migrateAsync wraps sync migrate() + async backfill`
   - Quotes:
     - `expect(Array.isArray(result.upgraded)).toBe(true)`
     - `expect(Array.isArray(result.skipped)).toBe(true)`
     - `expect(Array.isArray(result.errors)).toBe(true)`
   - Broken input that still passes: `migrateAsync()` could skip the sync migration and async backfill completely while returning `{ upgraded: [], skipped: [], errors: [] }`.

5. `tests/unit/RelationshipManager.test.ts:681`
   - Test: `marks LLM-confirmed duplicates`
   - Quote: `expect(Array.isArray(results)).toBe(true)`
   - Broken input that still passes: `findDuplicatesAsync()` could never call the LLM and return `[]`, or return unconfirmed duplicate rows, and this block would still pass.

6. `tests/unit/activity-partitioner.test.ts:530`
   - Test: `uses default config when none provided`
   - Quote: `expect(Array.isArray(units)).toBe(true)`
   - Broken input that still passes: default configuration could be ignored and `partition()` could always return `[]`; the test only checks that the return value is an array.

7. `tests/unit/keyword-intent-decision-ratchet.test.ts:250`
   - Test: `no allowlist entry is dead weight (each allowlisted file is actually flagged)`
   - Quote: `expect(Array.isArray(dead)).toBe(true)`
   - Broken input that still passes: `dead` could contain every allowlist entry because none are still flagged. The test logs the dead entries but still passes.

8. `tests/unit/provenance-coverage-ratchet.test.ts:967`
   - Test: `logs per-component callsite-count vs declared-decision-point mismatches (non-blocking)`
   - Quote: `expect(true).toBe(true)`
   - Broken input that still passes: `drift` could contain undeclared provenance callsites or count mismatches. The unconditional assertion still passes.

9. `tests/unit/session-activity-sentinel.test.ts:433`
   - Test: `handles completely invalid JSON gracefully`
   - Quote: `expect(Array.isArray(digests)).toBe(true)`
   - Broken input that still passes: invalid JSON could produce fabricated digest entries instead of an empty digest list. Any array passes.

10. `tests/unit/threadline/SessionLifecycle.test.ts:165`
    - Test: `returns failure when cannot park to make room`
    - Quote: `expect(true).toBe(true)`
    - Broken input that still passes: `activate()` could incorrectly succeed in the degenerate no-room path. The block never exercises the path and ends with an unconditional pass.

11. `tests/unit/ThreadlineMCPServer-relay.test.ts:283`
    - Test: `produces a comprehensive explanation text`
    - Quote: `expect(typeof keyword).toBe('string')`
    - Broken input that still passes: the actual MCP explanation text could omit every listed concept. The block only iterates a literal string list and asserts each literal is a string.

## Category B: computed finding only logged / not asserted

1. `tests/unit/keyword-intent-decision-ratchet.test.ts:247`
   - Test: `no allowlist entry is dead weight (each allowlisted file is actually flagged)`
   - Quote: `console.warn(\`\n[keyword-intent] allowlist entries no longer flagged (prune them):\n  ${dead.join('\n  ')}\n\`)`
   - Broken input that still passes: `dead` could be non-empty because allowlist entries no longer correspond to flagged files. The test only warns and then asserts `Array.isArray(dead)`.

2. `tests/unit/provenance-coverage-ratchet.test.ts:962`
   - Test: `logs per-component callsite-count vs declared-decision-point mismatches (non-blocking)`
   - Quote: `console.log(\`[provenance-census] INFORMATIONAL declared-vs-discovered drift (${drift.length} component(s)):\n  \` + drift.sort().join('\n  '))`
   - Broken input that still passes: `drift` could include undeclared callsites or declared/discovered count mismatches. The test only logs and then asserts `true`.

## Category C: vacuous-when-empty loop blocks

1. `tests/unit/RelationshipManager.test.ts:664`
   - Test: `confirms duplicates via LLM`
   - Quote: `expect(typeof r.confirmed).toBe('boolean')`
   - Broken input that still passes: the block comments say `findDuplicatesAsync()` will return empty for these records. If no duplicate rows are returned, the loop body never runs and no confirmation behavior is asserted.

2. `tests/unit/RelationshipManager.test.ts:714`
   - Test: `findDuplicatesAsync returns unconfirmed results`
   - Quote: `expect(r.confirmed).toBe(false)`
   - Broken input that still passes: `findDuplicatesAsync()` can return `[]` with no intelligence provider. The loop never checks an unconfirmed duplicate row.

3. `tests/unit/ReflectionConsolidator.test.ts:335`
   - Test: `dry-run proposals have DRY- prefix IDs`
   - Quote: `expect(p.id).toMatch(/^DRY-/)`
   - Broken input that still passes: `consolidate({ commit: false })` could create no proposals at all. The prefix assertion never executes.

4. `tests/unit/Prerequisites.test.ts:55`
   - Test: `provides install hints for all results`
   - Quote: `expect(m.installHint.length).toBeGreaterThan(0)`
   - Broken input that still passes: on a machine with no missing prerequisites, `result.missing` is empty, so the loop never checks install hints. The title says all results, but the loop only covers missing results.

5. `tests/unit/activity-partitioner.test.ts:384`
   - Test: `filters out units with too few Telegram messages and short duration`
   - Quote: `expect(isLongEnough || hasEnoughContent || hasEnoughMessages).toBe(true)`
   - Broken input that still passes: `partition()` could return an empty array for every input, including inputs that should produce a unit. This block would still pass because the assertion only runs for returned units.

## Category D: skipped blocks

1. `tests/unit/atomic-writes-consistency.test.ts:36`
   - Quote: `it.skip(\`${mod.file} not found\`, () => {});`
   - Broken input that still passes: if a state-writing module listed in `STATE_WRITING_MODULES` is absent, the atomic-write requirement for that module is skipped rather than failed.
