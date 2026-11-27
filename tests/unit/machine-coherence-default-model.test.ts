/**
 * Default-model coherence rows (machineCoherenceManifest `defaultModel.<framework>`).
 *
 * 2026-11-09, topic 141133: the Studio and Mac Mini set
 * `sessions.frameworkDefaultModels['claude-code'] = 'claude-opus-5-5'`; Mama PC and
 * the Laptop had nothing set, so an unpinned topic placed on Mama PC ran the
 * login's own default (Fable 5.1) and its replies were tagged Fable. The guard
 * must see that difference as skew.
 */
import { describe, it, expect } from 'vitest';
import {
  COHERENCE_CRITICAL_FLAGS,
  COHERENCE_DEFAULT_MODEL_FRAMEWORKS,
  DEFAULT_MODEL_UNSET,
  MC_VALUE_ALPHABET,
  MC_VALUE_MAX,
  buildCoherenceFlags,
  resolveFlagValue,
} from '../../src/core/machineCoherenceManifest.js';
import { computeDivergentRows } from '../../src/monitoring/machineCoherenceEvaluate.js';
import type { MachineCapacity } from '../../src/core/types.js';

const row = (framework: string) => COHERENCE_CRITICAL_FLAGS.find((e) => e.key === `defaultModel.${framework}`)!;
const studio = { sessions: { frameworkDefaultModels: { 'claude-code': 'claude-opus-5-5', 'codex-cli': 'gpt-6.1-sol' } } };
const mamaBefore = { sessions: { frameworkDefaultModels: { 'codex-cli': 'gpt-6.1-sol' } } };

describe('defaultModel.<framework> manifest rows', () => {
  it('carries one boot-read raw row per listed framework, pointing at sessions.frameworkDefaultModels', () => {
    for (const fw of COHERENCE_DEFAULT_MODEL_FRAMEWORKS) {
      const e = row(fw);
      expect(e).toBeDefined();
      expect(e.configPath).toBe(`sessions.frameworkDefaultModels.${fw}`);
      expect(e.resolution).toBe('raw');
      expect(e.readSource).toBe('boot');
    }
  });

  it('resolves a configured model to its clamped id', () => {
    expect(resolveFlagValue(row('claude-code'), { boot: studio })).toBe('claude-opus-5-5');
    expect(resolveFlagValue(row('codex-cli'), { boot: studio })).toBe('gpt-6-1-sol');
  });

  it('resolves a missing, blank or non-string default to account-default', () => {
    expect(resolveFlagValue(row('claude-code'), { boot: mamaBefore })).toBe(DEFAULT_MODEL_UNSET);
    expect(resolveFlagValue(row('claude-code'), { boot: {} })).toBe(DEFAULT_MODEL_UNSET);
    expect(resolveFlagValue(row('claude-code'), { boot: { sessions: { frameworkDefaultModels: { 'claude-code': '  ' } } } })).toBe(DEFAULT_MODEL_UNSET);
    expect(resolveFlagValue(row('claude-code'), { boot: { sessions: { frameworkDefaultModels: { 'claude-code': 5 } } } })).toBe(DEFAULT_MODEL_UNSET);
  });

  it('every advertised value stays inside the clamp alphabet, even for a long or odd id', () => {
    const flags = buildCoherenceFlags({ boot: { sessions: { frameworkDefaultModels: { 'claude-code': 'Claude_Opus 5.5[1m]-with-a-very-long-suffix-here' } } } });
    expect(flags['defaultModel.claude-code'].length).toBeLessThanOrEqual(MC_VALUE_MAX);
    expect(flags['defaultModel.claude-code']).toMatch(MC_VALUE_ALPHABET);
  });

  type Adv = NonNullable<MachineCapacity['coherenceAdvert']>;
  const advert = (boot: Record<string, unknown>): Adv => ({
    instarVersion: '1.3.1720', protocolVersion: 2, manifestHash: 'a'.repeat(64), guard: 'live', beatSeq: 1,
    flags: buildCoherenceFlags({ boot }),
  });

  it('a machine with no Claude default next to one on Opus 5.5 is a skew row (the 141133 shape)', () => {
    const rows = computeDivergentRows([
      { machineId: 'm_studio', advert: advert(studio) },
      { machineId: 'm_mama', advert: advert(mamaBefore) },
    ]);
    const skew = rows.find((r) => r.key === 'defaultModel.claude-code');
    expect(skew).toBeDefined();
    expect(skew!.valueClasses).toEqual({ m_studio: 'claude-opus-5-5', m_mama: 'account-default' });
    // The codex default matches on both, so it raises nothing.
    expect(rows.find((r) => r.key === 'defaultModel.codex-cli')).toBeUndefined();
  });

  it('machines that agree on the default raise no default-model row', () => {
    const rows = computeDivergentRows([
      { machineId: 'm_studio', advert: advert(studio) },
      { machineId: 'm_mama', advert: advert(studio) },
    ]);
    expect(rows.filter((r) => r.key.startsWith('defaultModel.'))).toEqual([]);
  });
});
