// safe-git-allow: unit-test tmpdir teardown (fs.rmSync on a mkdtemp dir; SafeFsExecutor would emit an audit entry per test run — same rationale as the other tmpdir-cleanup tests on the destructive-lint allowlist)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error - plain ESM script, no types
import { checkModelRegistryFreshness, frontierSetForDoor } from '../../scripts/lint-model-registry-freshness.mjs';

/**
 * Semantic-correctness tests for the model-registry freshness guard.
 * Both teeth are exercised on BOTH sides of their decision boundary
 * (Testing Integrity Standard), plus a live check that the SHIPPED manifest
 * is self-consistent in its own report mode.
 */

let root: string;
const relFile = 'src/providers/adapters/fake/models.ts';

function writeManifest(dir: string, m: Record<string, unknown>): string {
  const p = path.join(dir, 'manifest.json');
  fs.writeFileSync(p, JSON.stringify(m));
  return p;
}

const NOW = new Date('2026-07-03T00:00:00Z');

const basePin = {
  id: 'fake-capable',
  door: 'fake',
  tier: 'capable',
  file: relFile,
  regex: "capable:\\s*'((?:claude|gpt|gemini)-[^']+)'",
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrf-'));
  fs.mkdirSync(path.join(root, path.dirname(relFile)), { recursive: true });
  fs.writeFileSync(path.join(root, relFile), `const T = { capable: 'gemini-2.5-pro' };\n`);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function run(manifest: Record<string, unknown>) {
  const manifestPath = writeManifest(root, manifest);
  return checkModelRegistryFreshness({ manifestPath, repoRoot: root, now: NOW, forceStrict: false });
}

describe('STALENESS tooth', () => {
  const freshManifest = {
    lastReviewedAt: '2026-07-01',
    stalenessWindowDays: 45,
    enforcement: 'report',
    frontierAllowlist: { fake: ['gemini-2.5-pro'] },
    pins: [basePin],
  };

  it('passes when lastReviewedAt is inside the window', () => {
    const r = run(freshManifest);
    expect(r.findings.filter((f: string) => f.startsWith('STALENESS'))).toHaveLength(0);
  });

  it('fails LOUDLY when lastReviewedAt is older than the window', () => {
    const r = run({ ...freshManifest, lastReviewedAt: '2026-01-01' });
    const stale = r.findings.filter((f: string) => f.startsWith('STALENESS'));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain('exceeds the 45d window');
  });

  it('fails when lastReviewedAt is missing/unparseable', () => {
    const r = run({ ...freshManifest, lastReviewedAt: 'not-a-date' });
    expect(r.findings.some((f: string) => f.startsWith('STALENESS'))).toBe(true);
  });
});

describe('DRIFT tooth', () => {
  const base = {
    lastReviewedAt: '2026-07-01',
    stalenessWindowDays: 45,
    enforcement: 'report',
    pins: [basePin],
  };

  it('passes when the pinned id IS in the door allowlist', () => {
    const r = run({ ...base, frontierAllowlist: { fake: ['gemini-2.5-pro'] } });
    expect(r.findings.filter((f: string) => f.startsWith('DRIFT'))).toHaveLength(0);
  });

  it('fails when the pinned id is NOT in the door allowlist (rot detected)', () => {
    const r = run({ ...base, frontierAllowlist: { fake: ['gemini-3-pro-preview'] } });
    const drift = r.findings.filter((f: string) => f.startsWith('DRIFT'));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("pins 'gemini-2.5-pro'");
  });

  it('fails when the pin file is missing (a pin site moved)', () => {
    const r = run({
      ...base,
      frontierAllowlist: { fake: ['gemini-2.5-pro'] },
      pins: [{ ...basePin, file: 'src/does/not/exist.ts' }],
    });
    expect(r.findings.some((f: string) => f.startsWith('DRIFT') && f.includes('missing'))).toBe(true);
  });

  it('fails when the pin regex no longer matches (site changed shape)', () => {
    const r = run({
      ...base,
      frontierAllowlist: { fake: ['gemini-2.5-pro'] },
      pins: [{ ...basePin, regex: "heavyTier:\\s*'([^']+)'" }],
    });
    expect(r.findings.some((f: string) => f.startsWith('DRIFT') && f.includes('did not match'))).toBe(true);
  });
});

describe('flaggedStale + enforcement gating', () => {
  const manifest = {
    lastReviewedAt: '2026-07-01',
    stalenessWindowDays: 45,
    enforcement: 'report',
    frontierAllowlist: { fake: ['gemini-2.5-pro'] },
    pins: [basePin],
    flaggedStale: [
      { door: 'fake', pin: 'fake-capable', currentId: 'gemini-2.5-pro', suspectedFrontier: 'gemini-3-pro-preview' },
    ],
  };

  it('report mode: flaggedStale is a WARNING, never a gating finding', () => {
    const manifestPath = writeManifest(root, manifest);
    const r = checkModelRegistryFreshness({ manifestPath, repoRoot: root, now: NOW, forceStrict: false });
    expect(r.strict).toBe(false);
    expect(r.warnings.some((w: string) => w.startsWith('FLAGGED-STALE'))).toBe(true);
    expect(r.findings.some((f: string) => f.startsWith('FLAGGED-STALE'))).toBe(false);
  });

  it('strict mode: flaggedStale becomes a gating finding', () => {
    const manifestPath = writeManifest(root, { ...manifest, enforcement: 'strict' });
    const r = checkModelRegistryFreshness({ manifestPath, repoRoot: root, now: NOW, forceStrict: false });
    expect(r.strict).toBe(true);
    expect(r.findings.some((f: string) => f.startsWith('FLAGGED-STALE'))).toBe(true);
  });

  it('forceStrict flips a report manifest to gating', () => {
    const manifestPath = writeManifest(root, manifest);
    const r = checkModelRegistryFreshness({ manifestPath, repoRoot: root, now: NOW, forceStrict: true });
    expect(r.strict).toBe(true);
  });
});

describe('DERIVED frontier set (§1.4 — one source of truth, schema v2)', () => {
  const base = {
    lastReviewedAt: '2026-07-01',
    stalenessWindowDays: 45,
    enforcement: 'report',
    pins: [basePin],
  };

  it('DRIFT passes when the pinned id is in the DERIVED set (topModels frontier=true)', () => {
    const r = run({
      ...base,
      doors: { fake: { topModels: [{ id: 'gemini-2.5-pro', frontier: true }] } },
    });
    expect(r.findings.filter((f: string) => f.startsWith('DRIFT'))).toHaveLength(0);
    // and it used the DERIVED path, not the literal one
    expect(r.info.some((i: string) => i.includes('derived frontier set'))).toBe(true);
  });

  it('DRIFT fails when the pinned id is NOT in the DERIVED set (rot detected)', () => {
    const r = run({
      ...base,
      doors: { fake: { topModels: [{ id: 'gemini-3.1-pro-preview', frontier: true }] } },
    });
    const drift = r.findings.filter((f: string) => f.startsWith('DRIFT'));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("pins 'gemini-2.5-pro'");
    expect(drift[0]).toContain('derived frontier set');
  });

  it('a frontier:false entry is EXCLUDED from the derived set (a pin on it drifts)', () => {
    const r = run({
      ...base,
      doors: { fake: { topModels: [{ id: 'gemini-2.5-pro', frontier: false }] } },
    });
    // frontier:false → not in derived set → the pin drifts
    expect(r.findings.filter((f: string) => f.startsWith('DRIFT'))).toHaveLength(1);
  });

  it('a door with BOTH a literal frontierAllowlist AND topModels emits a TRANSITION finding', () => {
    const r = run({
      ...base,
      frontierAllowlist: { fake: ['gemini-2.5-pro'] },
      doors: { fake: { topModels: [{ id: 'gemini-2.5-pro', frontier: true }] } },
    });
    const transition = r.findings.filter((f: string) => f.startsWith('TRANSITION'));
    expect(transition).toHaveLength(1);
    expect(transition[0]).toContain("frontierAllowlist['fake']");
    // the DERIVED set is authoritative there → the pin still resolves, no DRIFT
    expect(r.findings.filter((f: string) => f.startsWith('DRIFT'))).toHaveLength(0);
  });

  it('an old-shape manifest (literal frontierAllowlist, NO topModels) behaves EXACTLY as today', () => {
    const r = run({ ...base, frontierAllowlist: { fake: ['gemini-2.5-pro'] } });
    // no drift, no transition, no staleness — the un-enriched path is a strict no-op change
    expect(r.findings).toHaveLength(0);
    expect(r.info.some((i: string) => i.includes('in allowlist'))).toBe(true);
    expect(r.findings.some((f: string) => f.startsWith('TRANSITION'))).toBe(false);
  });
});

describe('frontierSetForDoor (unit — the derivation helper)', () => {
  it('derives from topModels when present (frontier=true entries only)', () => {
    const m = {
      doors: {
        d: {
          topModels: [
            { id: 'a', frontier: true },
            { id: 'b', frontier: false },
            { id: 'c', frontier: true },
          ],
        },
      },
    };
    const r = frontierSetForDoor(m, 'd');
    expect(r.source).toBe('derived');
    expect(r.set).toEqual(['a', 'c']);
    expect(r.transition).toBe(false);
  });

  it('falls back to the literal allowlist when there is no topModels (backward-compat)', () => {
    const r = frontierSetForDoor({ frontierAllowlist: { d: ['x', 'y'] } }, 'd');
    expect(r.source).toBe('literal');
    expect(r.set).toEqual(['x', 'y']);
    expect(r.transition).toBe(false);
  });

  it('marks transition=true when BOTH topModels and a literal entry exist (derived wins)', () => {
    const m = { frontierAllowlist: { d: ['x'] }, doors: { d: { topModels: [{ id: 'x', frontier: true }] } } };
    const r = frontierSetForDoor(m, 'd');
    expect(r.source).toBe('derived');
    expect(r.transition).toBe(true);
    expect(r.set).toEqual(['x']);
  });

  it('returns an empty set (source none) for an unknown door', () => {
    const r = frontierSetForDoor({}, 'nope');
    expect(r.source).toBe('none');
    expect(r.set).toEqual([]);
    expect(r.transition).toBe(false);
  });
});

describe('shipped manifest', () => {
  it('the real manifest is self-consistent (no findings under its own report enforcement)', () => {
    // Resolve against the real repo root so pin files exist.
    const repoRoot = path.resolve(__dirname, '..', '..');
    const manifestPath = path.join(repoRoot, 'scripts', 'model-registry-freshness.manifest.json');
    const r = checkModelRegistryFreshness({ manifestPath, repoRoot, now: NOW, forceStrict: false });
    expect(r.error).toBeNull();
    // Drift + staleness must be clean on the shipped list; flaggedStale rows are warnings only in report mode.
    expect(r.findings, `unexpected findings: ${r.findings.join(' | ')}`).toHaveLength(0);
  });
});
