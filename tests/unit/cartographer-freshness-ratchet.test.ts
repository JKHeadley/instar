// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 1 (unit) tests for the Tier-3 CI ratchet script (scripts/cartographer-
 * freshness.mjs), cartographer-doc-freshness spec #2. Runs the REAL script against
 * a temp git repo with a CartographerTree state built by spec #1's tree, asserting
 * the floor/backlog gating behaves: a fresh scaffold passes, a synthetic stale
 * regression fails the floor, never-authored-past-grace fails its ceiling, and the
 * floor is the (env-overridable) committed constant.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CartographerTree } from '../../src/core/CartographerTree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/cartographer-freshness.mjs');

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}
function commit(repo: string, msg: string): void { git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', msg]); }

let repo: string, stateDir: string;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-ratchet-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'Widget.ts'), 'export function computeWidgetTotal() { return 0; }\n');
  fs.writeFileSync(path.join(repo, 'src', 'Order.ts'), 'export function placeOrder() { return 1; }\n');
  git(repo, ['init', '-q', '-b', 'main']);
  commit(repo, 'init');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

/** Run the ratchet --check; return { code, stderr }. */
function runCheck(env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync('node', [SCRIPT, '--check'], {
      cwd: repo, encoding: 'utf8',
      env: { ...process.env, CARTOGRAPHER_FRESHNESS_ROOT: repo, ...env },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { code: err.status ?? 1, out: `${err.stderr ?? ''}${err.stdout ?? ''}` };
  }
}

function authorAll(): void {
  const t = new CartographerTree({ projectDir: repo, stateDir });
  t.scaffold();
  for (const p of ['src/Widget.ts', 'src/Order.ts']) {
    t.setSummary(p, `Implements ${p.includes('Widget') ? 'computeWidgetTotal' : 'placeOrder'} for the module.`, {
      provenance: { source: 'sweep', framework: 'codex-cli', modelTier: 'light' },
      meta: { lastAuthoredBy: 'sweep:codex-cli', confidence: 'medium' },
    });
  }
}

describe('cartographer-freshness ratchet script', () => {
  // ── Honest denominators (convergence-towards-coherence Tier 1, item 1) ──────
  // Before this, BOTH empty cases reported freshRatio: 1 — a perfect score that
  // passed every possible floor, making this ratchet structurally unable to fail
  // on an empty map (the exact case it exists to catch). The two empties are now
  // distinguished: no authored state at all is a legitimate skip that says so out
  // loud; an index that EXISTS and yields nothing authorable is a hard failure.
  it('does NOT silently pass when an authored index exists but has no authorable nodes', () => {
    const cartoDir = path.join(stateDir, 'cartographer');
    fs.mkdirSync(cartoDir, { recursive: true });
    fs.writeFileSync(path.join(cartoDir, 'index.json'), JSON.stringify({ nodes: {}, generatedAt: new Date().toISOString() }));
    const r = runCheck();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/fresh ratio UNKNOWN/);
    expect(r.out).toMatch(/not a pass/);
  });

  it('reports an UNKNOWN ratio (not 1) and still exits 0 when there is no authored state — the documented CI case', () => {
    // Asserts the DATA rather than the log line: the honest value is null, and the
    // legitimate no-state case must remain a pass so this ratchet cannot break every
    // build in a repo that ships the cartographer dark.
    const r = runCheck();
    expect(r.code).toBe(0);
    const report = JSON.parse(execFileSync('node', [SCRIPT, '--json'], {
      cwd: repo, encoding: 'utf8',
      env: { ...process.env, CARTOGRAPHER_FRESHNESS_ROOT: repo },
    }));
    expect(report.stateAuthored).toBe(false);
    expect(report.freshRatio).toBeNull();
  });

  it('an empty authored index can never satisfy a floor, however low', () => {
    const cartoDir = path.join(stateDir, 'cartographer');
    fs.mkdirSync(cartoDir, { recursive: true });
    fs.writeFileSync(path.join(cartoDir, 'index.json'), JSON.stringify({ nodes: {}, generatedAt: new Date().toISOString() }));
    // A floor of 0 previously passed trivially because the ratio was reported as 1.
    expect(runCheck({ CARTOGRAPHER_FRESHNESS_FLOOR: '0' }).code).toBe(1);
  });

  it('passes on a fresh scaffold (within grace) with the default floors', () => {
    new CartographerTree({ projectDir: repo, stateDir }).scaffold();
    expect(runCheck().code).toBe(0);
  });

  it('passes with a high freshRatio floor once all nodes are authored', () => {
    authorAll();
    expect(runCheck({ CARTOGRAPHER_FRESHNESS_FLOOR: '0.9' }).code).toBe(0);
  });

  it('FAILS the floor on a synthetic stale regression', () => {
    authorAll();
    // Change a committed file → its leaf node goes stale → freshRatio drops.
    fs.appendFileSync(path.join(repo, 'src', 'Widget.ts'), 'export const extra = 2;\n');
    commit(repo, 'change');
    const r = runCheck({ CARTOGRAPHER_FRESHNESS_FLOOR: '0.99' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('fresh ratio');
  });

  it('does NOT fail merely because new nodes are never-authored within grace', () => {
    new CartographerTree({ projectDir: repo, stateDir }).scaffold();
    // Default grace is 20m; freshly-scaffolded nodes are within grace.
    expect(runCheck({ CARTOGRAPHER_NEVER_AUTHORED_CEILING: '0' }).code).toBe(0);
  });

  it('FAILS the never-authored-past-grace ceiling when grace is 0', () => {
    new CartographerTree({ projectDir: repo, stateDir }).scaffold();
    const r = runCheck({ CARTOGRAPHER_FRESHNESS_GRACE_MS: '0', CARTOGRAPHER_NEVER_AUTHORED_CEILING: '0' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('never-authored-past-grace');
  });
});
