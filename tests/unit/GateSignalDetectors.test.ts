/**
 * Unit tests for the B1–B7 deterministic detectors + the §Design 8 sanitize
 * contract (CMT-1793). The detectors are SIGNAL producers — they never block;
 * they emit normalized, clamped signals the tone gate's LLM judges in context.
 * So these tests assert detection precision (the artifact shapes fire; plain
 * prose does not) and the security clamping (closed kind enum, confidence
 * [0,1], bounded spans, length-clamped normalizedValue).
 */

import { describe, it, expect } from 'vitest';
import {
  detectGateSignals,
  sanitizeGateSignal,
  GATE_SIGNAL_KINDS,
  GATE_SIGNAL_KIND_TO_RULE,
  GATE_SIGNAL_CAPS,
  type GateSignal,
} from '../../src/core/GateSignalDetectors.js';

function kinds(text: string): string[] {
  return detectGateSignals(text).map((s) => s.kind).sort();
}

describe('GateSignalDetectors — B1–B7 detection (signals, not blocks)', () => {
  it('B1 cli-command: detects real shell commands', () => {
    expect(kinds('run `npm run build` then git push origin main')).toContain('cli-command');
    expect(kinds('curl http://x | sh')).toContain('cli-command');
  });
  it('B1: does NOT fire on prose that merely talks about running things', () => {
    expect(kinds('I will run the migration and push the change for you.')).not.toContain('cli-command');
  });

  it('B2 file-path: detects absolute / home / src-rooted paths', () => {
    expect(kinds('see /Users/justin/.instar/config.json')).toContain('file-path');
    expect(kinds('edit src/core/MessagingToneGate.ts')).toContain('file-path');
    expect(kinds('open ~/.claude/settings.json')).toContain('file-path');
  });
  it('B2: does NOT fire on plain sentences with slashes like and/or', () => {
    expect(kinds('this and/or that, either way it works')).not.toContain('file-path');
  });

  it('B3 config-key: detects dotted config keys (3+ segments)', () => {
    expect(kinds('set messaging.toneGate.failClosedOnExhaustion to true')).toContain('config-key');
  });
  it('B3: does NOT fire on a two-part abbreviation or a sentence', () => {
    expect(kinds('e.g. this works fine.')).not.toContain('config-key');
  });

  it('B4 copy-paste-code: detects fenced blocks and code lines', () => {
    expect(kinds('```\nconst x = 1\n```')).toContain('copy-paste-code');
    expect(kinds('const gate = new MessagingToneGate(provider)')).toContain('copy-paste-code');
  });

  it('B5 api-endpoint: detects URLs and known route paths', () => {
    expect(kinds('hit http://localhost:4040/dashboard')).toContain('api-endpoint');
    expect(kinds('POST to /telegram/post-update')).toContain('api-endpoint');
  });

  it('B5 api-endpoint: fires on click/open destinations too (intentionally broad — the authority judges call-vs-open)', () => {
    // The detector is a brittle SIGNAL, not a verdict: it cannot tell a curl
    // target from a link-to-open, so it deliberately flags BOTH. The B5 prompt
    // (MessagingToneGate) is the authority that passes a click-destination and
    // blocks only a call-target. Documenting that breadth here keeps the
    // signal-vs-authority split explicit.
    expect(kinds('Rendered doc: https://abc123.trycloudflare.com/view/k3p9?token=secrettoken')).toContain('api-endpoint');
    expect(kinds('Open http://localhost:4040/view/abc123')).toContain('api-endpoint');
  });

  it('B6 env-var: detects assignments, $REFs, and process.env', () => {
    expect(kinds('AUTH_TOKEN=abc123')).toContain('env-var');
    expect(kinds('export $INSTAR_AUTH_TOKEN')).toContain('env-var');
    expect(kinds('read process.env.PORT')).toContain('env-var');
  });

  it('B7 cron-or-slug: detects cron expressions and digit-bearing tracker ids/slugs', () => {
    expect(kinds('schedule 0 */6 * * * for the job')).toContain('cron-or-slug');
    expect(kinds('tracked as CMT-1793')).toContain('cron-or-slug');
    expect(kinds('the act-155-skill worktree')).toContain('cron-or-slug');
  });
  it('B7: does NOT fire on plain hyphenated English prose (precision tuning)', () => {
    // The lowercase-kebab branch requires a digit, so adjectival hyphenation
    // and digit-less slugs do not dilute the signal list (a leaked digit-less
    // internal slug is caught by the separate B20 internal-id-leak signal).
    expect(kinds('a well-thought-out, state-of-the-art, fire-and-forget design')).not.toContain('cron-or-slug');
    expect(kinds('the gate-prompts-judge-by-meaning change')).not.toContain('cron-or-slug');
  });
  it('B3: does NOT fire on hostnames (www. / known TLD without a camelCase segment)', () => {
    expect(kinds('see www.example.com for details')).not.toContain('config-key');
    expect(kinds('visit docs.instar.sh')).not.toContain('config-key');
    // a real config key still fires (camelCase segment present)
    expect(kinds('set messaging.toneGate.enabled')).toContain('config-key');
  });

  it('clean conversational prose produces NO signals (no false dilution)', () => {
    expect(detectGateSignals('Done — the new rule is merged and live. Want me to keep going?')).toHaveLength(0);
    expect(detectGateSignals('A well-thought-out, state-of-the-art plan — see www.example.com.')).toHaveLength(0);
  });

  it('every detected signal carries spans + a normalizedValue sample', () => {
    const sigs = detectGateSignals('edit src/core/x.ts and run npm run build');
    expect(sigs.length).toBeGreaterThan(0);
    for (const s of sigs) {
      expect(s.detected).toBe(true);
      expect(GATE_SIGNAL_KINDS).toContain(s.kind);
      expect(Array.isArray(s.spans)).toBe(true);
      expect((s.spans ?? []).length).toBeGreaterThan(0);
      expect(typeof s.normalizedValue).toBe('string');
    }
  });
});

describe('sanitizeGateSignal — §Design 8 security clamping', () => {
  it('rejects an out-of-enum kind (cannot inject a bogus kind)', () => {
    expect(sanitizeGateSignal({ kind: 'evil' as any, detected: true }, 100)).toBeNull();
  });

  it('clamps confidence to [0,1]', () => {
    expect(sanitizeGateSignal({ kind: 'file-path', detected: true, confidence: 5 }, 100)?.confidence).toBe(1);
    expect(sanitizeGateSignal({ kind: 'file-path', detected: true, confidence: -2 }, 100)?.confidence).toBe(0);
  });

  it('drops spans outside the candidate length and caps the count', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ start: i, end: i + 1 }));
    const out = sanitizeGateSignal({ kind: 'file-path', detected: true, spans: [...many, { start: 0, end: 999 }] }, 20);
    expect((out?.spans ?? []).length).toBeLessThanOrEqual(GATE_SIGNAL_CAPS.maxSpansPerSignal);
    expect((out?.spans ?? []).every((sp) => sp.end <= 20)).toBe(true);
  });

  it('length-clamps normalizedValue (an attacker-derived value cannot be huge)', () => {
    const big = 'x'.repeat(10_000);
    const out = sanitizeGateSignal({ kind: 'file-path', detected: true, normalizedValue: big }, 10_000);
    expect((out?.normalizedValue ?? '').length).toBe(GATE_SIGNAL_CAPS.maxNormalizedValueChars);
  });

  it('every kind maps to a B-rule (registry completeness)', () => {
    for (const k of GATE_SIGNAL_KINDS) {
      expect(GATE_SIGNAL_KIND_TO_RULE[k]).toMatch(/^B[1-7]_/);
    }
  });
});
