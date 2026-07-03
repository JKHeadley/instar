/**
 * test-runner-wait-frame — the §2.10 SHIP GATE of the test-runner concurrency
 * bound (spec docs/specs/test-runner-concurrency-bound.md §2.10: "the wait
 * must not read as a hang").
 *
 * An agent /build session blocked in the semaphore globalSetup shows a tmux
 * frame with a once-a-minute wait line. If that frame does NOT satisfy the
 * live silence/load-stall sentinel predicates, the ActiveWorkSilenceSentinel
 * (and the SessionReaper's positive-idle proof, which reads the same
 * `liveActivity` signals) would classify a correctly-waiting run as a hang and
 * re-trigger the exact layer-3 kill cascade this spec exists to close.
 *
 * This test constructs the EXACT wait-line string the globalSetup prints
 * (spinner char + wording extracted from the shipped source, so drift breaks
 * the test loudly) and runs it through the sentinels' ACTUAL predicates:
 *
 *  - looksGeneratingNow()   — the strict live-frame check wired into
 *    ActiveWorkSilenceSentinel's A1 corroboration (sentinelWiring
 *    buildActiveWorkSilenceDeps → looksGeneratingNow);
 *  - looksActivelyWorking() — the broad candidate filter (OutputActivityTracker
 *    marks a non-matching session `paused`);
 *  - every framework's `liveActivity` regex (the SessionReaper's positive-idle
 *    proof reads these directly).
 *
 * If the frame signature does NOT satisfy the predicates, this is the §2.10
 * ship gate failing: the spec then requires the known-blocked registration
 * fallback (NOT built here — the failure is the loud report).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  looksActivelyWorking,
  looksGeneratingNow,
  stripVolatileStatus,
} from '../../src/monitoring/sentinelWiring.js';
import { listActivitySignals } from '../../src/monitoring/frameworkActivitySignals.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GLOBAL_SETUP_PATH = path.join(REPO_ROOT, 'tests/setup/test-runner-semaphore.globalSetup.ts');

/** Extract the shipped WAIT_SPINNER char from the globalSetup source. */
function readGlobalSetupSource(): { source: string; spinner: string } {
  const source = fs.readFileSync(GLOBAL_SETUP_PATH, 'utf-8');
  const m = source.match(/const WAIT_SPINNER = '(.+?)'/);
  if (!m) throw new Error('WAIT_SPINNER constant not found in the globalSetup source');
  return { source, spinner: m[1] };
}

/**
 * Reconstruct the exact wait line the globalSetup prints (template mirrored
 * from the onWaitTick handler; the source-fragment assertions below pin the
 * template so silent drift in the globalSetup breaks THIS reconstruction).
 */
function waitLine(spinner: string, lane: 'suite' | 'targeted', minutes: number): string {
  return (
    `[test-runner-bound] ${spinner} waiting for a ${lane}-lane test slot (${minutes}m elapsed; ` +
    `1 holder(s): pid 4242 age 63s) — active work, not a hang`
  );
}

/** A plausible captured tmux frame around the wait line. */
function frameWith(line: string): string {
  return [
    '$ npx vitest run --config vitest.integration.config.ts',
    '',
    line,
    '',
  ].join('\n');
}

const FRAMEWORKS: Array<IntelligenceFramework | undefined> = [
  undefined,
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'pi-cli',
];

describe('test-runner-bound wait frame vs sentinel predicates (§2.10 SHIP GATE)', () => {
  const { source, spinner } = readGlobalSetupSource();

  it('the globalSetup wait-line template is intact (spinner + wording + stderr)', () => {
    // The reconstruction above is only honest while these fragments hold.
    expect(source).toContain('${WAIT_SPINNER} waiting for a ${lane}-lane test slot');
    expect(source).toContain('— active work, not a hang');
    // The once-a-minute wait line goes to STDERR (§2.6) via line().
    expect(source).toContain("process.stderr.write(`[test-runner-bound] ${msg}\\n`)");
    // The spinner is a Braille glyph — the exact family every framework's
    // activity signals recognize.
    expect(/[⠀-⣿]/.test(spinner), `WAIT_SPINNER ${JSON.stringify(spinner)} is not a Braille glyph`).toBe(true);
  });

  it('the wait line satisfies looksGeneratingNow (ActiveWorkSilenceSentinel A1 live-frame check) for every framework', () => {
    for (const lane of ['suite', 'targeted'] as const) {
      const frame = frameWith(waitLine(spinner, lane, 3));
      for (const fw of FRAMEWORKS) {
        expect(
          looksGeneratingNow(frame, fw),
          `SHIP GATE §2.10: the ${lane}-lane wait frame does NOT satisfy looksGeneratingNow for ` +
            `framework=${fw ?? 'default'} — a waiting run reads as a hang; the spec requires the ` +
            `known-blocked registration fallback (report, do not ship on the indicator)`,
        ).toBe(true);
      }
    }
  });

  it('the wait line satisfies looksActivelyWorking (OutputActivityTracker candidate filter) for every framework', () => {
    const frame = frameWith(waitLine(spinner, 'suite', 3));
    for (const fw of FRAMEWORKS) {
      expect(
        looksActivelyWorking(frame, fw),
        `SHIP GATE §2.10: the wait frame does NOT satisfy looksActivelyWorking for framework=${fw ?? 'default'}`,
      ).toBe(true);
    }
  });

  it("the spinner char is in every framework's liveActivity indicator set (SessionReaper positive-idle proof)", () => {
    for (const { framework, signal } of listActivitySignals()) {
      expect(
        signal.liveActivity.test(spinner),
        `SHIP GATE §2.10: framework ${framework} liveActivity does not recognize the WAIT_SPINNER glyph`,
      ).toBe(true);
      expect(signal.liveActivity.test(waitLine(spinner, 'suite', 3))).toBe(true);
    }
  });

  it('the spinner glyph is the load-bearing indicator (predicate match is not vacuous)', () => {
    // Strip ONLY the spinner: the remaining wording must NOT satisfy the
    // strict live predicate — proving the match above comes from the glyph
    // the globalSetup deliberately carries, not from incidental words.
    const noSpinner = frameWith(
      waitLine(spinner, 'suite', 3).replace(`${spinner} `, ''),
    );
    for (const fw of FRAMEWORKS) {
      expect(
        looksGeneratingNow(noSpinner, fw),
        `wait-line wording alone satisfies looksGeneratingNow for framework=${fw ?? 'default'} — ` +
          `the spinner assertion is vacuous`,
      ).toBe(false);
    }
  });

  it('consecutive wait lines register as REAL frame changes under stripVolatileStatus (no frozen-indicator misread)', () => {
    // OutputActivityTracker hashes a spinner-immune view (stripVolatileStatus)
    // to detect real output changes. The once-a-minute wait line's elapsed
    // minutes must SURVIVE stripping so minute N and minute N+1 hash apart —
    // a waiting session keeps registering as producing output, and the A5
    // frozen-indicator backstop (byte-identical frame for 90m) never fires on
    // a healthy wait.
    for (const fw of FRAMEWORKS) {
      const a = stripVolatileStatus(frameWith(waitLine(spinner, 'suite', 3)), fw);
      const b = stripVolatileStatus(frameWith(waitLine(spinner, 'suite', 4)), fw);
      expect(a.trim().length, 'stripVolatileStatus erased the wait line entirely').toBeGreaterThan(0);
      expect(a, `minute-3 and minute-4 wait frames hash identically for framework=${fw ?? 'default'}`).not.toBe(b);
    }
  });
});
