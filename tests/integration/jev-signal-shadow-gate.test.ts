/**
 * Jev signal shadow wired into the REAL MessagingToneGate — the integration
 * tier. Spec: docs/specs/jev-signal-layer-shadow.md (Tests §2).
 *
 * The non-negotiable: the gate's verdict and its latency never depend on the
 * shadow. Proven with a deliberately HANGING Jev stub — the verdict must come
 * back while the shadow's network call is still pending.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import { JevSignalShadow, SHADOW_QUESTIONS } from '../../src/core/JevSignalShadow.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import { buildReport } from '../../scripts/jev-shadow-report.mjs';

const PATHY = 'The failure is in /Users/someone/project/src/core/SessionManager.ts around line 400.';
const FUTURE = new Date(Date.now() + 14 * 86_400_000).toISOString();

function makeProvider(response: Record<string, unknown>): IntelligenceProvider {
  return { evaluate: vi.fn(async () => JSON.stringify(response)) } as unknown as IntelligenceProvider;
}
const PASS = { pass: true, rule: '', issue: '', suggestion: '' };
const BLOCK = { pass: false, rule: 'B2_FILE_PATH', issue: 'raw path shown', suggestion: 'describe it instead' };

let logPath: string;
beforeEach(() => {
  logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-shadow-int-')), 'logs', 'jev-signal-shadow.jsonl');
});
const rows = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function shadow(fetchImpl: typeof fetch, enabled = true) {
  return new JevSignalShadow({
    getConfig: () => ({ enabled, soakEndsAt: FUTURE, model: 'jev-1.13.0', timeoutMs: 5_000 }) as never,
    readKey: () => 'test-key',
    logPath,
    fetchImpl,
  });
}

describe('shadow OFF (the shipped state): byte-identical gate behaviour', () => {
  it('returns the same verdict with and without a disabled shadow attached, and writes no rows', async () => {
    const bare = new MessagingToneGate(makeProvider(BLOCK), {});
    const withShadow = new MessagingToneGate(makeProvider(BLOCK), {});
    withShadow.setSignalShadow(shadow((async () => { throw new Error('must not be called'); }) as never, false));
    const a = await bare.review(PATHY, { channel: 'telegram', messageKind: 'reply' } as never);
    const b = await withShadow.review(PATHY, { channel: 'telegram', messageKind: 'reply' } as never);
    expect(b.pass).toBe(a.pass);
    expect(b.rule).toBe(a.rule);
    expect(rows()).toHaveLength(0);
  });
});

describe('shadow ON: measure-only', () => {
  it('the verdict returns while the Jev call is still HANGING (never awaited)', async () => {
    let jevCalled = false;
    const hang: typeof fetch = () => { jevCalled = true; return new Promise(() => {}); };
    const gate = new MessagingToneGate(makeProvider(PASS), {});
    gate.setSignalShadow(shadow(hang));
    const result = await gate.review(PATHY, { channel: 'telegram', messageKind: 'reply' } as never);
    expect(result.pass).toBe(true);   // the gate answered…
    expect(jevCalled).toBe(true);     // …while the shadow's call was dispatched and never settled
  });

  it('writes a compared row alongside a normal verdict, and the verdict is unchanged by it', async () => {
    const answers = Object.fromEntries(SHADOW_QUESTIONS.map((q) => [q.rule, { noul: q.rule === 'raw_path' ? 0.97 : 0.02 }]));
    const ok: typeof fetch = (async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 100 }, answers }) })) as never;
    const gate = new MessagingToneGate(makeProvider(BLOCK), {});
    const sh = shadow(ok);
    gate.setSignalShadow(sh);
    const result = await gate.review(PATHY, { channel: 'telegram', messageKind: 'reply' } as never);
    await sh.lastDispatch;
    expect(result.pass).toBe(false);
    expect(result.rule).toBe('B2_FILE_PATH');
    const [r] = rows();
    expect(r.kind).toBe('compared');
    expect(r.detectorSignals).toContain('file-path');
    expect(JSON.stringify(r)).not.toContain('SessionManager');
  });

  it('a THROWING observer cannot break the gate (review() guards the call)', async () => {
    const gate = new MessagingToneGate(makeProvider(PASS), {});
    gate.setSignalShadow({ observe: () => { throw new Error('boom'); } });
    const result = await gate.review(PATHY, { channel: 'telegram', messageKind: 'reply' } as never);
    expect(result.pass).toBe(true);
  });

  it('a network failure inside the real shadow cannot break the gate', async () => {
    const gate = new MessagingToneGate(makeProvider(PASS), {});
    gate.setSignalShadow(shadow((async () => { throw new Error('network down'); }) as never));
    const result = await gate.review(PATHY, { channel: 'telegram', messageKind: 'reply' } as never);
    expect(result.pass).toBe(true);
  });
});

describe('the soak report reads the log correctly', () => {
  it('dedupes by hash, builds per-rule confusion matrices, and reports coverage', () => {
    const base = { ts: 't', bytes: 10, ms: 5, modelServed: 'jev-1.13.0', disagree: [] };
    const lines = [
      JSON.stringify({ kind: 'compared', sha256: 'a', detectorSignals: ['file-path'], jev: { raw_path: 0.9 }, ...base }),
      JSON.stringify({ kind: 'compared', sha256: 'a', detectorSignals: ['file-path'], jev: { raw_path: 0.9 }, ...base }), // retry duplicate
      JSON.stringify({ kind: 'compared', sha256: 'b', detectorSignals: [], jev: { raw_path: 0.1 }, ...base }),
      JSON.stringify({ kind: 'compared', sha256: 'c', detectorSignals: ['file-path'], jev: { raw_path: 0.2 }, ...base }),
      JSON.stringify({ kind: 'not-compared', sha256: 'd', ts: 't', bytes: 1, reason: 'timeout' }),
    ];
    const r = buildReport(lines);
    expect(r.comparedDistinct).toBe(3);
    expect(r.candidates).toBe(4);
    expect(r.notCompared).toEqual({ timeout: 1 });
    expect(r.perRule.raw_path).toMatchObject({ hits: 1, misses: 1, trueNegatives: 1, falseAlarms: 0, positiveCases: 2, verdict: 'insufficient-evidence' });
    expect(r.graduationEligible).toBe(false);
  });
});
