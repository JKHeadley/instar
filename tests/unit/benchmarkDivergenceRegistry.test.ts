/**
 * Unit tests for the Benchmark-Divergence Detector's static registries + mirror
 * loader (benchmark-divergence-detector FD1/FD2/FD5/FD6): every enrolled pair
 * statically resolves to an exported template, the model-id table refuses
 * mutable aliases, the FD1 canonicalization + hash are pinned, the mirror
 * loader clamps untrusted fields (missing ⇒ present:false, never a throw), and
 * NO dynamic import/path resolution from mirror fields exists in the module.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ENROLLED_PAIRS,
  MODEL_ID_NORMALIZATION,
  normalizeModelId,
  validateModelIdTable,
  PROMPT_TEMPLATE_REGISTRY,
  canonicalizeTemplate,
  hashTemplate,
  liveTemplateHash,
  loadBenchmarkMirror,
  resolveMirrorPath,
  DEFAULT_MIRROR_PATH,
} from '../../src/data/benchmarkDivergenceRegistry.js';
import { DP_EXTERNAL_HOG_KILL_LEAVE, DP_MESSAGING_TONE_GATE } from '../../src/data/provenanceCoverage.js';
import { TONE_GATE_PROMPT_TEMPLATE } from '../../src/core/MessagingToneGate.js';
import { EXTERNAL_HOG_CLASSIFIER_PROMPT_TEMPLATE } from '../../src/monitoring/ExternalHogClassifierPrompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('ENROLLED_PAIRS (FD2)', () => {
  it('seeds the two wave-1 pairs on the meter decision-point ids (NOT LLM_BENCH_COVERAGE keys)', () => {
    expect(ENROLLED_PAIRS[DP_EXTERNAL_HOG_KILL_LEAVE]).toBe('zombie-classify');
    expect(ENROLLED_PAIRS[DP_MESSAGING_TONE_GATE]).toBe('tone-gate');
  });

  it('every enrolled pair statically resolves to a non-empty exported template (FD6)', () => {
    for (const taskId of Object.values(ENROLLED_PAIRS)) {
      const entry = PROMPT_TEMPLATE_REGISTRY[taskId];
      expect(entry, `missing FD6 registry entry for enrolled task ${taskId}`).toBeDefined();
      expect(typeof entry.template).toBe('string');
      expect(entry.template.length).toBeGreaterThan(100);
      expect(liveTemplateHash(taskId)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('MODEL_ID_NORMALIZATION (FD5)', () => {
  it('exact-match only; a miss is null (unmapped fail-closed) — fuzzy forbidden', () => {
    expect(normalizeModelId('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeModelId('claude-opus')).toBeNull(); // substring must NOT match
    expect(normalizeModelId('CLAUDE-OPUS-4-8')).toBeNull(); // case-fuzzy must NOT match
    expect(normalizeModelId('')).toBeNull();
    expect(normalizeModelId('__proto__')).toBeNull(); // hasOwnProperty guard
  });

  it('the shipped table validates: charset-clamped, no mutable aliases', () => {
    expect(validateModelIdTable()).toEqual([]);
  });

  it('a mutable alias (`*-latest`) is refused at validation', () => {
    expect(validateModelIdTable({ 'gpt-5.5-latest': 'gpt-5.5-latest' })).not.toEqual([]);
    expect(validateModelIdTable({ 'bad id': 'x' })).not.toEqual([]);
  });
});

describe('FD1 canonicalization + hash', () => {
  it('one pinned canonicalization: exact string, LF endings, no trim', () => {
    expect(canonicalizeTemplate('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(canonicalizeTemplate('  padded  ')).toBe('  padded  '); // NO trim
    const h = hashTemplate('x');
    expect(h).toBe(crypto.createHash('sha256').update('x', 'utf8').digest('hex'));
    // CRLF and LF variants of the same template hash identically.
    expect(hashTemplate('a\r\nb')).toBe(hashTemplate('a\nb'));
  });

  it('the FD6 templates are the REAL prompt skeletons (drift in the rule text changes the hash)', () => {
    expect(TONE_GATE_PROMPT_TEMPLATE).toContain('B15_CONTEXT_DEATH_STOP');
    expect(TONE_GATE_PROMPT_TEMPLATE).toContain('{{candidate}}');
    expect(EXTERNAL_HOG_CLASSIFIER_PROMPT_TEMPLATE).toContain('process-triage classifier');
    expect(EXTERNAL_HOG_CLASSIFIER_PROMPT_TEMPLATE).toContain('{{matchedClass}}');
    expect(hashTemplate(TONE_GATE_PROMPT_TEMPLATE)).toBe(liveTemplateHash('tone-gate'));
    expect(hashTemplate(EXTERNAL_HOG_CLASSIFIER_PROMPT_TEMPLATE)).toBe(liveTemplateHash('zombie-classify'));
  });

  it('an unknown task has no computable live hash (hash-unverifiable, never assumed faithful)', () => {
    expect(liveTemplateHash('never-enrolled-task')).toBeNull();
  });
});

describe('no dynamic resolution from mirror fields (FD1/FD6 — the traversal ban)', () => {
  it('the registry module contains no dynamic import()/require()/readFile-on-source patterns', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/data/benchmarkDivergenceRegistry.ts'),
      'utf-8',
    );
    // The ONLY file read is the mirror JSON through the injected reader; the
    // benchedPromptSource annotation must never be imported or resolved.
    expect(src).not.toMatch(/\bawait import\(/);
    expect(src).not.toMatch(/\brequire\(\s*[^'"]/); // dynamic require of a variable
    expect(src).not.toMatch(/import\(\s*benchedPromptSource/);
    expect(src).not.toMatch(/readFileSync\(\s*(?:entry|task)\.\s*benchedPromptSource/);
  });
});

describe('loadBenchmarkMirror (FD1/FD9 — untrusted mirror clamps)', () => {
  const read = (content: string | null) => (p: string): string => {
    if (content === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: p });
    return content;
  };

  it('missing or unparseable file ⇒ present:false — the designed FD4 state, never a throw', () => {
    expect(loadBenchmarkMirror('/nope/missing.json', read(null))).toEqual({ present: false, capturedAt: null, tasks: {} });
    expect(loadBenchmarkMirror('/nope/bad.json', read('{{{'))).toEqual({ present: false, capturedAt: null, tasks: {} });
    expect(loadBenchmarkMirror('/nope/arr.json', read('[1,2]'))).toEqual({ present: false, capturedAt: null, tasks: {} });
  });

  it('admits a clean mirror; capturedAt = newest task capture when unstamped at the top', () => {
    const m = loadBenchmarkMirror('/m.json', read(JSON.stringify({
      tasks: {
        'tone-gate': {
          perModel: { 'claude-opus-4-8': { passRate: 0.9, passes: 180, deterministic: 200 } },
          benchedPromptSource: 'src/core/MessagingToneGate.ts#TONE_GATE_PROMPT_TEMPLATE',
          benchedPromptHash: 'A'.repeat(64),
          capturedAt: '2026-07-02T00:00:00.000Z',
        },
        'zombie-classify': {
          perModel: {},
          benchedPromptSource: null,
          benchedPromptHash: null,
          capturedAt: '2026-06-01T00:00:00.000Z',
        },
      },
    })));
    expect(m.present).toBe(true);
    expect(m.capturedAt).toBe('2026-07-02T00:00:00.000Z');
    expect(m.tasks['tone-gate'].perModel['claude-opus-4-8'].passes).toBe(180);
    expect(m.tasks['tone-gate'].benchedPromptHash).toBe('a'.repeat(64)); // normalized lowercase
  });

  it('drops hostile/implausible entries: bad ids, rate-count inconsistency, oversized fields', () => {
    const m = loadBenchmarkMirror('/m.json', read(JSON.stringify({
      tasks: {
        'bad task id!': { perModel: {} },
        'tone-gate': {
          perModel: {
            'ok-model': { passRate: 0.5, passes: 100, deterministic: 200 },
            'bad rate': { passRate: 0.5, passes: 100, deterministic: 200 },
            'inconsistent': { passRate: 0.9, passes: 100, deterministic: 200 }, // 0.9 ≠ 0.5
            'neg': { passRate: 0.5, passes: -1, deterministic: 200 },
            'zero-det': { passRate: 0, passes: 0, deterministic: 0 },
            'overflow': { passRate: 0.5, passes: 2_000_000, deterministic: 4_000_000 },
          },
          benchedPromptHash: 'not-a-sha',
          benchedPromptSource: 'x'.repeat(9000),
        },
      },
    })));
    expect(m.tasks['bad task id!']).toBeUndefined();
    const t = m.tasks['tone-gate'];
    expect(Object.keys(t.perModel)).toEqual(['ok-model']);
    expect(t.benchedPromptHash).toBeNull(); // non-sha refused
    expect(t.benchedPromptSource!.length).toBeLessThanOrEqual(256);
  });

  it('resolveMirrorPath joins the project root; absolute paths pass through', () => {
    expect(resolveMirrorPath('/repo')).toBe(path.join('/repo', DEFAULT_MIRROR_PATH));
    expect(resolveMirrorPath('/repo', 'custom/m.json')).toBe('/repo/custom/m.json');
    expect(resolveMirrorPath('/repo', '/abs/m.json')).toBe('/abs/m.json');
  });

  it('the shipped default mirror is ABSENT — the honest pre-pull state (mirror.present:false ⇒ stale-mirror suppression)', () => {
    const repoRoot = path.resolve(__dirname, '../../');
    expect(fs.existsSync(path.join(repoRoot, DEFAULT_MIRROR_PATH))).toBe(false);
  });
});
