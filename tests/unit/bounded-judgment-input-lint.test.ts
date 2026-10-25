/**
 * The guard for *Never Silently Cut the Data a Decision Depends On* must actually bite. A ratchet
 * nobody has watched fail is a ratchet nobody knows is wired — the exact
 * "documented, not enforced" state this repo keeps rediscovering.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findBareTruncationSites,
  validateBoundedJudgmentInput,
} from '../../scripts/lint-bounded-judgment-input.mjs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('bounded-judgment-input ratchet', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'bounded-input lint test cleanup' });
    }
  });

  function fixture(source: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-input-lint-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'Gate.ts'), source);
    return root;
  }

  const BARE = `
    const prompt = 'x';
    async function judge(text: string, provider: IntelligenceProvider) {
      const messageSlice = text.slice(0, 500);
      return provider.evaluate(\`Judge this: \${messageSlice}\`);
    }
  `;

  it('FINDS a bare truncation fed to a prompt — the shape the standard governs', () => {
    expect(findBareTruncationSites(fixture(BARE))).toEqual(['src/Gate.ts:messageSlice']);
  });

  it('FAILS on a new site absent from the baseline', () => {
    const { errors } = validateBoundedJudgmentInput(fixture(BARE), { grandfatheredBareTruncation: [], ceiling: 0 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('src/Gate.ts:messageSlice');
    expect(errors[0]).toContain('boundedInput');
  });

  it('PASSES the same site once baselined — the population may be inherited, not grown', () => {
    const { errors } = validateBoundedJudgmentInput(fixture(BARE), {
      grandfatheredBareTruncation: ['src/Gate.ts:messageSlice'],
      ceiling: 1,
    });
    expect(errors).toEqual([]);
  });

  it('is CLEAN when the site bounds through the helper instead', () => {
    const root = fixture(`
      const prompt = 'x';
      async function judge(text: string, provider: IntelligenceProvider) {
        const messageSlice = boundedHead(text, 8000);
        return provider.evaluate(\`Judge this: \${messageSlice}\`);
      }
    `);
    expect(findBareTruncationSites(root)).toEqual([]);
  });

  it('SHRINK-ONLY: a baselined site that was fixed must be removed from the baseline', () => {
    // Otherwise a stale baseline quietly re-permits the pattern at that name.
    const root = fixture(`
      const prompt = 'x';
      async function judge(text: string, provider: IntelligenceProvider) {
        const messageSlice = boundedHead(text, 8000);
        return provider.evaluate(\`Judge this: \${messageSlice}\`);
      }
    `);
    const { errors } = validateBoundedJudgmentInput(root, {
      grandfatheredBareTruncation: ['src/Gate.ts:messageSlice'],
      ceiling: 1,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('may only shrink');
  });

  it('IGNORES an identifier clamp — the population must stay the real thing', () => {
    // `sha.slice(0, 8)` is not a bound on judgment input, and a lint that
    // flagged it would be ignored into uselessness.
    const root = fixture(`
      const prompt = 'x';
      async function judge(sha: string, provider: IntelligenceProvider) {
        const shortSha = sha.slice(0, 8);
        return provider.evaluate(\`Commit \${shortSha}\`);
      }
    `);
    expect(findBareTruncationSites(root)).toEqual([]);
  });

  it('IGNORES a truncation that never reaches a prompt — this rule is about judgment input', () => {
    // Bounding a value you are only going to LOG or STORE is governed by the
    // sibling article (*Expected Capacity Enforcement*), not this one.
    const root = fixture(`
      const prompt = 'x';
      function audit(text: string, provider: IntelligenceProvider) {
        const head = text.slice(0, 4000);
        log.write(head);
        return provider.evaluate('unrelated');
      }
    `);
    expect(findBareTruncationSites(root)).toEqual([]);
  });

  it('honours an explicit reviewed exemption, which must state a reason', () => {
    const root = fixture(`
      const prompt = 'x';
      async function judge(text: string, provider: IntelligenceProvider) {
        // bounded-input-reviewed: the consumer re-reads the full value from disk itself
        const messageSlice = text.slice(0, 500);
        return provider.evaluate(\`Judge this: \${messageSlice}\`);
      }
    `);
    expect(findBareTruncationSites(root)).toEqual([]);
  });

  it('the LIVE repo is clean against its own baseline', () => {
    const root = process.cwd();
    const baseline = JSON.parse(fs.readFileSync(path.join(root, 'docs/bounded-judgment-input-baseline.json'), 'utf8'));
    expect(validateBoundedJudgmentInput(root, baseline).errors).toEqual([]);
  });
});

describe('the context guard cannot be routed around', () => {
  it('no caller invokes a reviewer family directly, bypassing runCrossModelReview', () => {
    // THE C1 RATCHET. The load-bearing context refusal lives in exactly one
    // place; a caller that reaches `family.review(...)` itself gets a reviewer
    // with no refusal, which is precisely how the guard came to be live on a path
    // nothing used while the path everything used spent the model on a partial
    // view. Fixing that once is not enough — nothing stopped it coming back.
    const roots = ['skills', 'src', 'scripts'];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!/\.(ts|mjs|js)$/.test(p)) continue;
        // The module that DEFINES the chokepoint is allowed to call through it.
        if (p.endsWith('src/core/crossModelReviewer.ts')) continue;
        let src: string;
        try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }
        for (const line of src.split('\n')) {
          if (/^\s*(?:\/\/|\*)/.test(line)) continue;
          if (/\b(?:familyEntry|family|entry)\.review\s*\(/.test(line)) offenders.push(`${p}: ${line.trim().slice(0, 100)}`);
        }
      }
    };
    roots.forEach(walk);
    expect(offenders, 'these call a reviewer family directly and so skip the load-bearing context refusal in runCrossModelReview — route them through it (pass `family: <id>`) instead').toEqual([]);
  });
});
