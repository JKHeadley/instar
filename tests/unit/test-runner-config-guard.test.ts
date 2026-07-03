// safe-git-allow: test-only os.tmpdir fixture cleanup (mkdtemp teardown; no source-tree writes) — matches the tmux-resilience test allowlist precedent.
/**
 * test-runner-config-guard — the §2.2/§5 CONFIG-LIST GUARD for the test-runner
 * concurrency bound (spec docs/specs/test-runner-concurrency-bound.md).
 *
 * A future 6th vitest config must not silently escape the bound at EITHER
 * per-config seam (round-5 integration finding: a config with the globalSetup
 * but without the config-eval helper re-opens unclamped nested shelter for
 * exactly that config). This guard asserts, for EVERY root vitest.*.config.*:
 *
 *   1. the config-eval seam — the source calls withTestRunnerBound(...);
 *   2. the chokepoint seam — the EVALUATED config's test.globalSetup carries
 *      'tests/setup/test-runner-semaphore.globalSetup.ts' PREPENDED (index 0,
 *      so the slot is held through any later globalSetup like build-dist);
 *
 * and additionally:
 *
 *   3. FAILS on the introduction of any vitest.workspace.* file (the workspace
 *      path is unreviewed against the §2.5 process-global lane-scoped flag);
 *   4. repo lint (§5): every package.json script invoking vitest uses one of
 *      the 5 guarded configs (or no --config, which resolves to the guarded
 *      vitest.config.ts) — no arbitrary --config bypass. Ad-hoc shell
 *      `npx vitest --config …` is the documented out-of-scope residual.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const GUARDED_CONFIGS = [
  'vitest.config.ts',
  'vitest.integration.config.ts',
  'vitest.e2e.config.ts',
  'vitest.contract.config.ts',
  'vitest.push.config.ts',
];
const GLOBAL_SETUP_ENTRY = 'tests/setup/test-runner-semaphore.globalSetup.ts';

/** Every root-level vitest config file (any extension a config can take). */
function rootVitestConfigs(): string[] {
  return fs
    .readdirSync(REPO_ROOT)
    .filter((f) => /^vitest\..*config\.(c|m)?(t|j)s$/.test(f) || /^vitest\.config\.(c|m)?(t|j)s$/.test(f))
    .sort();
}

const SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.vite', '.worktrees']);

function walkRepo(dir: string, visit: (p: string, name: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walkRepo(path.join(dir, e.name), visit);
    } else {
      visit(path.join(dir, e.name), e.name);
    }
  }
}

describe('test-runner-bound config-list guard (§2.2/§5)', () => {
  let tmpBase = '';
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    // Importing the configs EXECUTES withTestRunnerBound. Point its rendezvous
    // at a throwaway universe and hold the kill switch so config evaluation is
    // wiring-only (steps 1-2 run; classification/ledger writes are skipped).
    for (const k of ['INSTAR_HOST_TEST_SEMAPHORE', 'INSTAR_HOST_TEST_BASE_DIR', '__INSTAR_TRB_CONFIG', '__INSTAR_TRB_TARGETED', '__INSTAR_TRB_CLAMPED']) {
      savedEnv[k] = process.env[k];
    }
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'trb-config-guard-'));
    process.env['INSTAR_HOST_TEST_SEMAPHORE'] = 'off';
    process.env['INSTAR_HOST_TEST_BASE_DIR'] = tmpBase;
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('the five guarded configs exist at the repo root', () => {
    for (const cfg of GUARDED_CONFIGS) {
      expect(fs.existsSync(path.join(REPO_ROOT, cfg)), `${cfg} is missing`).toBe(true);
    }
  });

  it('every root vitest config wires the config-eval seam (withTestRunnerBound call)', () => {
    const configs = rootVitestConfigs();
    expect(configs.length).toBeGreaterThanOrEqual(GUARDED_CONFIGS.length);
    for (const cfg of configs) {
      const src = fs.readFileSync(path.join(REPO_ROOT, cfg), 'utf-8');
      expect(
        /withTestRunnerBound\(/.test(src),
        `${cfg} does not call withTestRunnerBound(...) — a config missing the shared config-eval helper ` +
          `re-opens unclamped nested shelter for exactly that config (§2.2 round-5). Wire BOTH seams.`,
      ).toBe(true);
    }
  });

  it('every root vitest config wires the globalSetup chokepoint entry, PREPENDED', async () => {
    for (const cfg of rootVitestConfigs()) {
      const mod = await import(pathToFileURL(path.join(REPO_ROOT, cfg)).href);
      const resolved = mod.default;
      expect(resolved, `${cfg} has no default export`).toBeTruthy();
      const test = (resolved as { test?: Record<string, unknown> }).test;
      expect(test, `${cfg} default export carries no test config`).toBeTruthy();
      const gs = test!['globalSetup'];
      expect(Array.isArray(gs), `${cfg} test.globalSetup is not an array`).toBe(true);
      expect(
        (gs as string[]).includes(GLOBAL_SETUP_ENTRY),
        `${cfg} does not wire the semaphore globalSetup chokepoint (${GLOBAL_SETUP_ENTRY})`,
      ).toBe(true);
      expect(
        (gs as string[])[0],
        `${cfg} must PREPEND the semaphore globalSetup (teardown runs in reverse — the slot must be ` +
          `held through any later globalSetup like the integration dist build, §2.2)`,
      ).toBe(GLOBAL_SETUP_ENTRY);
    }
  });

  it('FAILS on the introduction of any vitest.workspace.* file (unreviewed against the bound)', () => {
    const found: string[] = [];
    walkRepo(REPO_ROOT, (p, name) => {
      if (/^vitest\.workspace\./.test(name)) found.push(path.relative(REPO_ROOT, p));
    });
    expect(
      found,
      `vitest workspace file(s) introduced: ${found.join(', ')} — the workspace path is UNREVIEWED ` +
        `against the test-runner bound (§2.2/§2.5 process-global lane-scoped flag). Review the workspace ` +
        `path against the spec before removing this guard.`,
    ).toEqual([]);
  });

  it('repo lint: every root package.json script invoking vitest uses a guarded config (no --config bypass)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    const scripts: Record<string, string> = pkg.scripts ?? {};
    let vitestScripts = 0;
    for (const [name, cmd] of Object.entries(scripts)) {
      if (!/\bvitest\b/.test(cmd)) continue;
      vitestScripts++;
      const configRefs = [...cmd.matchAll(/--config[= ]+(['"]?)([^\s'"]+)\1/g)].map((m) => m[2]);
      for (const ref of configRefs) {
        const normalized = ref.replace(/^\.\//, '');
        expect(
          GUARDED_CONFIGS.includes(normalized),
          `package.json script "${name}" invokes vitest with --config ${ref}, which is NOT one of the ` +
            `5 guarded configs — an arbitrary --config bypasses the semaphore globalSetup (§5 repo lint)`,
        ).toBe(true);
      }
      // No --config at all resolves to the guarded root vitest.config.ts — OK.
    }
    // Sanity: the lint is actually exercising something.
    expect(vitestScripts).toBeGreaterThanOrEqual(5);
  });

  it('repo lint: no other package.json in the repo invokes vitest outside the guarded configs', () => {
    const offenders: string[] = [];
    walkRepo(REPO_ROOT, (p, name) => {
      if (name !== 'package.json') return;
      const rel = path.relative(REPO_ROOT, p);
      if (rel === 'package.json') return; // root handled above
      if (rel.startsWith(path.join('tests', 'fixtures') + path.sep)) return; // fixture data, not an invocation path
      let pkg: { scripts?: Record<string, string> };
      try {
        pkg = JSON.parse(fs.readFileSync(p, 'utf-8'));
      } catch {
        return;
      }
      for (const cmd of Object.values(pkg.scripts ?? {})) {
        if (/\bvitest\b/.test(cmd)) offenders.push(`${rel}: ${cmd}`);
      }
    });
    expect(
      offenders,
      `sub-package package.json script(s) invoke vitest outside the guarded root configs — ` +
        `those runs escape the host-wide bound: ${offenders.join('; ')}`,
    ).toEqual([]);
  });
});
