// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * The adapter verification suite's evaluator (context-budget-layered-
 * summaries §9.6): every capability decided from collected evidence, both
 * sides of each decision; unmeasured capabilities are `absent` with the
 * reason, never assumed; results stored per engine version.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateSuite, writeSuiteResult, readSuiteResults, ADAPTER_CAPABILITIES, type SuiteEvidence, type AdapterSuiteResult } from '../../src/monitoring/adapterVerificationSuite.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const tokens = { alpha: 'ALPHA-1', steer: 'STEER-2', seed: 'SEED-3', clear: 'CLEAR-4', delta: 'DELTA-5', deny: 'DENY-6' };
/** Evidence as the live 2.1.322 run collected it. */
const full = (): SuiteEvidence => ({
  tokens, version: '2.1.322', firstReply: 'OK', transcriptPath: '/t/s1.jsonl', transcriptHasEntries: true,
  preCompactPayload: { trigger: 'manual', custom_instructions: '' },
  postCompactPayload: { trigger: 'manual', compact_summary: 'summary … STEER-2 …' },
  sessionStartCompactPayload: { source: 'compact' },
  transcriptHasCompactBoundary: true, transcriptHasCompactSeedHook: true,
  afterCompactReply: 'ALPHA-1 SEED-3 DELTA-5 STEER-2',
  sessionStartClearPayload: { source: 'clear', session_id: 's2' },
  afterClearReply: 'CLEAR-4 DELTA-5',
  frameworkSeenByHook: 'claude-code', denyRefusedWithReason: true, denyToolRan: false, firstSessionId: 's1',
  restoreMode: 'materialised', restoreReply: 'ALPHA-1', errors: [],
});

describe('evaluateSuite', () => {
  it('the live 2.1.322 evidence: every measured capability supported, every unmeasured one absent WITH a reason', () => {
    const r = evaluateSuite(full());
    expect(Object.keys(r).sort()).toEqual([...ADAPTER_CAPABILITIES].sort());
    for (const k of ['transcriptRead', 'controlCompact', 'controlClear', 'compactionDetection', 'preCompactionSteering', 'postCompactSummary', 'seedAfterCompaction', 'seedAfterClear', 'materialiseResume', 'perPromptDelta', 'toolPolicy', 'frameworkDiscriminator'] as const) {
      expect(r[k].state, k).toBe('supported');
    }
    for (const k of ['spawnWithInitialContext', 'compactionWindowSetting', 'cleanStopSignals', 'costModel'] as const) {
      expect(r[k]).toMatchObject({ state: 'absent' });
      expect(r[k].evidence).toMatch(/^unmeasured by this suite: /);
    }
  });

  it('nothing collected ⇒ every capability absent (never assumed)', () => {
    const r = evaluateSuite({ tokens, errors: ['claude not found'] });
    for (const k of ADAPTER_CAPABILITIES) expect(r[k].state, k).toBe('absent');
  });

  it.each([
    ['steering text missing from the summary ⇒ partial', (e: SuiteEvidence) => { e.postCompactPayload = { compact_summary: 'no token' }; }, 'preCompactionSteering', 'partial'],
    ['PreCompact never fired, boundary present ⇒ detection partial', (e: SuiteEvidence) => { delete e.preCompactPayload; }, 'compactionDetection', 'partial'],
    ['an auto compaction is not proof `/compact` works', (e: SuiteEvidence) => { e.preCompactPayload = { trigger: 'auto' }; }, 'controlCompact', 'absent'],
    ['PostCompact fired with no summary ⇒ partial', (e: SuiteEvidence) => { e.postCompactPayload = { trigger: 'manual' }; }, 'postCompactSummary', 'partial'],
    ['seed hook fired but the model never saw it ⇒ partial', (e: SuiteEvidence) => { e.afterCompactReply = 'ALPHA-1'; }, 'seedAfterCompaction', 'partial'],
    ['clear left the old context visible ⇒ partial', (e: SuiteEvidence) => { e.afterClearReply = 'CLEAR-4 ALPHA-1'; }, 'seedAfterClear', 'partial'],
    ['restore materialised but did not recall ⇒ partial', (e: SuiteEvidence) => { e.restoreReply = 'NONE'; }, 'materialiseResume', 'partial'],
    ['no delta anywhere ⇒ absent', (e: SuiteEvidence) => { e.afterCompactReply = 'ALPHA-1 SEED-3'; e.afterClearReply = 'CLEAR-4'; }, 'perPromptDelta', 'absent'],
    ['deny reason not in a refused tool_result ⇒ absent', (e: SuiteEvidence) => { e.denyRefusedWithReason = false; }, 'toolPolicy', 'absent'],
    ['the deny was logged but the command RAN ⇒ absent', (e: SuiteEvidence) => { e.denyToolRan = true; }, 'toolPolicy', 'absent'],
    ['`/clear` that kept the same session id is not a fresh session', (e: SuiteEvidence) => { e.sessionStartClearPayload = { source: 'clear', session_id: 's1' }; }, 'controlClear', 'absent'],
    ['framework not visible to hooks ⇒ absent', (e: SuiteEvidence) => { e.frameworkSeenByHook = ''; }, 'frameworkDiscriminator', 'absent'],
  ] as const)('%s', (_n, spoil, cap, state) => {
    const e = full(); spoil(e);
    expect(evaluateSuite(e)[cap].state).toBe(state);
  });
});

describe('suite result store', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/adapter-verification-suite.test.ts' }); });
  it('keyed per engine version, newest first, a torn file skipped', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-store-')); dirs.push(stateDir);
    const mk = (version: string, ranAt: number): AdapterSuiteResult => ({ schema: 'adapter-suite/1', engine: 'claude-code', version, machine: 'm1', ranAt, durationMs: 1, capabilities: evaluateSuite(full()), inconclusive: false, errors: [] });
    writeSuiteResult(stateDir, mk('2.1.321', 1));
    const f = writeSuiteResult(stateDir, mk('2.1.322', 2));
    expect(path.basename(f)).toBe('claude-code-2.1.322.json');
    writeSuiteResult(stateDir, mk('2.1.322', 3)); // a re-run replaces that version's record
    fs.writeFileSync(path.join(path.dirname(f), 'claude-code-bad.json'), '{torn');
    expect(readSuiteResults(stateDir).map((r) => [r.version, r.ranAt])).toEqual([['2.1.322', 3], ['2.1.321', 1]]);
    expect(writeSuiteResult(stateDir, mk('../../evil', 4))).toContain('claude-code-.._.._evil.json'.replace(/\//g, '_'));
    // An inconclusive run is never recorded, and a hand-planted one is ignored on read.
    expect(() => writeSuiteResult(stateDir, { ...mk('2.1.330', 5), inconclusive: true, errors: ['429'] })).toThrow(/inconclusive/);
    fs.writeFileSync(path.join(path.dirname(f), 'claude-code-2.1.331.json'), JSON.stringify({ ...mk('2.1.331', 6), inconclusive: true }));
    expect(readSuiteResults(stateDir).map((r) => r.version)).not.toContain('2.1.331');
  });
});

describe('adapterSuiteCli (the suite process)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/adapter-verification-suite.test.ts:cli' }); });

  it('a rate-limited engine: ok:false, NOTHING recorded, the errors kept in last-run.json, and stale work dirs swept', async () => {
    const { runAdapterSuiteCli } = await import('../../src/monitoring/adapterSuiteCli.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-cli-')); dirs.push(root);
    const tmpRoot = path.join(root, 'tmp'); fs.mkdirSync(tmpRoot);
    const stale = path.join(tmpRoot, 'instar-adapter-suite-old'); fs.mkdirSync(stale);
    const old = new Date(Date.now() - 2 * 60 * 60_000); fs.utimesSync(stale, old, old);
    const bin = path.join(root, 'claude'); fs.writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.322 (Claude Code)"; exit 0; fi\necho "API Error: 429 rate_limit_error" >&2\nexit 1\n', { mode: 0o755 });
    const stateDir = path.join(root, 'state');
    const out = runAdapterSuiteCli([stateDir, 'm1', bin], tmpRoot);
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/^inconclusive: .*429/) });
    expect(readSuiteResults(stateDir)).toEqual([]);
    const last = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'context-budget', 'adapter-suite', 'last-run.json'), 'utf-8'));
    expect(last).toMatchObject({ ok: false, version: '2.1.322' });
    expect(last.errors.join(' ')).toContain('429');
    expect(fs.readdirSync(tmpRoot)).toEqual([]); // the stale dir was swept and this run's own work dir removed
  });
});
