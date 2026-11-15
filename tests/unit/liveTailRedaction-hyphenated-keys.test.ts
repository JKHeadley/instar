/**
 * Hyphenated sk-family keys (sk-ant-api03-…, sk-proj-…, sk-svcacct-…, sk-ant-admin01-…)
 * must be redacted WHOLE by the live-tail scrubber and its sibling redaction helpers.
 * The old generic rule needed 16 unbroken alphanumerics right after `sk-`, so these
 * forms slipped through untouched. Both sides of the boundary are pinned: real key
 * shapes are fully removed, ordinary hyphenated prose is left alone.
 *
 * Fake keys are assembled at runtime so no key-shaped literal sits in the source.
 */
import { describe, expect, it } from 'vitest';
import {
  REDACTION_CATEGORY_VERSION,
  RedactionCategory,
  redactForLiveTail,
} from '../../src/core/liveTailRedaction.js';
import { prepareClaimObservation } from '../../src/monitoring/ClaimObservation.js';

const BODY = 'Ab3dEf5hIj7lMn9pQr1tUv3xYz5bCd7fGh9jKl1nOp3rSt5vWx7z-Q_wErTy';
const key = (prefix: string) => ['sk', ...prefix.split('|')].join('-') + '-' + BODY;

const KEYS: Record<string, string> = {
  'anthropic api': key('ant|api03'),
  'anthropic admin': key('ant|admin01'),
  'anthropic oauth': key('ant|oat01'),
  'openai project': key('proj'),
  'openai service account': key('svcacct'),
  'openai admin': key('admin'),
  'openrouter': key('or|v1'),
};

describe('liveTailRedaction — hyphenated sk-family keys', () => {
  for (const [name, k] of Object.entries(KEYS)) {
    it(`redacts the whole ${name} key, leaving no fragment of it`, () => {
      const r = redactForLiveTail(`export KEY=${k} and then more text`);
      expect(r.text).not.toContain(BODY.slice(0, 12));
      expect(r.text).not.toContain(BODY.slice(-12));
      expect(r.text).not.toMatch(/sk-(?:ant|proj|svcacct|admin|or)/);
      expect(r.text).toContain('and then more text');
      expect(r.redactedCount).toBeGreaterThanOrEqual(1);
    });
  }

  it('labels a bare hyphenated key as an api-key redaction', () => {
    const r = redactForLiveTail(`here: ${KEYS['anthropic api']} done`);
    expect(r.text).toBe('here: [redacted:api-key] done');
    expect(r.categories).toEqual([RedactionCategory.ApiKey]);
  });

  it('catches an underscore-joined key (lookbehind, not \\b)', () => {
    const r = redactForLiveTail(`MY_KEY_${KEYS['openai project']}`);
    expect(r.text).not.toContain(BODY.slice(0, 12));
  });

  it('still redacts the classic unbroken sk- key', () => {
    const r = redactForLiveTail('k sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2' + ' end');
    expect(r.text).toBe('k [redacted:api-key] end');
  });

  it('bumps the category-set version so receivers can tell which scrub ran', () => {
    expect(REDACTION_CATEGORY_VERSION).toBe(2);
    expect(redactForLiveTail('x').version).toBe(2);
  });

  const ORDINARY = [
    'we use sk-learn-compatible-estimators for the pipeline',
    'the task-proj-migration-checklist-for-november is done',
    'see desk-admin-handover-notes-and-runbook for details',
    'an sk-ant colony walked by',
    'the sk-ant-colony-walked-along-the-riverbank-slowly story',
    'risk-free plan: sk-proj is a prefix name, not a key',
    'kebab-case-identifiers-like-this-one-stay-readable',
  ];
  for (const text of ORDINARY) {
    it(`leaves ordinary hyphenated text untouched: "${text.slice(0, 30)}…"`, () => {
      const r = redactForLiveTail(text);
      expect(r.text).toBe(text);
      expect(r.redactedCount).toBe(0);
    });
  }
});

describe('ClaimObservation scrub — hyphenated Anthropic key (same flaw, same fix)', () => {
  const evidence = { hadToolCalls: false, toolCalls: [], truncated: false, unavailable: false, canaryOk: true };

  it('removes an sk-ant-api03 key from provider-bound text', () => {
    const p = prepareClaimObservation(`Capacity is four. ${KEYS['anthropic api']}`, evidence);
    expect(p.message).not.toContain(BODY.slice(0, 12));
    expect(p.message).not.toContain('sk-ant');
    expect(p.message).toContain('[REDACTED_SECRET_');
  });

  it('leaves ordinary hyphenated prose alone', () => {
    const p = prepareClaimObservation('We use sk-learn-compatible-estimators today.', evidence);
    expect(p.message).toBe('We use sk-learn-compatible-estimators today.');
  });
});
