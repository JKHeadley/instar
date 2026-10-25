/**
 * Outbound credential wall — modern OpenAI and GitHub key formats.
 * Spec: docs/specs/outbound-credential-wall-modern-key-formats.md
 *
 * Every key in this file is GENERATED at test time in the real issued shape;
 * no credential literal is committed. The wall asserts shape, never liveness,
 * so a generated key is refused exactly like a live one — which is the point.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  detectOutboundCredential,
  HARD_WALL_CREDENTIAL_KINDS,
  HARD_WALL_EXCLUDED_KINDS,
  assertHardWallKindsExist,
} from '../../src/messaging/outbound-credential-guard.js';
import { DURABLE_SECRET_PATTERNS, scrubForStore } from '../../src/core/durableSecretScrub.js';
import { listPatternTypes } from '../../src/messaging/secret-patterns.js';

// ── canonical issued-shape generators (shared by tests 1, 2 and 2b) ──────────
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const alnum = (n: number) => Array.from({ length: n }, () => ALNUM[crypto.randomInt(ALNUM.length)]).join('');
const b64u = (bytes: number) => crypto.randomBytes(bytes).toString('base64url');

const GEN = {
  openaiProject: () => `sk-proj-${b64u(120)}`,
  openaiSvcAcct: () => `sk-svcacct-${b64u(120)}`,
  openaiAdmin: () => `sk-admin-${b64u(120)}`,
  openaiNone: () => `sk-None-${b64u(40)}`,
  openRouter: () => `sk-or-v1-${crypto.randomBytes(32).toString('hex')}`,
  openaiLegacy: () => `sk-${alnum(48)}`,
  githubFineGrained: () => `github_pat_${alnum(22)}_${alnum(59)}`,
  githubClassic: () => `ghp_${alnum(36)}`,
  githubOauth: () => `gho_${alnum(36)}`,
  anthropic: () => `sk-ant-api03-${b64u(70)}`,
  awsAccessKeyId: () => `AKIA${Array.from({ length: 16 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[crypto.randomInt(32)]).join('')}`,
  slackBot: () => `xoxb-${alnum(12)}-${alnum(12)}-${alnum(24)}`,
};
const wrap = (key: string) => `Here is what you asked for: ${key} — paste it when prompted.`;

// ── Test 1 — per-shape wall fixtures ─────────────────────────────────────────
describe('test 1 — the wall refuses every modern issued shape', () => {
  const MODERN: Array<[string, () => string]> = [
    ['OpenAI project key', GEN.openaiProject],
    ['OpenAI service-account key', GEN.openaiSvcAcct],
    ['OpenAI admin key', GEN.openaiAdmin],
    ['OpenAI None-scoped key', GEN.openaiNone],
    ['OpenRouter key', GEN.openRouter],
    ['GitHub fine-grained PAT', GEN.githubFineGrained],
  ];
  for (const [label, gen] of MODERN) {
    it(`refuses a ${label}`, () => {
      for (let i = 0; i < 25; i++) {
        const r = detectOutboundCredential(wrap(gen()));
        expect(r.detected, label).toBe(true);
      }
    });
  }

  it('still refuses every shape the wall already covered (no regression)', () => {
    for (const gen of [GEN.openaiLegacy, GEN.githubClassic, GEN.githubOauth, GEN.anthropic, GEN.awsAccessKeyId, GEN.slackBot]) {
      expect(detectOutboundCredential(wrap(gen())).detected).toBe(true);
    }
  });

  it('catches the key inside quotes, backticks, a URL query and JSON', () => {
    const k = GEN.openaiProject();
    for (const t of [`"${k}"`, `\`${k}\``, `https://api.example.com/v1?key=${k}`, `{"token":"${k}"}`]) {
      expect(detectOutboundCredential(t).detected).toBe(true);
    }
  });

  it('names the kind and never echoes the value', () => {
    const k = GEN.openaiProject();
    const r = detectOutboundCredential(wrap(k));
    expect(r.kind).toBe('openai-key');
    expect(JSON.stringify(r)).not.toContain(k.slice(0, 20));
  });
});

// ── Test 2 — drift guard against the richer messaging list ────────────────────
describe('test 2 — drift guard: every messaging pattern type is walled or exempt', () => {
  // Explicit mapping from src/messaging/secret-patterns.ts types to the wall.
  // An UNMAPPED type fails the test — the bidirectional half that catches a
  // new credential class added to one list only.
  const MAP: Record<string, { wallKind: string; sample: () => string } | { exempt: string }> = {
    'anthropic-key': { wallKind: 'anthropic-key', sample: GEN.anthropic },
    'openai-key': { wallKind: 'openai-key', sample: GEN.openaiProject },
    'aws-access-key-id': { wallKind: 'aws-access-key', sample: GEN.awsAccessKeyId },
    'github-pat-fine-grained': { wallKind: 'github-token', sample: GEN.githubFineGrained },
    'github-pat': { wallKind: 'github-token', sample: GEN.githubClassic },
    'slack-token': { wallKind: 'slack-token', sample: GEN.slackBot },
    'telegraph-token': { exempt: 'assignment-context pattern (access_token=…), not a bare credential shape' },
    'bearer-token': { exempt: 'context-dependent; deliberately excluded from the wall (HARD_WALL_EXCLUDED_KINDS)' },
  };

  it('has a mapping for every messaging pattern type', () => {
    const unmapped = listPatternTypes().filter((t) => !(t in MAP));
    expect(unmapped, `unmapped messaging pattern types: ${unmapped.join(', ')}`).toEqual([]);
  });

  it('refuses a canonical issued-shape sample for every mapped type', () => {
    for (const [type, m] of Object.entries(MAP)) {
      if ('exempt' in m) continue;
      expect(HARD_WALL_CREDENTIAL_KINDS.has(m.wallKind as never), `${type} maps to a non-wall kind`).toBe(true);
      const r = detectOutboundCredential(wrap(m.sample()));
      expect(r.detected, `wall missed a ${type} sample`).toBe(true);
    }
  });

  it('records bearer-token as a deliberate wall exclusion', () => {
    expect(Object.keys(HARD_WALL_EXCLUDED_KINDS)).toContain('bearer-token');
  });
});

// ── Test 2b — cross-file equivalence ratchet ─────────────────────────────────
describe('test 2b — every in-scope pattern copy carries the modern family', () => {
  // These copies keep module-private regexes in their own conventions; the
  // ratchet pins that each carries the modern sk-family alternation, so a
  // future hand-edit that drops it fails here instead of silently drifting.
  const ROOT = path.resolve(__dirname, '../..');
  const COPIES = [
    'src/threadline/ContentClassifier.ts',
    'src/core/redactUrl.ts',
    'src/threadline/openConversationBrief.ts',
    'src/core/ExecutionJournal.ts',
    'scripts/audit-secret-patterns.mjs',
    'src/monitoring/PromiseBeacon.ts',
    'src/monitoring/ClaimObservation.ts',
    'src/commands/testAsSelfValidation.ts',
    'src/core/PostUpdateMigrator.ts',
  ];
  it.each(COPIES)('%s carries the modern sk-family prefix set', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    expect(src).toContain('sk-(?:proj|svcacct|admin|None|or-v1)-');
  });
  it.each(COPIES.filter((c) => !['src/core/redactUrl.ts', 'scripts/audit-secret-patterns.mjs', 'src/commands/testAsSelfValidation.ts'].includes(c)))(
    '%s carries a github_pat_ pattern',
    (rel) => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toContain('github_pat_');
    },
  );
});

// ── Test 3 — no-false-positive fixtures, with the anchor class ───────────────
describe('test 3 — ordinary text passes; separator-joined keys do not', () => {
  it('passes prose that names the formats, bare prefixes, and kebab identifiers', () => {
    for (const t of [
      'Your sk-proj- key has expired; generate a new one in the console.',
      'GitHub fine-grained tokens start with github_pat_ and are about 82 characters long.',
      'The sk-or-v1- prefix identifies an OpenRouter key.',
      'rename sk-some-kebab-case-identifier-name and pk-another-long-kebab-identifier',
      'rk-rollout-plan-for-the-next-quarter-with-several-words',
    ]) {
      expect(detectOutboundCredential(t).detected, t).toBe(false);
    }
  });

  it('passes a kebab slug whose word ends in "sk" (the lookbehind exists for this)', () => {
    for (const t of [
      'task-proj-outbound-credential-wall-modern-key-formats-followup',
      'desk-proj-some-long-kebab-identifier-name-here-and-more',
    ]) {
      expect(detectOutboundCredential(t).detected, t).toBe(false);
    }
  });

  it('refuses underscore- and hyphen-joined keys (plausible real keys)', () => {
    expect(detectOutboundCredential(`MY_KEY_${GEN.openaiProject()}`).detected).toBe(true);
    expect(detectOutboundCredential(`MY_KEY_${GEN.githubFineGrained()}`).detected).toBe(true);
    expect(detectOutboundCredential(`x-${GEN.openaiProject()}`).detected).toBe(true);
  });

  it('refuses a long placeholder by design — shape is the contract', () => {
    expect(detectOutboundCredential(`sk-proj-${'X'.repeat(32)}`).detected).toBe(true);
  });
});

// ── Test 3b — invisible-character normalisation (wall only) ──────────────────
describe('test 3b — invisible interleave characters are stripped before the wall scans', () => {
  const INVISIBLES: Array<[string, string]> = [
    ['zero-width space', '​'],
    ['zero-width non-joiner', '‌'],
    ['zero-width joiner', '‍'],
    ['word joiner', '⁠'],
    ['byte-order mark', '﻿'],
    ['left-to-right mark', '‎'],
    ['soft hyphen', '­'],
    ['combining grapheme joiner', '͏'],
    ['variation selector-16', '️'],
  ];
  it.each(INVISIBLES)('a key interleaved with a %s is still refused', (_label, ch) => {
    const k = GEN.openaiProject();
    const atPrefix = `${k.slice(0, 4)}${ch}${k.slice(4)}`;
    const inBody = k.slice(0, 20) + k.slice(20, 60).split('').join(ch) + k.slice(60);
    expect(detectOutboundCredential(wrap(atPrefix)).detected).toBe(true);
    expect(detectOutboundCredential(wrap(inBody)).detected).toBe(true);
  });

  it('still refuses a key an invisible character SEPARATES from a preceding letter', () => {
    // Stripping would glue `ENV` onto the key and defeat \b / the lookbehind;
    // the raw scan still sees the boundary. (Regression guard vs raw-only.)
    expect(detectOutboundCredential(`ENV\u200B${GEN.githubClassic()}`).detected).toBe(true);
    expect(detectOutboundCredential(`ENV\u200B${GEN.openaiProject()}`).detected).toBe(true);
  });

  it('refuses on BOTH of two consecutive calls (no /g lastIndex statefulness)', () => {
    const t = wrap(GEN.openaiProject());
    expect(detectOutboundCredential(t).detected).toBe(true);
    expect(detectOutboundCredential(t).detected).toBe(true);
  });

  it('still fails closed on oversize input, checked on the RAW length', () => {
    const r = detectOutboundCredential('a'.repeat(1_000_001));
    expect(r).toEqual({ detected: true, kind: 'oversize-unscannable' });
  });

  it('the scrubber does NOT strip — its spans stay valid offsets into the original', () => {
    const k = GEN.openaiProject();
    const text = `lead ${k} tail`;
    const r = scrubForStore(text);
    expect(r.redactions.length).toBeGreaterThan(0);
    for (const span of r.redactions) {
      expect(span.offset).toBeGreaterThanOrEqual(0);
      expect(span.offset + span.length).toBeLessThanOrEqual(text.length);
      expect(text.slice(span.offset, span.offset + span.length)).toBe(k);
    }
  });
});

// ── Test 4 — redaction fixtures (the scrubber side) ──────────────────────────
describe('test 4 — the shared scrubber redacts the new formats completely', () => {
  it.each([
    ['OpenAI project', GEN.openaiProject, 'openai-key'],
    ['OpenRouter', GEN.openRouter, 'openai-key'],
    ['GitHub fine-grained', GEN.githubFineGrained, 'github-token'],
  ] as const)('%s: full span replaced, kind labelled, surroundings kept', (_l, gen, kind) => {
    const k = gen();
    const r = scrubForStore(`before ${k} after`);
    expect(r.text).not.toContain(k.slice(8, 40));
    expect(r.text.startsWith('before ')).toBe(true);
    expect(r.text.endsWith(' after')).toBe(true);
    expect(r.redactions.some((s) => s.kind === kind)).toBe(true);
  });
});

// ── Test 5 — linearity, falsifiable ──────────────────────────────────────────
describe('test 5 — adversarial timing: the new patterns stay linear', () => {
  const byKind = (re: RegExp, input: string) => {
    re.lastIndex = 0;
    const t0 = performance.now();
    // exhaust all matches, as the scrubber does
    // eslint-disable-next-line no-empty
    while (re.exec(input)) {}
    return performance.now() - t0;
  };
  const NEW = DURABLE_SECRET_PATTERNS.filter((p) => /svcacct|github_pat/.test(p.regex.source));

  it('the two new patterns are present', () => {
    expect(NEW).toHaveLength(2);
  });

  it('near-miss repeated prefixes scan fast (no backtracking)', () => {
    const skNearMiss = (`sk-proj-${'a'.repeat(30)} `).repeat(25_000);
    const patNearMiss = (`github_pat_${'a'.repeat(30)} `).repeat(25_000);
    for (const p of NEW) {
      expect(byKind(new RegExp(p.regex.source, 'gd'), skNearMiss)).toBeLessThan(500);
      expect(byKind(new RegExp(p.regex.source, 'gd'), patNearMiss)).toBeLessThan(500);
    }
  });

  it('a 64 KB unbroken run WITH interior word boundaries stays within every pattern budget', () => {
    // The input class is part of the contract: a pure alphanumeric run is
    // vacuous (interior \b never fires); hyphens ignite quadratic patterns.
    const run = ('a'.repeat(20) + '-').repeat(Math.ceil(65_536 / 21)).slice(0, 65_536);
    // This fixture found two pre-existing quadratic patterns (jwt and
    // url-embedded-credential); both are now capped, so NO pattern is exempt.
    for (const p of DURABLE_SECRET_PATTERNS) {
      const ms = byKind(new RegExp(p.regex.source, 'gd'), run);
      expect(ms, `${p.kind} took ${ms.toFixed(0)}ms`).toBeLessThan(250);
    }
  });

  it('the capped jwt and url patterns still detect what they detected before', () => {
    const url = DURABLE_SECRET_PATTERNS.find((p) => p.kind === 'url-embedded-credential')!;
    const jwt = DURABLE_SECRET_PATTERNS.find((p) => p.kind === 'jwt')!;
    const hit = (re: RegExp, s: string) => { re.lastIndex = 0; return re.test(s); };
    for (const s of [
      'see https://alice:s3cret@example.com/x',
      'git+ssh://bob:pw@host.io/repo',
      '1https://u:p@h.com/',
      `${'x'.repeat(200)}https://u:p@host/`,
    ]) expect(hit(url.regex, s), s).toBe(true);
    const seg = (n: number) => crypto.randomBytes(n).toString('base64url');
    expect(hit(jwt.regex, `token ${seg(27)}.${seg(40)}.${seg(32)} end`)).toBe(true);
  });
});

// ── Test 6 — structural assumptions ──────────────────────────────────────────
describe('test 6 — structural assumptions hold', () => {
  it('two entries share kind openai-key and both are applied', () => {
    const openai = DURABLE_SECRET_PATTERNS.filter((p) => p.kind === 'openai-key');
    expect(openai.length).toBeGreaterThanOrEqual(2);
    expect(detectOutboundCredential(wrap(GEN.openaiLegacy())).detected).toBe(true);
    expect(detectOutboundCredential(wrap(GEN.openaiProject())).detected).toBe(true);
  });

  it('every wall kind still exists in the shared list', () => {
    expect(assertHardWallKindsExist()).toEqual([]);
  });
});
