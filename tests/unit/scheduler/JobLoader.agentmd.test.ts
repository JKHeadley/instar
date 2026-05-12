/**
 * Phase 1a tests for the agentmd JobLoader path.
 *
 * Covers: happy path, mixed-state precedence, case-fold collision,
 * backwards compatibility, YAML hardening, Zod preprocessor coercion,
 * path safety, and the SchedulerProbe-equivalent invariant (agentmd
 * body hydrated in memory after loadJobs).
 *
 * Spec: docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadJobs } from '../../../src/scheduler/JobLoader.js';
import {
  loadAgentMdJobs,
  validateManifest,
  isAgentMdJobHydrated,
  BoolField,
  IntField,
  READ_CONCURRENCY_LIMIT,
} from '../../../src/scheduler/AgentMdJobLoader.js';
import { buildSyntheticAgent, mkManifest, mkAgentMd } from './agentmd-helpers.js';

describe('JobLoader · agentmd (Phase 1a)', () => {
  const agents: { cleanup: () => void }[] = [];
  beforeEach(() => { agents.length = 0; });
  afterEach(() => { for (const a of agents) a.cleanup(); });

  function setup(layout: Parameters<typeof buildSyntheticAgent>[0]) {
    const a = buildSyntheticAgent(layout);
    agents.push(a);
    return a;
  }

  // ── Happy path ────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('loads a single agentmd job with body + frontmatter populated', () => {
      const a = setup({
        manifests: { 'health-check': mkManifest({ slug: 'health-check' }) },
        instarMd: { 'health-check': mkAgentMd({
          frontmatter: { name: 'Health Check', description: 'Probe the system.' },
          body: '# Health Check\nDo the thing.\n',
        }) },
      });

      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].slug).toBe('health-check');
      expect(jobs[0].name).toBe('Health Check');
      expect(jobs[0].description).toBe('Probe the system.');
      expect(jobs[0].body).toBe('# Health Check\nDo the thing.\n');
      expect(jobs[0].frontmatter).toEqual({
        name: 'Health Check',
        description: 'Probe the system.',
      });
      expect(jobs[0].origin).toBe('instar');
      expect(jobs[0].execute.type).toBe('agentmd');
    });

    it('falls back to manifest slug when frontmatter omits name/description', () => {
      const a = setup({
        manifests: { foo: mkManifest({ slug: 'foo' }) },
        instarMd: { foo: '---\n---\nbody only' },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe('foo');
      expect(jobs[0].description).toMatch(/agentmd job foo/);
    });

    it('loads multiple agentmd jobs concurrently within the bounded limit', () => {
      const manifests: Record<string, unknown> = {};
      const instarMd: Record<string, string> = {};
      const N = 10;
      for (let i = 0; i < N; i++) {
        const slug = `bulk-${i}`;
        manifests[slug] = mkManifest({ slug });
        instarMd[slug] = mkAgentMd({
          frontmatter: { name: `bulk ${i}`, description: 'auto' },
          body: `body ${i}\n`,
        });
      }
      const a = setup({ manifests, instarMd });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        const job = jobs.find((j) => j.slug === `bulk-${i}`);
        expect(job?.body).toBe(`body ${i}\n`);
        expect(isAgentMdJobHydrated(job!)).toBe(true);
      }
    });

    it('exposes the bounded-concurrency limit at 32', () => {
      expect(READ_CONCURRENCY_LIMIT).toBe(32);
    });
  });

  // ── YAML hardening ────────────────────────────────────────────────────

  describe('YAML hardening', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warnSpy.mockRestore(); });

    it('rejects billion-laughs payload', () => {
      // The payload itself uses anchors/aliases — anchor walk rejects it
      // before any expansion can happen.
      const blPayload = [
        'a: &a hello',
        'b: &b [*a,*a,*a,*a,*a,*a,*a]',
        'c: &c [*b,*b,*b,*b,*b,*b,*b]',
      ].join('\n');
      const a = setup({
        manifests: { bl: mkManifest({ slug: 'bl' }) },
        instarMd: { bl: `---\n${blPayload}\n---\nbody` },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(0);
      expect(warnSpy.mock.calls.flat().some((s) =>
        typeof s === 'string' && s.includes('agentmd-yaml-invalid'))).toBe(true);
    });

    it('rejects !!js/function via FAILSAFE_SCHEMA', () => {
      const a = setup({
        manifests: { jfn: mkManifest({ slug: 'jfn' }) },
        instarMd: { jfn: '---\nname: !!js/function "function () {}"\n---\nbody' },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(0);
    });

    it('rejects !!python/object via FAILSAFE_SCHEMA', () => {
      const a = setup({
        manifests: { py: mkManifest({ slug: 'py' }) },
        instarMd: { py: '---\nname: !!python/object "os.system"\n---\nbody' },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(0);
    });

    it('rejects YAML anchors and aliases at the parsed-tree walk', () => {
      const a = setup({
        manifests: { anc: mkManifest({ slug: 'anc' }) },
        instarMd: { anc: '---\nname: &foo "bar"\ndescription: *foo\n---\nbody' },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(0);
    });

    it('ACCEPTS anchor-like text inside string values (Bash & Read, *.md)', () => {
      // Crucial spec correctness check: the raw-text regex would over-reject
      // these. The parsed-tree walk does not.
      const a = setup({
        manifests: { ok: mkManifest({ slug: 'ok' }) },
        instarMd: { ok: '---\nname: "Tools"\ndescription: "Use Bash & Read for *.md files"\n---\nbody' },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].frontmatter?.description).toBe('Use Bash & Read for *.md files');
    });

    it('rejects oversize frontmatter (>16 KB)', () => {
      const huge = 'x'.repeat(20 * 1024);
      const a = setup({
        manifests: { big: mkManifest({ slug: 'big' }) },
        instarMd: { big: `---\nname: "ok"\ndescription: "${huge}"\n---\nbody` },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(0);
    });

    it('rejects oversize body (>64 KB)', () => {
      const huge = 'b'.repeat(70 * 1024);
      const a = setup({
        manifests: { hugebody: mkManifest({ slug: 'hugebody' }) },
        instarMd: { hugebody: `---\nname: "ok"\n---\n${huge}` },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(0);
    });

    it('rejects unknown frontmatter keys', () => {
      const a = setup({
        manifests: { uk: mkManifest({ slug: 'uk' }) },
        instarMd: { uk: '---\nname: "ok"\nrandomUnknownKey: "evil"\n---\nbody' },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(0);
    });

    it('rejects file missing the YAML frontmatter block', () => {
      const a = setup({
        manifests: { plain: mkManifest({ slug: 'plain' }) },
        instarMd: { plain: '# No frontmatter\nJust body content.' },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(0);
    });
  });

  // ── Zod preprocessor coercion (spec §6) ───────────────────────────────

  describe('Zod preprocessors', () => {
    describe('BoolField', () => {
      it.each([
        ['true', true],
        ['True', true],
        ['TRUE', true],
        ['false', false],
        ['False', false],
        ['FALSE', false],
      ] as const)('coerces %s → %s', (input, expected) => {
        expect(BoolField.parse(input)).toBe(expected);
      });

      it.each(['yes', 'no', 'on', 'off', 'Y', 'N', '1', '0', ''])(
        'rejects %s',
        (bad) => {
          expect(() => BoolField.parse(bad)).toThrow();
        },
      );

      it('passes through native booleans', () => {
        expect(BoolField.parse(true)).toBe(true);
        expect(BoolField.parse(false)).toBe(false);
      });
    });

    describe('IntField', () => {
      it('coerces ASCII integer strings', () => {
        expect(IntField.parse('1')).toBe(1);
        expect(IntField.parse('-42')).toBe(-42);
        expect(IntField.parse('0')).toBe(0);
      });

      it('passes through native numbers', () => {
        expect(IntField.parse(7)).toBe(7);
      });

      it('rejects floats', () => {
        expect(() => IntField.parse('1.5')).toThrow();
        expect(() => IntField.parse(1.5)).toThrow();
      });

      it('rejects NaN', () => {
        expect(() => IntField.parse('NaN')).toThrow();
        expect(() => IntField.parse(Number.NaN)).toThrow();
      });

      it('rejects Infinity', () => {
        expect(() => IntField.parse('Infinity')).toThrow();
        expect(() => IntField.parse(Number.POSITIVE_INFINITY)).toThrow();
      });

      it('rejects non-ASCII digit shapes', () => {
        // Arabic-Indic 1 — looks numeric, regex rejects it.
        expect(() => IntField.parse('١')).toThrow();
      });
    });
  });

  // ── Path safety ───────────────────────────────────────────────────────

  describe('path safety', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warnSpy.mockRestore(); });

    it('rejects symlinked .md files', () => {
      const a = setup({
        manifests: { sym: mkManifest({ slug: 'sym' }) },
        instarMd: { 'target-actual': mkAgentMd() },
      });
      // Replace the would-be sym.md with a symlink to target-actual.md.
      const symPath = path.join(a.jobsRoot, 'instar', 'sym.md');
      fs.symlinkSync(path.join(a.jobsRoot, 'instar', 'target-actual.md'), symPath);

      const jobs = loadJobs(a.jobsFile);
      // The symlinked entry is skipped; target-actual has no manifest so it
      // is not loaded; final result is empty.
      expect(jobs).toHaveLength(0);
    });

    it('rejects NFD-encoded slug at the regex', () => {
      // "café" with NFD encoding (c + a + f + e + U+0301) — non-ASCII fails.
      const nfd = 'café';
      expect(() => validateManifest(mkManifest({ slug: nfd }), 'nfd.json')).toThrow(
        /slug/i,
      );
    });

    it('rejects RTL override (U+202E) in slug', () => {
      expect(() => validateManifest(mkManifest({ slug: 'evil‮txt' }), 'rtl.json')).toThrow();
    });

    it.each([
      ['ZWJ', 'foo‍bar'],
      ['ZWNJ', 'foo‌bar'],
      ['ZWSP', 'foo​bar'],
    ])('rejects %s in slug', (_label, slug) => {
      expect(() => validateManifest(mkManifest({ slug }), 'zwj.json')).toThrow();
    });

    it('rejects dotless-i (İ) at the ASCII regex', () => {
      expect(() => validateManifest(mkManifest({ slug: 'İ' }), 'di.json')).toThrow();
      expect(() => validateManifest(mkManifest({ slug: 'İ' }), 'di2.json')).toThrow();
    });

    it('rejects ".." in slug', () => {
      expect(() => validateManifest(mkManifest({ slug: '..' }), 'dotdot.json')).toThrow();
      expect(() => validateManifest(mkManifest({ slug: 'a/../b' }), 'traversal.json')).toThrow();
    });

    it('rejects leading "/" in slug', () => {
      expect(() => validateManifest(mkManifest({ slug: '/abs' }), 'abs.json')).toThrow();
    });

    it('rejects NUL byte in slug', () => {
      expect(() => validateManifest(mkManifest({ slug: 'a\x00b' }), 'nul.json')).toThrow();
    });

    it('rejects empty slug', () => {
      expect(() => validateManifest(mkManifest({ slug: '' }), 'empty.json')).toThrow();
    });

    it('rejects 101-char slug', () => {
      expect(() => validateManifest(mkManifest({ slug: 'a'.repeat(101) }), 'long.json')).toThrow();
    });

    it('accepts a 100-char slug', () => {
      expect(() => validateManifest(mkManifest({ slug: 'a'.repeat(100) }), 'max.json')).not.toThrow();
    });
  });

  // ── Case-fold collision ───────────────────────────────────────────────

  describe('case-fold collision', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warnSpy.mockRestore(); });

    it('instar wins over user on case-fold collision', () => {
      // Real filesystem cannot hold two filenames that differ only in case
      // on macOS/Windows. Use distinct base filenames; the collision is on
      // the slug field inside the manifest, which is exactly what the
      // spec's "case-fold collision across all loaded entries" means.
      const a = setup({
        manifests: {
          'instar-entry': mkManifest({ slug: 'health-check', origin: 'instar' }),
          'user-entry': mkManifest({ slug: 'Health-Check', origin: 'user' }),
        },
        instarMd: { 'health-check': mkAgentMd() },
        userMd: { 'Health-Check': mkAgentMd() },
      });

      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].slug).toBe('health-check');
      expect(jobs[0].origin).toBe('instar');
      // Problem should mention the user-namespace entry being skipped.
      const warnings = warnSpy.mock.calls.flat().filter((x) => typeof x === 'string');
      expect(warnings.some((s) => s.includes('case-fold-collision'))).toBe(true);
    });

    it('skips both on same-origin collision', () => {
      const a = setup({
        manifests: {
          'a-entry': mkManifest({ slug: 'foo-bar', origin: 'user' }),
          'b-entry': mkManifest({ slug: 'Foo-Bar', origin: 'user' }),
        },
        userMd: { 'foo-bar': mkAgentMd(), 'Foo-Bar': mkAgentMd() },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(0);
    });

    it('does not warn when no collisions exist', () => {
      const a = setup({
        manifests: {
          'aa': mkManifest({ slug: 'aa', origin: 'instar' }),
          'bb': mkManifest({ slug: 'bb', origin: 'user' }),
        },
        instarMd: { 'aa': mkAgentMd() },
        userMd: { 'bb': mkAgentMd() },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(2);
      const warnings = warnSpy.mock.calls.flat().filter((x) => typeof x === 'string');
      expect(warnings.some((s) => s.includes('case-fold-collision'))).toBe(false);
    });
  });

  // ── Mixed-state precedence ────────────────────────────────────────────

  describe('mixed-state precedence', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warnSpy.mockRestore(); });

    it('per-slug manifest shadows legacy jobs.json entry of the same slug', () => {
      const a = setup({
        jobsJson: [{
          slug: 'shared',
          name: 'Legacy Shared',
          description: 'legacy',
          schedule: '0 * * * *',
          priority: 'low',
          expectedDurationMinutes: 1,
          model: 'haiku',
          enabled: true,
          execute: { type: 'prompt', value: 'do legacy thing' },
        }],
        manifests: { shared: mkManifest({ slug: 'shared' }) },
        instarMd: { shared: mkAgentMd({
          frontmatter: { name: 'New Shared', description: 'agentmd wins' },
        }) },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe('New Shared');
      expect(jobs[0].execute.type).toBe('agentmd');
    });

    it('keeps legacy entries that have no shadow', () => {
      const a = setup({
        jobsJson: [{
          slug: 'only-legacy',
          name: 'Only Legacy',
          description: 'unique to jobs.json',
          schedule: '0 * * * *',
          priority: 'low',
          expectedDurationMinutes: 1,
          model: 'haiku',
          enabled: true,
          execute: { type: 'prompt', value: 'legacy prompt' },
        }],
        manifests: { newish: mkManifest({ slug: 'newish' }) },
        instarMd: { newish: mkAgentMd() },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(2);
      const slugs = jobs.map((j) => j.slug).sort();
      expect(slugs).toEqual(['newish', 'only-legacy']);
    });

    it('loads schedule-only state (no jobs.json present)', () => {
      const a = setup({
        manifests: { lonely: mkManifest({ slug: 'lonely' }) },
        instarMd: { lonely: mkAgentMd() },
      });
      expect(fs.existsSync(a.jobsFile)).toBe(false);
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].slug).toBe('lonely');
    });
  });

  // ── Backwards compatibility ──────────────────────────────────────────

  describe('backwards compatibility', () => {
    it('legacy jobs.json-only state loads identically to today', () => {
      const a = setup({
        jobsJson: [{
          slug: 'legacy-1',
          name: 'Legacy 1',
          description: 'pre-spec entry',
          schedule: '0 * * * *',
          priority: 'medium',
          expectedDurationMinutes: 2,
          model: 'sonnet',
          enabled: true,
          execute: { type: 'skill', value: 'reflection' },
        }],
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].slug).toBe('legacy-1');
      expect(jobs[0].execute.type).toBe('skill');
      expect(jobs[0].execute.value).toBe('reflection');
      // Legacy entries do NOT carry origin/body/frontmatter — preserved.
      expect(jobs[0].origin).toBeUndefined();
      expect(jobs[0].body).toBeUndefined();
      expect(jobs[0].frontmatter).toBeUndefined();
    });

    it('returns empty when both jobs.json and schedule/ are absent', () => {
      const a = setup({});
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(0);
    });
  });

  // ── SchedulerProbe-equivalent invariant ──────────────────────────────

  describe('hydration invariant', () => {
    it('every agentmd job in the returned list has body populated', () => {
      const a = setup({
        manifests: {
          one: mkManifest({ slug: 'one' }),
          two: mkManifest({ slug: 'two' }),
        },
        instarMd: {
          one: mkAgentMd({ body: 'body one\n' }),
          two: mkAgentMd({ body: 'body two\n' }),
        },
      });
      const jobs = loadJobs(a.jobsFile);
      expect(jobs).toHaveLength(2);
      for (const j of jobs) {
        if (j.execute.type === 'agentmd') {
          expect(isAgentMdJobHydrated(j)).toBe(true);
          expect(typeof j.body).toBe('string');
          expect(j.body!.length).toBeGreaterThan(0);
        }
      }
    });

    it('isAgentMdJobHydrated returns true for non-agentmd jobs trivially', () => {
      const legacy = {
        slug: 'legacy',
        name: 'Legacy',
        description: 'old style',
        schedule: '0 * * * *',
        priority: 'low' as const,
        expectedDurationMinutes: 1,
        model: 'haiku' as const,
        enabled: true,
        execute: { type: 'prompt' as const, value: 'do it' },
      };
      expect(isAgentMdJobHydrated(legacy)).toBe(true);
    });
  });

  // ── Manifest validation edge cases ───────────────────────────────────

  describe('manifest validation', () => {
    it('rejects manifest with execute.type=agentmd and a value field set', () => {
      expect(() => validateManifest({
        ...mkManifest({ slug: 'x' }),
        execute: { type: 'agentmd', value: 'ghost' },
      }, 'x.json')).toThrow(/value/);
    });

    it('rejects unknown origin value', () => {
      expect(() => validateManifest(mkManifest({ origin: 'other' }), 'o.json')).toThrow(/origin/);
    });

    it('rejects non-boolean enabled', () => {
      expect(() => validateManifest(mkManifest({ enabled: 'yes' }), 'b.json')).toThrow(/enabled/);
    });

    it('rejects invalid cron expression', () => {
      expect(() => validateManifest(mkManifest({ schedule: 'definitely-not-cron' }), 'c.json')).toThrow(/cron/);
    });

    it('rejects negative expectedDurationMinutes', () => {
      expect(() => validateManifest(mkManifest({ expectedDurationMinutes: -1 }), 'd.json')).toThrow(/expectedDurationMinutes/);
    });

    it('rejects unknown execute.type', () => {
      expect(() => validateManifest({
        ...mkManifest({}),
        execute: { type: 'weird' as unknown as 'agentmd' },
      }, 'e.json')).toThrow(/execute\.type/);
    });

    it('accepts a legacy execute.type=prompt manifest (loader-side compat)', () => {
      expect(() => validateManifest({
        ...mkManifest({ slug: 'compat' }),
        execute: { type: 'prompt', value: 'inline prompt body' },
      }, 'compat.json')).not.toThrow();
    });
  });

  // ── loadAgentMdJobs direct contract ───────────────────────────────────

  describe('loadAgentMdJobs (direct)', () => {
    it('returns empty + no problems when schedule dir does not exist', () => {
      const a = setup({});
      const result = loadAgentMdJobs(a.scheduleDir, a.jobsRoot);
      expect(result.jobs).toHaveLength(0);
      expect(result.problems).toHaveLength(0);
    });

    it('produces a problem for an invalid manifest but continues with valid ones', () => {
      const a = setup({
        manifests: {
          good: mkManifest({ slug: 'good' }),
          bad: { not: 'a valid manifest' },
        },
        instarMd: { good: mkAgentMd() },
      });
      const result = loadAgentMdJobs(a.scheduleDir, a.jobsRoot);
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].slug).toBe('good');
      expect(result.problems.length).toBeGreaterThan(0);
      expect(result.problems[0].kind).toBe('manifest-invalid');
    });

    it('produces a problem for missing .md file but continues with present ones', () => {
      const a = setup({
        manifests: {
          present: mkManifest({ slug: 'present' }),
          absent: mkManifest({ slug: 'absent' }),
        },
        instarMd: { present: mkAgentMd() },
      });
      const result = loadAgentMdJobs(a.scheduleDir, a.jobsRoot);
      expect(result.jobs.map((j) => j.slug)).toEqual(['present']);
      const absent = result.problems.find((p) => p.slug === 'absent');
      expect(absent?.kind).toBe('agentmd-file-missing');
    });
  });
});
