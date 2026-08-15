/**
 * Atomic writes consistency test — verifies the declared state-writing modules
 * use the write-to-tmp-then-rename pattern, so a crash mid-write cannot leave a
 * truncated state file behind.
 *
 * WHAT CHANGED AND WHY (2026-08-15)
 * ---------------------------------
 * The previous version could not fail on its own subject. Measured, not argued:
 * a bare `fs.writeFileSync` of durable session state inserted into `saveSession`
 * — a DECLARED method of a DECLARED module — passed all 21 assertions.
 *
 * Three causes, each fixed here:
 *
 *  1. SCOPING. `inSaveMethod` was set when a method NAME appeared and never
 *     reset, while `hasWriteFile`/`hasRename` were re-zeroed at each occurrence.
 *     Only the window from the LAST name mention to EOF survived to the
 *     assertion — 125 of 617 lines in StateManager.ts, leaving three of its four
 *     declared methods unreachable. Bodies are now brace-matched per method.
 *
 *  2. FILE-SCOPE SUBSTRING CHECKS. `source.includes('renameSync')` and
 *     `source.includes('.tmp')` are satisfied by one occurrence anywhere in the
 *     file — including a comment — however many bare writes sit elsewhere.
 *     Pairing is now per body.
 *
 *  3. SILENT DECLARATION ROT. A missing file was `it.skip`ped and a missing
 *     method simply never set the flag, so a renamed method dropped out of
 *     coverage without a sound. Both are failures now — and enabling that check
 *     immediately found two: `StateManager.saveState` and `QuotaTracker.saveState`
 *     have ZERO occurrences in their files. QuotaTracker's real writer,
 *     `updateState()`, is atomic and had never been verified by this test.
 *
 * DELEGATION. StateManager funnels every write through a private `atomicWrite()`.
 * Under a naive per-method rule its declared methods contain no write call at all
 * and would pass trivially. One level of `this.helper()` delegation is resolved so
 * the funnel itself is what gets verified.
 *
 * POPULATION — declared openly rather than implied: the module list below is
 * CURATED and holds 7 entries. Hundreds of files under `src/` call
 * `writeFileSync`, and this test says nothing about any of them. Widening the
 * population is real work with real over-block risk and is NOT done here.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyMethod } from '../helpers/atomicWriteScope.js';

const SRC_ROOT = path.join(process.cwd(), 'src');

/** Modules that persist durable state and MUST use atomic writes. */
const STATE_WRITING_MODULES = [
  { file: 'core/StateManager.ts', methods: ['saveSession', 'saveJobState', 'appendEvent'] },
  { file: 'core/RelationshipManager.ts', methods: ['save'] },
  { file: 'core/FeedbackManager.ts', methods: ['saveFeedback'] },
  { file: 'core/UpdateChecker.ts', methods: ['saveState'] },
  { file: 'users/UserManager.ts', methods: ['persistUsers'] },
  { file: 'monitoring/QuotaTracker.ts', methods: ['updateState'] },
  { file: 'messaging/TelegramAdapter.ts', methods: ['saveRegistry'] },
];

describe('Atomic writes consistency', () => {
  for (const mod of STATE_WRITING_MODULES) {
    describe(mod.file, () => {
      const absolute = path.join(SRC_ROOT, mod.file);
      const source = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf-8') : null;

      it('the declared module exists', () => {
        // A missing file used to `it.skip`, so a moved module left coverage
        // silently. Absence is a finding, not a reason to say nothing.
        expect(source, `${mod.file} is declared here but not present under src/`).not.toBeNull();
      });

      if (!source) return;

      for (const method of mod.methods) {
        const result = classifyMethod(source, method);

        it(`declares ${method}()`, () => {
          expect(
            result.found,
            `${mod.file} declares no ${method}() — the declaration is stale, and a stale ` +
              `declaration checks nothing while looking like coverage`
          ).toBe(true);
        });

        it(`${method}() writes atomically`, () => {
          expect(
            result.verdict,
            `${mod.file}#${method} performs a write with no renameSync on the same body ` +
              `(deciding body: ${result.via ?? 'n/a'}, line ${result.line ?? '?'}). ` +
              `A crash between write and rename leaves a truncated state file.`
          ).not.toBe('non-atomic');
        });
      }

      it('at least one declared method actually reaches a write', () => {
        // ANTI-VACUITY. If every declared method resolves to `no-write`, this
        // module has coverage in name only — the shape of failure this whole
        // rewrite exists to remove.
        const verdicts = mod.methods.map((m) => classifyMethod(source, m).verdict);
        expect(
          verdicts.some((v) => v === 'atomic-inline' || v === 'atomic-via-funnel' || v === 'non-atomic'),
          `no declared method of ${mod.file} resolves to a write path — the declarations are ` +
            `pointing at methods that do not persist anything`
        ).toBe(true);
      });
    });
  }
});
