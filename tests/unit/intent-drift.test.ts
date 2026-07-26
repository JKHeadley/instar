/**
 * Unit tests for `instar intent drift` CLI command.
 *
 * Tests cover:
 * - Shows analysis with formatted output
 * - Handles empty journal gracefully
 * - Respects --window option
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../../src/core/Config.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Mock loadConfig to avoid dependency on tmux/Claude CLI being installed (CI)
vi.mock('../../src/core/Config.js', () => ({
  loadConfig: vi.fn(),
}));

/** Generate a timestamp N days ago from now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('intent drift', () => {
  let tmpDir: string;
  let stateDir: string;
  let originalExit: typeof process.exit;
  let consoleLogs: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-cli-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });

    vi.mocked(loadConfig).mockReturnValue({
      projectName: 'test-project',
      projectDir: tmpDir,
      stateDir,
    } as any);

    consoleLogs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      consoleLogs.push(args.map(String).join(' '));
    });

    originalExit = process.exit;
    process.exit = vi.fn() as any;
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/intent-drift.test.ts:56' });
  });

  it('shows empty journal message when no entries exist', async () => {
    const { intentDrift } = await import('../../src/commands/intent.js');
    await intentDrift({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    expect(output).toContain('No decision journal entries found');
  });

  it('shows analysis with formatted output when journal has entries', async () => {
    // Create entries spanning both windows
    const entries = [
      // Previous window (15-28 days ago)
      ...Array.from({ length: 5 }, (_, i) => ({
        timestamp: daysAgo(15 + i),
        sessionId: `prev-${i}`,
        decision: `Previous decision ${i}`,
        principle: 'safety',
        confidence: 0.85,
      })),
      // Current window (1-13 days ago)
      ...Array.from({ length: 8 }, (_, i) => ({
        timestamp: daysAgo(1 + i),
        sessionId: `curr-${i}`,
        decision: `Current decision ${i}`,
        principle: 'safety',
        confidence: 0.8,
        conflict: i === 0,
      })),
    ];

    fs.writeFileSync(
      path.join(stateDir, 'decision-journal.jsonl'),
      entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    );

    const { intentDrift } = await import('../../src/commands/intent.js');
    await intentDrift({ dir: tmpDir });

    const output = consoleLogs.join('\n');

    // Check key output sections
    expect(output).toContain('Intent Drift Analysis');
    expect(output).toContain('test-project');
    expect(output).toContain('Current Period');
    expect(output).toContain('Decisions');
    expect(output).toContain('Conflict Rate');
    expect(output).toContain('Drift Score');
    expect(output).toContain('Alignment Score');
    expect(output).toContain('Conflict Freedom');
    expect(output).toContain('Confidence Level');
    expect(output).toContain('Principle Consistency');
    expect(output).toContain('Journal Health');
  });

  it('respects --window option', async () => {
    // Create entries for a 7-day window test
    const entries = Array.from({ length: 10 }, (_, i) => ({
      timestamp: daysAgo(i + 1),
      sessionId: `s${i}`,
      decision: `Decision ${i}`,
      principle: 'safety',
      confidence: 0.8,
    }));

    fs.writeFileSync(
      path.join(stateDir, 'decision-journal.jsonl'),
      entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    );

    const { intentDrift } = await import('../../src/commands/intent.js');
    await intentDrift({ dir: tmpDir, window: 7 });

    const output = consoleLogs.join('\n');
    // Should mention the 7-day window
    expect(output).toContain('7');
    expect(output).toContain('days');
  });

  // ── Alignment rendering: the surface where absence was invisible ──────
  //
  // WHY THESE EXIST. `alignmentScore()` returning 'N/A' + assessable:false is
  // worth nothing if the command that renders it ignores those fields. I broke
  // the CLI's honest branch on purpose and all 28 module/route tests still
  // passed — the third time in one night that logic was guarded while the
  // wiring to a human-facing surface was not. These assert the RENDERING.

  it('REGRESSION: a STALE journal prints "not assessed", never a red F', async () => {
    // The genuinely reachable case, and much narrower than I first assumed.
    // Two claims of mine were wrong and are corrected here:
    //   1. `intentDrift` short-circuits when the journal has no entries in the
    //      last `window` days, so the fabricated F was NEVER shown for an
    //      empty journal.
    //   2. At the DEFAULT window (14) it is unreachable outright, because
    //      14 ⊂ 30 — anything passing the early return is inside the
    //      alignment window too.
    // It becomes reachable only when the operator widens the window past 30
    // (`--window 60` here): a 40-day-old decision clears the early return but
    // falls outside the fixed 30-day alignment window, so the command reported
    // "0/100 (F)" — alignment collapsed — when the truth was "nothing logged
    // in the last 30 days". Narrow, but real, and reachable from the CLI.
    const stale = Array.from({ length: 5 }, (_, i) => ({
      timestamp: new Date(Date.now() - (40 + i) * 86400000).toISOString(),
      sessionId: `old${i}`,
      decision: `Old decision ${i}`,
      principle: 'safety',
      confidence: 0.9,
      conflict: false,
    }));
    fs.writeFileSync(
      path.join(stateDir, 'decision-journal.jsonl'),
      stale.map(e => JSON.stringify(e)).join('\n') + '\n',
    );

    const { intentDrift } = await import('../../src/commands/intent.js');
    // --window 60 is what makes this reachable: the early return checks the
    // last `window` days (60), while alignmentScore() is fixed at 30. A
    // 40-day-old decision passes the first check and falls outside the second.
    await intentDrift({ dir: tmpDir, window: 60 });

    const output = consoleLogs.join('\n');
    expect(output).toContain('not assessed');
    expect(output).toContain('cannot be assessed');
    expect(output).not.toContain('0/100 (F)');
  });

  it('REGRESSION: a populated journal still prints a real graded score', async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      timestamp: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
      sessionId: `s${i}`,
      decision: `Decision ${i}`,
      principle: 'safety',
      confidence: 0.85,
      conflict: false,
    }));
    fs.writeFileSync(
      path.join(stateDir, 'decision-journal.jsonl'),
      entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    );

    const { intentDrift } = await import('../../src/commands/intent.js');
    await intentDrift({ dir: tmpDir });

    const output = consoleLogs.join('\n');
    // The honest-empty branch must not swallow a real assessment — the mirror
    // failure of the bug being fixed.
    expect(output).toContain('/100');
    expect(output).toContain('Conflict Freedom');
    expect(output).not.toContain('not assessed');
  });
});
