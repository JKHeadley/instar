/**
 * cross-model-review.mjs: which built reviewer module the helper loads
 * (review-helper-stale-module).
 *
 * The Studio helper loaded an untracked `dist/` in the agent's home folder
 * whose model table still named gpt-5.5, so every Codex review degraded. The
 * ladder now passes over an orphan build (no instar package.json beside it)
 * and a checkout build older than its source, and says which it skipped.
 * These tests build real folder layouts on disk and import the real script.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'skills', 'spec-converge', 'scripts', 'cross-model-review.mjs');

type Assess = { path: string; usable: boolean; reason?: string; detail?: string };
type Select = { hit: string | null; skipped: { path: string; reason: string }[]; moduleStale: boolean };
let assessModuleCandidate: (p: string) => Assess;
let selectReviewerModule: (c: string[]) => Select;
// The copied-script test imports a second instance of the module.

const MOD = path.join('dist', 'core', 'crossModelReviewer.js');
const MODELS_BUILT = path.join('dist', 'providers', 'adapters', 'openai-codex', 'models.js');
const SRC = path.join('src', 'core', 'crossModelReviewer.ts');
const MODELS_SRC = path.join('src', 'providers', 'adapters', 'openai-codex', 'models.ts');

function write(root: string, rel: string, body: string, mtimeSec?: number): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mtimeSec !== undefined) fs.utimesSync(p, mtimeSec, mtimeSec);
}

describe('reviewer module freshness ladder', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xmr-fresh-')));
    const mod = await import(pathToFileURL(SCRIPT).href);
    assessModuleCandidate = mod.assessModuleCandidate;
    selectReviewerModule = mod.selectReviewerModule;
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'xmr-fresh-test' });
  });

  it('importing the script does not run it (the selectors are exported, main is guarded)', () => {
    expect(typeof assessModuleCandidate).toBe('function');
    expect(typeof selectReviewerModule).toBe('function');
  });

  it('orphan build: a dist with no instar package.json beside it is skipped', () => {
    const agentHome = path.join(tmp, 'agent');
    write(agentHome, MOD, '// old build');
    write(agentHome, 'package.json', JSON.stringify({ name: 'my-agent' }));
    expect(assessModuleCandidate(path.join(agentHome, MOD))).toMatchObject({ usable: false, reason: 'orphan-build' });
    const bare = path.join(tmp, 'bare');
    write(bare, MOD, '// old build');
    expect(assessModuleCandidate(path.join(bare, MOD))).toMatchObject({ usable: false, reason: 'orphan-build' });
  });

  it('published package (no src): usable whatever its file times', () => {
    const pkg = path.join(tmp, 'pkg');
    write(pkg, 'package.json', JSON.stringify({ name: 'instar' }));
    write(pkg, MOD, '//', 1000);
    expect(assessModuleCandidate(path.join(pkg, MOD))).toMatchObject({ usable: true });
  });

  it('checkout: stale when a reviewer source is newer than its build, fresh otherwise', () => {
    const co = path.join(tmp, 'checkout');
    write(co, 'package.json', JSON.stringify({ name: 'instar' }));
    write(co, SRC, '//', 1000);
    write(co, MOD, '//', 2000);
    write(co, MODELS_SRC, '//', 3000); // models source edited after the build
    write(co, MODELS_BUILT, '//', 2000);
    const stale = assessModuleCandidate(path.join(co, MOD));
    expect(stale).toMatchObject({ usable: false, reason: 'stale-build' });
    expect(stale.detail).toContain('models.ts');
    fs.utimesSync(path.join(co, MODELS_BUILT), 4000, 4000); // rebuilt
    expect(assessModuleCandidate(path.join(co, MOD))).toMatchObject({ usable: true });
  });

  it('checkout with a source but no built counterpart is stale', () => {
    const co = path.join(tmp, 'checkout2');
    write(co, 'package.json', JSON.stringify({ name: 'instar' }));
    write(co, SRC, '//', 1000);
    write(co, MOD, '//', 2000);
    write(co, MODELS_SRC, '//', 1000);
    expect(assessModuleCandidate(path.join(co, MOD))).toMatchObject({ usable: false, reason: 'stale-build' });
  });

  it('the Studio shape: orphan agent-root build first, real install second: the install wins and the skip is named', () => {
    const orphan = path.join(tmp, 'agent');
    write(orphan, MOD, '// gpt-5.5 era build');
    const install = path.join(tmp, 'agent', '.instar', 'shadow-install', 'node_modules', 'instar');
    write(install, 'package.json', JSON.stringify({ name: 'instar' }));
    write(install, MOD, '// current');
    const missing = path.join(tmp, 'nowhere', MOD);
    const r = selectReviewerModule([path.join(orphan, MOD), path.join(install, MOD), missing]);
    expect(r.hit).toBe(path.join(install, MOD));
    expect(r.moduleStale).toBe(false);
    expect(r.skipped).toEqual([{ path: path.join(orphan, MOD), reason: 'orphan-build' }]);
  });

  it('the real ladder from a copy run at <agent home>/skills/... (the Studio failure): the agent\'s own install wins over its orphan dist', async () => {
    // Lay down the failing machine's shape and import a COPY of the real script
    // from it, so moduleCandidates() computes its own ROOT exactly as there.
    const home = path.join(tmp, 'agents', 'echo');
    const scriptsDir = path.join(home, 'skills', 'spec-converge', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const copy = path.join(scriptsDir, 'cross-model-review.mjs');
    fs.copyFileSync(SCRIPT, copy);
    write(home, MOD, '// gpt-5.5 era build, untracked, no package.json');
    const install = path.join(home, '.instar', 'shadow-install', 'node_modules', 'instar');
    write(install, 'package.json', JSON.stringify({ name: 'instar' }));
    write(install, MOD, '// current');
    const copied = await import(pathToFileURL(copy).href);
    const candidates: string[] = copied.moduleCandidates();
    expect(candidates[0]).toBe(path.join(home, MOD));
    expect(candidates).toContain(path.join(install, MOD));
    const r = copied.selectReviewerModule(candidates) as Select;
    expect(r.hit).toBe(path.join(install, MOD));
    expect(r.moduleStale).toBe(false);
    expect(r.skipped).toEqual([{ path: path.join(home, MOD), reason: 'orphan-build' }]);
  });

  it('nothing usable but something exists: still loads it (never blocks) and marks it stale', () => {
    const orphan = path.join(tmp, 'only');
    write(orphan, MOD, '//');
    const r = selectReviewerModule([path.join(tmp, 'none', MOD), path.join(orphan, MOD)]);
    expect(r.hit).toBe(path.join(orphan, MOD));
    expect(r.moduleStale).toBe(true);
  });

  it('nothing exists: no hit, nothing skipped (the loud not-found path stays)', () => {
    const r = selectReviewerModule([path.join(tmp, 'a', MOD), path.join(tmp, 'b', MOD)]);
    expect(r).toEqual({ hit: null, skipped: [], moduleStale: false });
  });
});
