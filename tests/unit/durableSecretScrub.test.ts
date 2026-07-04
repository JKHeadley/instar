/**
 * Pinned pattern test for the durable-secret safety floor
 * (src/core/durableSecretScrub.ts — Durable-Output Hygiene Standard §2).
 *
 * Covers BOTH sides of every decision boundary (Testing Integrity Standard):
 *   - a real (PLACEHOLDER) credential of each kind → redacted to a typed marker;
 *   - benign text of a similar shape → left untouched;
 *   - structured metadata is kind/offset/length ONLY (never the matched bytes);
 *   - fail-safe edges (oversize / structural) withhold the field, never leak;
 *   - a worst-case timing budget on a large input (the CI proof the spec §2 asks
 *     for instead of a runtime timeout), plus a structural no-nested-quantifier
 *     assertion on every pattern source.
 *
 * SECURITY NOTE: every credential literal below is an OBVIOUSLY-FAKE placeholder
 * built from `EXAMPLE`/`PLACEHOLDER`/repeated filler (spec §4 — canonical
 * placeholder constants, NEVER a real secret, never an author-invented realistic
 * fake). They match the pattern SHAPES without being usable credentials.
 */
import { describe, it, expect } from 'vitest';
import {
  scrubForStore,
  scrubStructured,
  DURABLE_SECRET_PATTERNS,
  DEFAULT_MAX_SCRUB_BYTES,
  type DurableSecretKind,
} from '../../src/core/durableSecretScrub.js';

// ── Placeholder credentials (obviously fake; built to match SHAPE only) ──
const P = {
  anthropicApi: 'sk-ant-api03-EXAMPLE' + '0'.repeat(30),
  anthropicPlain: 'sk-ant-EXAMPLE' + 'A'.repeat(24),
  openai: 'sk-EXAMPLE' + 'A'.repeat(20),
  github: 'ghp_EXAMPLE' + 'A'.repeat(24),
  slack: 'xoxb-EXAMPLE-' + 'A'.repeat(20),
  aws: 'AKIA' + 'EXAMPLE000000000', // AKIA + 16 uppercase = valid shape
  stripe: 'sk_test_EXAMPLE' + '0'.repeat(16),
  google: 'AIza' + 'x'.repeat(35),
  telegram: '1234567890:' + 'A'.repeat(35),
  jwt: 'A'.repeat(20) + '.' + 'B'.repeat(10) + '.' + 'C'.repeat(20),
  bearer: 'Bearer ' + 'EXAMPLE' + 'A'.repeat(24),
  urlCred: 'https://user:PLACEHOLDERpass@example.com/path',
  labeled: 'api_key=' + 'x'.repeat(20),
};

describe('durableSecretScrub — scrubForStore (the security floor)', () => {
  it('redacts each credential kind to a typed marker (real → redacted)', () => {
    const cases: Array<[string, DurableSecretKind]> = [
      [P.anthropicApi, 'anthropic-key'],
      [P.anthropicPlain, 'anthropic-key'],
      [P.openai, 'openai-key'],
      [P.github, 'github-token'],
      [P.slack, 'slack-token'],
      [P.aws, 'aws-access-key'],
      [P.stripe, 'stripe-key'],
      [P.google, 'google-api-key'],
      [P.telegram, 'telegram-bot-token'],
      [P.jwt, 'jwt'],
      [P.bearer, 'bearer-token'],
    ];
    for (const [token, kind] of cases) {
      const text = `here is a value: ${token} — end`;
      const r = scrubForStore(text);
      expect(r.text, `${kind} not redacted`).toContain(`[REDACTED:${kind}]`);
      expect(r.text, `${kind} leaked the raw token`).not.toContain(token);
      expect(r.redactions.some((s) => s.kind === kind), `${kind} missing from metadata`).toBe(true);
    }
  });

  it('redacts a URL-embedded credential and a labelled secret while keeping structure', () => {
    const urlR = scrubForStore(`clone ${P.urlCred} now`);
    expect(urlR.text).toContain('[REDACTED:url-embedded-credential]');
    expect(urlR.text).not.toContain('PLACEHOLDERpass');

    const labR = scrubForStore(P.labeled);
    // Label survives; only the value is redacted.
    expect(labR.text).toContain('api_key=');
    expect(labR.text).toContain('[REDACTED:labeled-secret]');
    expect(labR.text).not.toContain('x'.repeat(20));
  });

  it('leaves benign text untouched (benign → unchanged, no false marker)', () => {
    const benign = [
      'The session built the scheduler and ran the tests. All 42 passed.',
      'file: src/core/SessionManager.ts, phase: building, topics: messaging, api',
      'sk- and a dash', // too short to be a key
      'AKIAlowercasetail', // lowercase tail — not an AWS key shape
      'version 1.2.34, commit abc1234',
    ];
    for (const b of benign) {
      const r = scrubForStore(b);
      expect(r.text, `false redaction on: ${b}`).toBe(b);
      expect(r.redactions, `phantom redaction on: ${b}`).toEqual([]);
    }
  });

  it('metadata carries kind/offset/length ONLY — never the matched bytes', () => {
    const token = P.github;
    const r = scrubForStore(`x ${token} y`);
    expect(r.redactions.length).toBe(1);
    const span = r.redactions[0];
    expect(span).toHaveProperty('kind');
    expect(span).toHaveProperty('offset');
    expect(span).toHaveProperty('length');
    // offset/length point at the ORIGINAL span and carry no bytes.
    expect(`x ${token} y`.slice(span.offset, span.offset + span.length)).toBe(token);
    expect(Object.keys(span).sort()).toEqual(['kind', 'length', 'offset']);
  });

  it('redacts multiple distinct secrets in one field', () => {
    const text = `token ${P.github} and key ${P.openai} together`;
    const r = scrubForStore(text);
    expect(r.text).toContain('[REDACTED:github-token]');
    expect(r.text).toContain('[REDACTED:openai-key]');
    expect(r.redactions.length).toBe(2);
    expect(r.text).not.toContain(P.github);
    expect(r.text).not.toContain(P.openai);
  });

  it('fail-safe: oversize input withholds the whole field (never persists raw bytes)', () => {
    const huge = 'a'.repeat(DEFAULT_MAX_SCRUB_BYTES + 1);
    const r = scrubForStore(huge);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('[REDACTED:oversize]');
    expect(r.text).not.toContain(huge);
    expect(r.redactions[0].kind).toBe('oversize');
  });

  it('respects a custom maxBytes bound', () => {
    const r = scrubForStore('x'.repeat(100), { maxBytes: 50 });
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('[REDACTED:oversize]');
  });

  it('worst-case timing budget: a large input scrubs well under budget (CI proof, spec §2)', () => {
    // 400 KB of adversarial repetition of near-miss prefixes — the shape that
    // would trigger catastrophic backtracking if a pattern were non-linear.
    const adversarial = ('sk-ant-a Bearer AKIA gh_ ' + 'x'.repeat(75)).repeat(4000);
    const start = performance.now();
    const r = scrubForStore(adversarial);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs, `scrub took ${elapsedMs.toFixed(1)}ms — over the 1000ms budget`).toBeLessThan(1000);
    expect(typeof r.text).toBe('string');
  });

  it('every pattern is linear (no nested quantifiers → no catastrophic backtracking)', () => {
    // A group whose body carries a quantifier AND is itself quantified is the
    // catastrophic-backtracking shape ((x+)+ / (x*)* / (x+){n,}). Forbid it.
    const NESTED_QUANTIFIER = /\([^)]*[*+{][^)]*\)\s*[*+{]/;
    for (const { kind, regex } of DURABLE_SECRET_PATTERNS) {
      expect(NESTED_QUANTIFIER.test(regex.source), `pattern ${kind} has a nested quantifier: ${regex.source}`).toBe(false);
    }
  });

  it('every pattern carries the global + indices flags (correct span offsets)', () => {
    for (const { kind, regex } of DURABLE_SECRET_PATTERNS) {
      expect(regex.flags.includes('g'), `pattern ${kind} missing g flag`).toBe(true);
      expect(regex.flags.includes('d'), `pattern ${kind} missing d (indices) flag`).toBe(true);
    }
  });
});

describe('durableSecretScrub — scrubStructured (structured stores)', () => {
  it('scrubs named string fields + string arrays, tags redactions with the field', () => {
    const record = {
      task: `deploy with ${P.github}`,
      blockers: null as string | null,
      files: ['src/a.ts', `secret ${P.openai}`],
      topics: ['messaging', 'security'],
      keep: 42,
    };
    const r = scrubStructured(record, ['task', 'blockers', 'files', 'topics']);
    expect(r.record.task).toContain('[REDACTED:github-token]');
    expect((r.record.files as string[])[1]).toContain('[REDACTED:openai-key]');
    expect(r.record.keep).toBe(42); // non-listed field untouched
    expect(r.record.topics).toEqual(['messaging', 'security']); // benign untouched
    // Every redaction is tagged with its field.
    expect(r.redactions.every((s) => typeof s.field === 'string')).toBe(true);
    expect(r.redactions.map((s) => s.field).sort()).toEqual(['files', 'task']);
  });

  it('null / non-string fields pass through untouched', () => {
    const record = { task: 'clean', blockers: null as string | null, n: 7 };
    const r = scrubStructured(record, ['task', 'blockers']);
    expect(r.record.task).toBe('clean');
    expect(r.record.blockers).toBeNull();
    expect(r.redactions).toEqual([]);
  });
});
