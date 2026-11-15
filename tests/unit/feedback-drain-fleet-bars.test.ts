// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * CMT-1613: the feedback drain's fleet bars. The old `ran` bar (one completed run in a day,
 * from the last run alone) was trivially passable. The fleet rung now needs a durable
 * success share over 7 days and an outcome count of merged feedback PRs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeLadderState, parseLadderRegistry, type JsonlLogRef, type LadderEntry } from '../../src/monitoring/MaturationLadder.js';
import { readJsonlQueries } from '../../src/monitoring/LadderEvidenceReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REGISTRY = path.resolve(__dirname, '../../src/data/feature-ladders.json');

function drainEntry(): LadderEntry {
  const parsed = parseLadderRegistry(fs.readFileSync(REGISTRY, 'utf8'));
  if (!parsed.ok) throw new Error(`registry does not parse: ${parsed.reason}`);
  const entry = parsed.registry.entries.find(e => e.id === 'feedbackFactory.drain');
  if (!entry) throw new Error('feedbackFactory.drain missing');
  return entry;
}

describe('feedbackFactory.drain fleet bars (CMT-1613)', () => {
  it('replaces the one-run bar with a durable 7-day success share of at least 97% over at least 200 runs', () => {
    const metrics = drainEntry().rungs.fleet!.metrics;
    expect(metrics.find(m => m.id === 'completed-drain-runs')).toBeUndefined();
    // `ran` is a count: a real 0% share must read as a hold, never as "no data".
    expect(metrics.find(m => m.id === 'finished-drain-runs')).toMatchObject({
      role: 'ran', source: 'feature-summary', ref: { ref: 'feedback-factory.finished-runs-7d' }, direction: 'at-least', threshold: 200, windowDays: 7,
    });
    const share = metrics.find(m => m.id === 'drain-run-success-share')!;
    expect(share).toMatchObject({
      role: 'quality', source: 'feature-summary', ref: { ref: 'feedback-factory.run-success-share-7d' },
      direction: 'at-least', threshold: 0.97, minSamples: 200, windowDays: 7,
    });
  });

  it('adds an outcome bar: at least 3 feedback PRs merged at their approved head in 30 days', () => {
    const merged = drainEntry().rungs.fleet!.metrics.find(m => m.id === 'merged-feedback-prs')!;
    expect(merged).toMatchObject({ role: 'quality', source: 'jsonl-log', direction: 'at-least', threshold: 3, minSamples: 3, windowDays: 30 });
    expect((merged.ref as JsonlLogRef).file).toBe('.instar/logs/feedback-triage.jsonl');
  });

  it('the real fleet rung reads a 0% share over 250 runs as hold (not no-data), too few runs as hold, and good numbers as ready', () => {
    const entry = drainEntry();
    const metrics = entry.rungs.fleet!.metrics;
    const now = Date.parse('2026-11-11T12:00:00Z');
    const evaluations = Array.from({ length: 40 }, (_, i) => ({ status: 'ready', dueSlotMs: now - i * 6 * 3_600_000, contractHash: 'h' }));
    const values: Record<string, [number, number]> = {
      'finished-drain-runs': [250, 250], 'drain-run-success-share': [0.99, 250], 'merged-feedback-prs': [4, 6], 'readiness-error-rate': [0.01, 40],
    };
    const state = (over: Record<string, [number, number]>) => computeLadderState({
      entry, rung: 'dev-agent-live', target: 'fleet', afterMove: [], evaluations, contractHash: 'h', now, lastMoveAt: null, heldReason: null,
      readings: metrics.map(metric => { const [value, samples] = { ...values, ...over }[metric.id]; return { metric, value, samples, newestAt: null }; }),
    }).state;
    expect(state({})).toBe('ready-to-advance');
    expect(state({ 'drain-run-success-share': [0, 250] })).toBe('hold');
    expect(state({ 'finished-drain-runs': [120, 120], 'drain-run-success-share': [1, 120] })).toBe('hold');
    expect(state({ 'merged-feedback-prs': [0, 23] })).toBe('hold');
  });

  it('keeps the readiness error-rate harm bar', () => {
    const harm = drainEntry().rungs.fleet!.metrics.find(m => m.id === 'readiness-error-rate')!;
    expect(harm).toMatchObject({ role: 'harm', threshold: 0.05 });
  });

  it('the merged-PR bar counts executor merges at the approved head from the real audit row shape', async () => {
    const merged = drainEntry().rungs.fleet!.metrics.find(m => m.id === 'merged-feedback-prs')!;
    const ref = merged.ref as JsonlLogRef;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-bars-'));
    try {
      const file = path.join(home, ref.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const now = Date.parse('2026-11-11T12:00:00Z');
      const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
      // Rows exactly as FeedbackExecutorService appends them.
      const rows = [
        { ts: at(2), event: 'execute:pr-opened', attemptId: 'a:1', pr: 1, kind: 'fix', codeownersOutside: 0, pinApproved: false },
        { ts: at(2), event: 'execute:pr-opened', attemptId: 'b:1', pr: 2, kind: 'fix', codeownersOutside: 0, pinApproved: false },
        { ts: at(1), event: 'execute:merged', attemptId: 'a:1', pr: 1, elsewhere: false },
        { ts: at(1), event: 'execute:merged', attemptId: 'b:1', pr: 2, elsewhere: true }, // not at the approved head
        { ts: at(40), event: 'execute:merged', attemptId: 'c:1', pr: 3, elsewhere: false }, // outside the window
        { ts: at(1), event: 'decision', clusterId: 'x' },
      ];
      fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      const answers = await readJsonlQueries(home, [{ key: 'k', ref, sinceMs: now - merged.windowDays * 86_400_000, direction: 'at-least' }], now);
      expect(answers.get('k')).toMatchObject({ value: 1, samples: 2 });
    } finally {
      SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/feedback-drain-fleet-bars.test.ts' });
    }
  });

  it('the new projection ref is on the maturation source allowlist', async () => {
    const scan = fs.readFileSync(path.resolve(__dirname, '../../src/core/featureRolloutScan.ts'), 'utf8');
    const server = fs.readFileSync(path.resolve(__dirname, '../../src/server/AgentServer.ts'), 'utf8');
    expect(scan).toContain("'feedback-factory.run-success-share-7d'");
    expect(scan).toContain("'feedback-factory.finished-runs-7d'");
    expect(server).toMatch(/registerMaturationProjection\('feedback-factory\.finished-runs-7d'/);
    expect(server).toMatch(/registerMaturationProjection\('feedback-factory\.run-success-share-7d'[\s\S]{0,300}store\.runOutcomes\(Date\.now\(\) - 7 \* 86_400_000\)/);
  });
});
