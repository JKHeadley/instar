# PROP-1188 — Dated test quarantine: every excluded test carries a reason and a review date the config loader enforces

Filed by Dawn's `instar-feature-parity` job (AUT-12775-wo, 2026-09-24). Docs-only hand-off; land it through `/instar-dev` + `/spec-converge`.

## Problem

`vitest.push.config.ts` excludes tests through a plain `FLAKY_TESTS` string array. On `origin/main` (4068f18b7, v1.3.861) it holds **93 paths**, three of them globs covering the whole Threadline suite (`tests/{unit,integration,e2e}/threadline/**`).

The file's header says these "still run with `npm test` (full suite) and should be periodically reviewed". CI does not run the full suite, though. `.github/workflows/ci.yml:126` runs `npm run test:push -- --shard=N/4`. So every listed file is a guard that cannot fail in CI. Nothing records when a file was parked, and nothing brings it back.

The same file already records what this costs, in its own comments:

- **ESM compliance** was parked here, and "3 latent bare-require() bugs reach main" (reflect.ts, SessionWatchdog.ts, PostUpdateMigrator.ts). It was re-armed 2026-06-03 (#734).
- **security.test.ts + feature-delivery-completeness.test.ts** were mislabelled "environment-dependent" and "rotted while parked". A bare `execSync` reached `src/monitoring/mcpProcessReaperDeps.ts`, and the coordination-mandate capability family shipped with no parity-guard tracking. Both were re-armed 2026-06-05 (#837).
- **no-silent-fallbacks** had been misfiled in the sqlite section. Its baseline had drifted from 186 to a real count of 431 while it was parked.

Each rescue came from someone happening to look. The comment's own words are "a parked gate is no gate". A reminder to "review periodically" asks people to remember. A config that won't load without a review date doesn't depend on anyone remembering.

Dawn hit the same class on 2026-09-23. A `knownGap` suppression in her served-experience regression suite had no expiry. Six probes were silenced, five of them were already green, and two printed a plain PASS with the suppression invisible. One suppression was written 22 minutes before the fix for the bug it described shipped, and it stayed on anyway. Her fix was a suppression that can't be created without a review date. It stays in force past that date but is printed on every run. It never starts blocking by itself.

Several entries show why this matters for Instar right now. `tests/unit/message-formatter.test.ts` ("code now uses threadline MCP") and `tests/unit/slack-stall-active-gate.test.ts` ("feature not yet implemented") are not flakes. They are stale contracts or stubs that should be deleted or rewritten. At least 20 entries are a `better-sqlite3` NODE_MODULE_VERSION mismatch "on this machine", which is a local build problem and not a CI one. With no dates, none of them ever gets looked at again.

## Proposed change

1. Add `tests/setup/test-quarantine.ts`, which exports `evaluateQuarantine(entries, now)`:
   - It **throws** (the config won't load, so CI goes red) if an entry has no reason (under 10 characters), has no date or a bad `YYYY-MM-DD` date, has a `reviewBy` more than 90 days out, or is a duplicate. It reports every problem at once.
   - A **past-due** entry stays excluded but is listed as OVERDUE on every run. It never starts blocking by itself, because a real flake that fails CI at random tends to get deleted, not fixed.
   - It prints `[quarantine] N test path(s) excluded — these guards cannot fail in this run.` on every run, so whoever is shipping can see the list of disarmed guards.
2. Convert `FLAKY_TESTS` into `QuarantineEntry[]` (path, reason, reviewBy). Keep the existing section comments as each entry's `reason`.
3. Fix the header comment. The claim that these "still run with npm test" is misleading, because CI runs only `test:push`.

### Patch — new file `tests/setup/test-quarantine.ts`

```ts
/**
 * Test quarantine ledger — every excluded test carries a reason and a
 * review date, and the date is enforced by the config loader itself.
 *
 * Why: the push-suite exclude list is what CI runs, so an excluded file is
 * a guard that cannot fail. Undated exclusions never come back — the ESM
 * and security/delivery-completeness gates both rotted while parked
 * (re-armed 2026-06-03 / 2026-06-05). A documented "review periodically"
 * is a convention; a loader that refuses an undated entry is structure.
 *
 * Semantics:
 *   - missing/invalid reason or reviewBy        → throw (config won't load)
 *   - reviewBy more than MAX_HORIZON_DAYS ahead → throw (no eternal muzzles)
 *   - reviewBy in the past                      → still excluded, but listed
 *     loudly on every run as OVERDUE. Never auto-blocks: a real flake that
 *     fails CI at random gets deleted, not fixed.
 */
export interface QuarantineEntry {
  path: string;
  reason: string;
  /** ISO date (YYYY-MM-DD) by which someone re-runs it and re-arms or re-dates it. */
  reviewBy: string;
}

export const MAX_HORIZON_DAYS = 90;
const DAY_MS = 86_400_000;

export interface QuarantineReport {
  exclude: string[];
  overdue: QuarantineEntry[];
  summary: string;
}

export function evaluateQuarantine(
  entries: QuarantineEntry[],
  now: Date = new Date(),
): QuarantineReport {
  const problems: string[] = [];
  const seen = new Set<string>();
  const overdue: QuarantineEntry[] = [];
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  for (const e of entries) {
    if (!e.path) problems.push('entry with empty path');
    if (seen.has(e.path)) problems.push(`${e.path}: listed twice`);
    seen.add(e.path);
    if (!e.reason || e.reason.trim().length < 10) {
      problems.push(`${e.path}: reason missing or under 10 chars`);
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.reviewBy ?? '');
    const due = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
    if (Number.isNaN(due)) {
      problems.push(`${e.path}: reviewBy "${e.reviewBy}" is not YYYY-MM-DD`);
      continue;
    }
    if (due - today > MAX_HORIZON_DAYS * DAY_MS) {
      problems.push(`${e.path}: reviewBy ${e.reviewBy} is more than ${MAX_HORIZON_DAYS} days out`);
    }
    if (due < today) overdue.push(e);
  }

  if (problems.length > 0) {
    throw new Error(`Test quarantine ledger is invalid:\n  - ${problems.join('\n  - ')}`);
  }

  const lines = [`[quarantine] ${entries.length} test path(s) excluded — these guards cannot fail in this run.`];
  if (overdue.length > 0) {
    lines.push(`[quarantine] ${overdue.length} OVERDUE for review (re-run, then re-arm or re-date with a reason):`);
    for (const e of overdue) lines.push(`  - ${e.path} (due ${e.reviewBy}) — ${e.reason}`);
  }
  return { exclude: entries.map((e) => e.path), overdue, summary: lines.join('\n') };
}
```

### Patch — new file `tests/unit/test-quarantine.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { evaluateQuarantine, type QuarantineEntry } from '../setup/test-quarantine.js';

const NOW = new Date('2026-09-24T12:00:00Z');
const ok = (o: Partial<QuarantineEntry> = {}): QuarantineEntry => ({
  path: 'tests/unit/a.test.ts', reason: 'supertest port collision', reviewBy: '2026-10-15', ...o,
});

describe('evaluateQuarantine', () => {
  it('passes a dated, reasoned entry through to exclude', () => {
    const r = evaluateQuarantine([ok()], NOW);
    expect(r.exclude).toEqual(['tests/unit/a.test.ts']);
    expect(r.overdue).toEqual([]);
    expect(r.summary).toContain('1 test path(s) excluded');
  });
  it('refuses an undated entry', () => {
    expect(() => evaluateQuarantine([ok({ reviewBy: '' })], NOW)).toThrow(/not YYYY-MM-DD/);
  });
  it('refuses a malformed date', () => {
    expect(() => evaluateQuarantine([ok({ reviewBy: '2026-13-45x' })], NOW)).toThrow(/not YYYY-MM-DD/);
  });
  it('refuses a missing reason', () => {
    expect(() => evaluateQuarantine([ok({ reason: 'flaky' })], NOW)).toThrow(/reason missing/);
  });
  it('refuses a date beyond the horizon', () => {
    expect(() => evaluateQuarantine([ok({ reviewBy: '2027-06-01' })], NOW)).toThrow(/more than 90 days/);
  });
  it('refuses duplicates', () => {
    expect(() => evaluateQuarantine([ok(), ok()], NOW)).toThrow(/listed twice/);
  });
  it('keeps an overdue entry excluded but lists it loudly', () => {
    const r = evaluateQuarantine([ok({ reviewBy: '2026-09-01' })], NOW);
    expect(r.exclude).toEqual(['tests/unit/a.test.ts']);
    expect(r.overdue).toHaveLength(1);
    expect(r.summary).toMatch(/1 OVERDUE[\s\S]*due 2026-09-01/);
  });
  it('treats a due date of today as not yet overdue', () => {
    expect(evaluateQuarantine([ok({ reviewBy: '2026-09-24' })], NOW).overdue).toEqual([]);
  });
  it('reports every problem at once, not just the first', () => {
    expect(() => evaluateQuarantine([ok({ reason: '' }), ok({ path: 'b', reviewBy: 'x' })], NOW))
      .toThrow(/reason missing[\s\S]*not YYYY-MM-DD/);
  });
});
```

### Patch — `vitest.push.config.ts` (shape; apply to all 93 entries)

```diff
- * These tests still run with `npm test` (full suite) and should be
- * periodically reviewed. If a test is stabilized, remove it from the
- * exclude list.
+ * CI runs ONLY this config (ci.yml → `npm run test:push`), so every entry
+ * below is a guard that cannot fail in CI. Each entry carries a reason and
+ * a reviewBy date (≤90 days out); the loader refuses undated entries and
+ * lists overdue ones on every run. On review: re-run the file — green →
+ * delete the entry; still red → fix, or re-date with a sharper reason;
+ * stale contract (e.g. feature removed) → delete the test.
  */
 import { defineConfig } from 'vitest/config';
 
 import { withTestRunnerBound } from './tests/setup/test-runner-bound.config-eval.js';
+import { evaluateQuarantine, type QuarantineEntry } from './tests/setup/test-quarantine.js';
 
-const FLAKY_TESTS = [
+// Initial dating: stagger reviewBy across the next 4–8 weeks so review
+// arrives in batches, not all 93 on one day.
+const QUARANTINE: QuarantineEntry[] = [
   // ── Supertest timeouts / port collisions ──────────────────────────
-  'tests/integration/scope-coherence-routes.test.ts',
+  { path: 'tests/integration/scope-coherence-routes.test.ts', reason: 'supertest timeout / port collision', reviewBy: '2026-10-22' },
   ...
   // ── Test expects /msg reply format, code now uses threadline MCP ──
-  'tests/unit/message-formatter.test.ts',
+  { path: 'tests/unit/message-formatter.test.ts', reason: 'asserts /msg format; code now uses threadline MCP — stale contract, rewrite or delete', reviewBy: '2026-10-08' },
   ...
   // ── Test-first stubs (feature not yet implemented) ────────────────
-  'tests/unit/slack-stall-active-gate.test.ts',
+  { path: 'tests/unit/slack-stall-active-gate.test.ts', reason: 'test-first stub, feature unimplemented since 2026-04-10 — build or delete', reviewBy: '2026-10-08' },
 ];
 
+const quarantine = evaluateQuarantine(QUARANTINE);
+console.warn(quarantine.summary);
+
 export default defineConfig(withTestRunnerBound('push', {
   test: {
     include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
-    exclude: FLAKY_TESTS,
+    exclude: quarantine.exclude,
```

The 93-row conversion is mechanical: each section comment becomes its entries' `reason`. It is left to `/instar-dev` so the dates can be chosen with knowledge of what is being worked on.

## Test evidence

Run in an isolated scratch tree that uses instar-main's own `node_modules` (vitest + tsc):

- `vitest run tests/unit/test-quarantine.test.ts`: **9/9 pass**. Covers pass-through, undated, malformed date, short reason, beyond-horizon, duplicate, overdue-still-excluded-and-listed, due-today-not-overdue, and all-problems-reported.
- **Can the suite fail?** Changing `due < today` to `due <= today` turns one test red (`treats a due date of today as not yet overdue`: 1 failed / 8 passed). Reverting it gives 9/9 again.
- `tsc --noEmit --strict --module nodenext --target es2022` on both files: **clean**, with no output.
- **Not run:** the converted `vitest.push.config.ts` against the full push suite. That depends on the 93-row conversion, which is `/instar-dev`'s part.

## Files touched

- `tests/setup/test-quarantine.ts` (new): the validator and summary.
- `tests/unit/test-quarantine.test.ts` (new): 9 tests.
- `vitest.push.config.ts`: `string[]` becomes `QuarantineEntry[]`, it calls `evaluateQuarantine`, and the misleading header is fixed.

## Adoption steps for /instar-dev

1. Open a spec (`docs/specs/test-quarantine-ledger.md`) from this PROP and run `/spec-converge`. The open questions are the 90-day horizon, whether OVERDUE entries should also post to the attention queue, and whether `vitest.config.ts` should share the ledger.
2. Add the two new files. Convert the 93 entries using real reasons, and delete the ones that are stale contracts rather than flakes.
3. Run `npm run test:push` locally and confirm the `[quarantine]` summary prints. Put a deliberately undated entry in and confirm the config refuses to load, then take it out.
4. Produce the trace and side-effects artifact through `/instar-dev`, then commit through the normal gate. `tests/**` and the root config are outside the pre-commit gate's `src/`/`skills/`/`.husky/` scope, so the spec is the main governance step here.
