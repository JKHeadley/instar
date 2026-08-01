/**
 * The constitution must SHIP with the code that reads it.
 *
 * The defect these tests exist to make impossible (measured 2026-07-26):
 * `docs/STANDARDS-REGISTRY.md` appeared in ZERO of the 9,835 files `npm pack`
 * produces, so every deployed agent read a `<projectDir>/docs/` snapshot written
 * once at install and never refreshed. The enforcement-coverage audit graded a
 * May-24 copy of 22 standards while the authored constitution carried 81, and the
 * PostUpdateMigrator entry meant to refresh it read a path present in no published
 * install — throwing into `result.errors` on every run, where nothing looked.
 *
 * The decisive assertion is #1: it opens a REAL tarball. A `--dry-run` file
 * LISTING would have been the same class of mistake as the bug — trusting a
 * report about the artifact instead of the artifact.
 *
 * Spec: docs/specs/standards-registry-snapshot-refresh.md §9.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { countRegistryArticles, sha256, resolveStandardsRegistry, earnsVerified, registryMirrorPaths, holdsAuthoredConstitution } from '../../src/core/standardsRegistryPath.js';
import { computeCoverage } from '../../src/core/StandardsEnforcementAuditor.js';
import { ensureRegistryAsset } from '../setup/ensure-registry-asset.globalSetup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const AUTHORED = path.join(ROOT, 'docs', 'STANDARDS-REGISTRY.md');
const ASSET = path.join(ROOT, 'dist', 'data', 'standards-registry.md');
const META = path.join(ROOT, 'dist', 'data', 'standards-registry.meta.json');
const GUARD_INDEX = path.join(ROOT, 'dist', 'data', 'standards-guard-index.json');
const GUARD_INDEX_META = path.join(ROOT, 'dist', 'data', 'standards-guard-index.meta.json');

function copyRegistryParserCore(root: string): void {
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'standards-registry-article-core.mjs'),
    path.join(scripts, 'standards-registry-article-core.mjs'),
  );
}

/**
 * The asset is a BUILD artifact, and CI's unit job runs `npm ci` + tests with NO
 * build step. So `dist/` may not exist here at all — in which case `npm pack`
 * would produce a tarball with no `dist` and the ratchet below would fire a false
 * positive about a packaging regression that had not happened.
 *
 * Building is the honest fix. SKIPPING when `dist` is absent is the tempting one
 * and is wrong: it would make the ratchet silently vacuous on exactly the runs
 * that matter, which is the same shape as the defect this file exists to catch.
 */
beforeAll(() => {
  const parser = path.join(ROOT, 'dist', 'core', 'StandardsRegistryParser.js');
  if (!fs.existsSync(parser)) {
    // Full build: the generator imports the SHARED parser from dist/, so a bare
    // generator run cannot bootstrap itself.
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
  } else if (
    !fs.existsSync(ASSET)
    || !fs.existsSync(META)
    || !fs.existsSync(GUARD_INDEX)
    || !fs.existsSync(GUARD_INDEX_META)
  ) {
    execFileSync('node', ['scripts/generate-standards-registry-asset.mjs'], { cwd: ROOT, stdio: 'pipe' });
  }
}, 600_000);

describe('standards registry ships as a build artifact', () => {
  it('the authored constitution carries far more than the 22 an agent-home snapshot froze at', () => {
    // Guards the premise. If the constitution ever genuinely shrinks to ~22 this
    // goes red and the numbers quoted throughout this file need revisiting.
    const authored = fs.readFileSync(AUTHORED, 'utf-8');
    expect(countRegistryArticles(authored)).toBeGreaterThanOrEqual(60);
  });

  it('the generated asset is byte-identical to the authored constitution', () => {
    expect(sha256(fs.readFileSync(ASSET))).toBe(sha256(fs.readFileSync(AUTHORED)));
  });

  it('the meta records the sha and count of the bytes generated beside it', () => {
    const meta = JSON.parse(fs.readFileSync(META, 'utf-8'));
    const bytes = fs.readFileSync(ASSET);
    expect(meta.sha256).toBe(sha256(bytes));
    expect(meta.articleCount).toBe(countRegistryArticles(bytes.toString('utf-8')));
    expect(meta.generatedFrom).toBe('docs/STANDARDS-REGISTRY.md');
  });

  it('the source-only E2E bootstrap emits byte-identical production artifacts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-e2e-parity-'));
    const sourceRoot = path.join(tmp, 'source-only');
    const generatorRoot = path.join(tmp, 'real-generator');
    try {
      for (const root of [sourceRoot, generatorRoot]) {
        fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
        fs.copyFileSync(AUTHORED, path.join(root, 'docs', 'STANDARDS-REGISTRY.md'));
        fs.copyFileSync(
          path.join(ROOT, 'docs', 'standards-registry-floor.json'),
          path.join(root, 'docs', 'standards-registry-floor.json'),
        );
        fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
      }

      ensureRegistryAsset(sourceRoot);

      // Run the shipped generator in a second isolated root. Copying its compiled
      // parser dependency preserves the real post-tsc execution shape without
      // compiling this checkout or letting either implementation observe the
      // other's outputs.
      fs.mkdirSync(path.join(generatorRoot, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(generatorRoot, 'dist', 'core'), { recursive: true });
      copyRegistryParserCore(generatorRoot);
      fs.copyFileSync(
        path.join(ROOT, 'scripts', 'generate-standards-registry-asset.mjs'),
        path.join(generatorRoot, 'scripts', 'generate-standards-registry-asset.mjs'),
      );
      for (const compiled of [
        'StandardsRegistryParser.js',
        'StandardEnforcementExtractor.js',
        'standardsRegistryPath.js',
        'StandardsEnforcementAuditor.js',
      ]) {
        fs.copyFileSync(
          path.join(ROOT, 'dist', 'core', compiled),
          path.join(generatorRoot, 'dist', 'core', compiled),
        );
      }
      execFileSync('node', ['scripts/generate-standards-registry-asset.mjs'], {
        cwd: generatorRoot,
        stdio: 'pipe',
      });

      for (const rel of [
        'src/data/standards-registry.md',
        'src/data/standards-registry.meta.json',
        'src/data/standards-guard-index.json',
        'src/data/standards-guard-index.meta.json',
        'dist/data/standards-registry.md',
        'dist/data/standards-registry.meta.json',
        'dist/data/standards-guard-index.json',
        'dist/data/standards-guard-index.meta.json',
      ]) {
        expect(
          fs.readFileSync(path.join(sourceRoot, rel)),
          `${rel} from the asset-only E2E setup drifted from the real build generator`,
        ).toEqual(fs.readFileSync(path.join(generatorRoot, rel)));
      }
    } finally {
      SafeFsExecutor.safeRmSync(tmp, {
        recursive: true,
        force: true,
        operation: 'tests/unit/standards-registry-asset.test.ts',
      });
    }
  });

  it(
    'RATCHET: a REAL tarball carries the constitution, byte-identical',
    { timeout: 300_000 },
    () => {
      // The assertion that would have caught the original defect. `npm pack
      // --dry-run` reports a file LIST and cannot hand you bytes — an
      // inclusion-only check trusts a listing instead of the artifact, which is
      // this bug's own sin. So: pack for real, extract, compare bytes.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-pack-'));
      try {
        // Deliberately NOT `--json`: that emits an entry per packed file (9,700+
        // here) and overruns execFileSync's stdout buffer with ENOBUFS. We want the
        // tarball, not a manifest of it — so pack quietly and read what landed.
        execFileSync('npm', ['pack', '--pack-destination', tmp], {
          cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'],
        });
        const filename = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
        expect(filename, 'npm pack produced no tarball').toBeTruthy();
        const tarball = path.join(tmp, filename!);

        // Check MEMBERSHIP before extracting. Extraction of a missing member fails
        // with a raw `tar: Error exit delayed from previous errors`, which tells a
        // reader nothing about what broke or what to do — the same
        // unactionable-remediation defect this repo just fixed in the builtin
        // manifest check. The absent case is the MAIN regression this ratchet
        // guards, so it gets the clearest message, not the worst one.
        const members = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
          .split('\n');
        for (const member of [
          'package/dist/data/standards-registry.md',
          'package/dist/data/standards-registry.meta.json',
          'package/dist/data/standards-guard-index.json',
          'package/dist/data/standards-guard-index.meta.json',
        ]) {
          expect(
            members.includes(member),
            `${member} is MISSING from a real npm tarball — the packaging regression this ratchet ` +
              'exists for has returned. The constitution would ship to no one, and every deployed ' +
              'agent would fall back to reporting a broken install. Check: (1) the generator still ' +
              'runs after tsc in package.json `build`, (2) no later build step cleans dist/, ' +
              '(3) nothing (a files entry, an .npmignore) excludes dist/data.',
          ).toBe(true);
        }

        execFileSync(
          'tar',
          ['-xzf', tarball, '-C', tmp,
           'package/dist/data/standards-registry.md',
           'package/dist/data/standards-registry.meta.json',
           'package/dist/data/standards-guard-index.json',
           'package/dist/data/standards-guard-index.meta.json'],
          { stdio: 'pipe' },
        );

        const packed = fs.readFileSync(path.join(tmp, 'package/dist/data/standards-registry.md'));
        const packedMeta = JSON.parse(
          fs.readFileSync(path.join(tmp, 'package/dist/data/standards-registry.meta.json'), 'utf-8'),
        );

        expect(
          sha256(packed),
          'The constitution extracted from a REAL tarball does not match the authored document. ' +
            'If it is MISSING entirely, the packaging regression this ratchet exists for has ' +
            'returned: docs/ is not in package.json `files`, so the asset only reaches users via ' +
            'dist/data — check that the generator still runs after tsc in the build chain and that ' +
            'no later step cleans dist/.',
        ).toBe(sha256(fs.readFileSync(AUTHORED)));
        expect(packedMeta.sha256).toBe(sha256(packed));
        const packedGuardIndex = fs.readFileSync(path.join(tmp, 'package/dist/data/standards-guard-index.json'));
        const packedGuardMeta = JSON.parse(
          fs.readFileSync(path.join(tmp, 'package/dist/data/standards-guard-index.meta.json'), 'utf-8'),
        );
        expect(packedGuardMeta.sha256).toBe(sha256(packedGuardIndex));
        expect(packedGuardMeta.registrySha256).toBe(sha256(packed));
      } finally {
        SafeFsExecutor.safeRmSync(tmp, {
          recursive: true, force: true,
          operation: 'tests/unit/standards-registry-asset.test.ts',
        });
      }
    },
  );
});

describe('resolver validity matrix — invalid never becomes a confident answer', () => {
  /**
   * Each case runs the COMPILED resolver in a throwaway `dist`-shaped fixture, so
   * the module-relative `../data/…` rule is exercised exactly as an installed
   * agent exercises it — not simulated.
   */
  function resolveIn(fixture: { registry?: string | Buffer; meta?: string }): Record<string, unknown> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-resolve-'));
    try {
      const core = path.join(tmp, 'dist', 'core');
      const data = path.join(tmp, 'dist', 'data');
      fs.mkdirSync(core, { recursive: true });
      fs.mkdirSync(data, { recursive: true });
      copyRegistryParserCore(tmp);
      // Copy the compiled resolver + the parser it imports into the fixture.
      for (const f of ['standardsRegistryPath.js', 'StandardsRegistryParser.js']) {
        fs.copyFileSync(path.join(ROOT, 'dist', 'core', f), path.join(core, f));
      }
      if (fixture.registry !== undefined) fs.writeFileSync(path.join(data, 'standards-registry.md'), fixture.registry);
      if (fixture.meta !== undefined) fs.writeFileSync(path.join(data, 'standards-registry.meta.json'), fixture.meta);

      const out = execFileSync(
        'node',
        ['-e', `import('file://${core}/standardsRegistryPath.js').then(m=>console.log(JSON.stringify(m.resolveStandardsRegistry())))`],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return JSON.parse(out);
    } finally {
      SafeFsExecutor.safeRmSync(tmp, {
        recursive: true, force: true,
        operation: 'tests/unit/standards-registry-asset.test.ts',
      });
    }
  }

  const authored = fs.readFileSync(AUTHORED);
  const goodMeta = JSON.stringify({
    sha256: sha256(authored),
    articleCount: countRegistryArticles(authored.toString('utf-8')),
    generatedFrom: 'docs/STANDARDS-REGISTRY.md',
  });

  it('sha matches → usable, with the real article count', () => {
    const r = resolveIn({ registry: authored, meta: goodMeta });
    expect(r.usable).toBe(true);
    expect(r.articleCount).toBeGreaterThanOrEqual(60);
  });

  it('sha differs → integrity-mismatch, never a usable reading', () => {
    const r = resolveIn({ registry: Buffer.concat([authored, Buffer.from('\n<!-- edited -->\n')]), meta: goodMeta });
    expect(r.usable).toBe(false);
    expect(r.reason).toBe('integrity-mismatch');
  });

  it('meta absent → invalid-meta, never "unverified but usable"', () => {
    // "I could not verify" reported as usable is precisely the
    // absence-reads-as-presence failure this whole change removes.
    //
    // The reason is `invalid-meta`, NOT `broken-install`: cross-model round 7 was
    // right that overloading one reason for every failure mislabels the cause and
    // sends a reader to reinstall when the registry itself is present and fine.
    const r = resolveIn({ registry: authored });
    expect(r.usable).toBe(false);
    expect(r.reason).toBe('invalid-meta');
  });

  it('registry absent → broken-install, and it never throws', () => {
    const r = resolveIn({ meta: goodMeta });
    expect(r.usable).toBe(false);
    expect(r.reason).toBe('broken-install');
  });

  it('REGRESSION: a stale agent-home copy is never consulted, from either side', () => {
    // The live defect, asserted both ways. A 22-article `<projectDir>/docs/` copy
    // sitting right there must not be reachable — with the packed asset present it
    // is not preferred, and with the packed asset ABSENT resolution STOPS rather
    // than falling through to it. There is no fallback candidate by construction.
    const stale = '## The Root\n\n### Only Standard\n\n**Rule.** Stale.\n';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-stale-'));
    try {
      const core = path.join(tmp, 'dist', 'core');
      fs.mkdirSync(core, { recursive: true });
      copyRegistryParserCore(tmp);
      fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'docs', 'STANDARDS-REGISTRY.md'), stale);
      for (const f of ['standardsRegistryPath.js', 'StandardsRegistryParser.js']) {
        fs.copyFileSync(path.join(ROOT, 'dist', 'core', f), path.join(core, f));
      }
      const out = execFileSync(
        'node',
        ['-e', `import('file://${core}/standardsRegistryPath.js').then(m=>console.log(JSON.stringify(m.resolveStandardsRegistry())))`],
        { cwd: tmp, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const r = JSON.parse(out);
      expect(r.usable).toBe(false);
      expect(r.reason).toBe('broken-install');
      expect(JSON.stringify(r)).not.toContain('Stale');
    } finally {
      SafeFsExecutor.safeRmSync(tmp, {
        recursive: true, force: true,
        operation: 'tests/unit/standards-registry-asset.test.ts',
      });
    }
  });
});

describe('wiring integrity — no reader may rebuild the path', () => {
  /**
   * REWRITTEN 2026-07-28. The previous assertion pinned the migrator to having NO
   * registry entry at all, on the reasoning that the machine readers now use the
   * packed asset so no per-install copy needs maintaining, and vestigial copies are
   * "left in place and simply unread."
   *
   * Review falsified "unread", and it was the load-bearing word. The AGENT is the
   * constitution's principal reader, and every prose pointer shipped to agents — the
   * CLAUDE.md sections this migrator writes, plus the spec-converge, instar-dev and
   * iterative-converging-audit skills, all of which ship — names
   * `docs/STANDARDS-REGISTRY.md`. Measured on a live agent: 46,606 bytes, 22 articles,
   * dated May 24, against 81 authored. So the old assertion pinned the wrong design in
   * place, and it passed the whole time.
   */
  it('the migrator MIRRORS the constitution from the packed asset, unconditionally', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'PostUpdateMigrator.ts'), 'utf-8');
    const active = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

    // It has an entry, and the entry takes its paths from the ONE module that owns
    // registry location — no literal here, which the import-boundary test also guards.
    expect(active).toContain('registryMirrorPaths(bundledRoot, root)');
    expect(active).toContain("label: 'standards registry (constitution) mirror'");

    // And it is UNGATED. A prior-hash gate over shipped content cannot tell a
    // customization from ordinary drift, so it classifies every drifted copy as
    // customized and stops refreshing forever — which is precisely how the
    // constitution sat at 22 articles on deployed agents for fourteen weeks while the
    // migration reported itself healthy.
    expect(active).toContain('alwaysOverwrite: true');
    expect(active).toMatch(/if \(!alwaysOverwrite && !acceptedPrior\.has\(currentHash\)\)/);
  });

  /**
   * The refusal is DESTRUCTIVE if it gets this wrong — an older installed package would
   * overwrite the authored constitution — so the discrimination is pinned, not trusted.
   *
   * Note what the fixtures encode: an agent home carries BOTH `src/core` and `docs/specs`,
   * so those two markers discriminate nothing in the case that matters. `.git` is doing
   * the work. An earlier version keyed on the generator script, which THIS branch
   * introduces — so every pre-merge checkout failed open.
   */
  it('REFUSAL: the mirror is refused in a source tree and allowed in an agent home', () => {
    const mk = (markers: string[]): string => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
      for (const m of markers) {
        if (m === '.git-file') fs.writeFileSync(path.join(d, '.git'), 'gitdir: /elsewhere\n');
        else fs.mkdirSync(path.join(d, m), { recursive: true });
      }
      // Every real tree of either kind HAS the constitution file — an agent home because
      // the mirror put it there, a checkout because it is the authored original, so these
      // fixtures carry one. The probe does NOT consult it: markers alone decide, which is
      // what the mid-rebase case at the bottom of this test pins. (The earlier wording
      // here described a target-existence short-circuit that the round-6 reorder deleted —
      // it survived 40 lines above the assertion reversing it.)
      if (markers.length > 0) {
        fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(d, 'docs', 'STANDARDS-REGISTRY.md'), '### X\n');
      }
      return d;
    };
    const cleanup: string[] = [];
    try {
      // An agent home: a full src/ copy and docs/, but NOT a repository.
      const home = mk(['src/core', 'docs/specs']); cleanup.push(home);
      expect(holdsAuthoredConstitution(home)).toBe(false);
      expect(registryMirrorPaths('/pkg', home).skip).toBeUndefined();

      // A checkout — and a git WORKTREE, where `.git` is a FILE rather than a directory.
      const checkout = mk(['src/core', 'docs/specs', '.git']); cleanup.push(checkout);
      expect(holdsAuthoredConstitution(checkout)).toBe(true);
      expect(registryMirrorPaths('/pkg', checkout).skip).toMatch(/AUTHORED/);

      const worktree = mk(['src/core', 'docs/specs', '.git-file']); cleanup.push(worktree);
      expect(holdsAuthoredConstitution(worktree), 'a git worktree has .git as a FILE').toBe(true);
      expect(registryMirrorPaths('/pkg', worktree).skip).toMatch(/AUTHORED/);

      // A bare directory is not a source tree — the mirror proceeds.
      const bare = mk([]); cleanup.push(bare);
      expect(holdsAuthoredConstitution(bare)).toBe(false);

      // REVERSED by round 6, and the old assertion here was the reviewer's evidence.
      //
      // I had asserted that a checkout with no constitution on disk is ALLOWED, reasoning
      // "nothing to destroy". True of BYTES, false of WORKING-TREE STATE: a real checkout
      // mid-rebase, or with a merge-conflict delete, or a `git rm` in flight, would have
      // had the packed asset INSTALLED at the authored path — where git presents it as a
      // restore someone can commit. The transient-absence window is exactly when the
      // permissive answer is most dangerous, and this test was pinning it as correct.
      const midRebase = fs.mkdtempSync(path.join(os.tmpdir(), 'mid-rebase-'));
      cleanup.push(midRebase);
      fs.mkdirSync(path.join(midRebase, 'src', 'core'), { recursive: true });
      fs.mkdirSync(path.join(midRebase, 'docs', 'specs'), { recursive: true });
      fs.writeFileSync(path.join(midRebase, '.git'), 'gitdir: /x\n');
      expect(
        holdsAuthoredConstitution(midRebase),
        'a checkout is a checkout even while its constitution is transiently absent',
      ).toBe(true);
      expect(registryMirrorPaths('/pkg', midRebase).skip).toMatch(/AUTHORED/);
    } finally {
      for (const d of cleanup) {
        SafeFsExecutor.safeRmSync(d, {
          recursive: true,
          force: true,
          operation: 'standards-registry-asset.test mirror-refusal fixture cleanup',
        });
      }
    }
  });

  it('the mirror resolves to the packed asset and the path every prose pointer names', () => {
    const { bundled, target } = registryMirrorPaths('/pkg', '/agent');
    // Source: the asset that, since this change, actually ships.
    expect(bundled).toBe(path.join('/pkg', 'dist', 'data', 'standards-registry.md'));
    // Destination: the path the skills and CLAUDE.md sections tell agents to read.
    expect(target).toBe(path.join('/agent', 'docs', 'STANDARDS-REGISTRY.md'));
  });

  it('neither reader constructs a registry path from projectDir', () => {
    for (const rel of ['src/server/routes.ts', 'src/server/AgentServer.ts', 'src/server/specReviewRoutes.ts']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      // Strip comments first: a text check that fires on prose DESCRIBING the
      // forbidden shape is a check that fires on nothing real.
      const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
      expect(code, `${rel} rebuilds a STANDARDS-REGISTRY path instead of using the resolver`)
        .not.toMatch(/['"]STANDARDS-REGISTRY\.md['"]/);
    }
  });
});

describe('the test-only override cannot become a production path', () => {
  /**
   * Cross-model review round 1, finding 2: `resolveStandardsRegistry(explicitPath?)`
   * is an ordinary exported API and the spec relied on the PROSE claim "no production
   * callsite passes it". The lint catches a reader REBUILDING the path string, but not
   * future production code feeding the override a config- or env-derived value — which
   * would silently reintroduce exactly the defect this whole change removes.
   *
   * Policy is not enforcement. These two assertions are.
   */
  it('no production wiring sets RouteContext.standardsRegistryResolutionOverride', () => {
    // The route reads the override off RouteContext; RouteContext is constructed by
    // the server. If the server ever populates it, an operator-reachable config path
    // could point a deployed agent at an arbitrary registry.
    for (const rel of ['src/server/AgentServer.ts', 'src/commands/server.ts']) {
      const code = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
        .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      expect(
        code,
        `${rel} sets standardsRegistryResolutionOverride. That field is TEST-ONLY: populating it from ` +
          'production wiring (config, env, CLI flag) would let a deployed agent be pointed at an ' +
          'arbitrary constitution, which is the defect src/core/standardsRegistryPath.ts closes.',
      ).not.toMatch(/standardsRegistryResolutionOverride\s*[:=]/);
    }
  });

  it('the override is never fed from config or env anywhere in src/', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.ts$/.test(e.name)) files.push(full);
      }
    };
    walk(path.join(ROOT, 'src'));
    for (const f of files) {
      const code = fs.readFileSync(f, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
        .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      // An override derived from config/env is the reachable-from-production shape.
      expect(
        code,
        `${path.relative(ROOT, f)} derives the registry override from config or env — see above.`,
      ).not.toMatch(/standardsRegistryResolutionOverride\s*[:=]\s*(process\.env|.*config\.)/);
    }
  });
});

describe('the override is structurally unreachable in production', () => {
  it('the conformance route gates the override behind process.env.VITEST', () => {
    // Cross-model review raised the override seam in TWO consecutive rounds: regex
    // assertions that "no production callsite sets this" are policy, and an indirect
    // helper could route around them. The VITEST gate is the structural answer — the
    // test runner sets that variable and nothing in production does, so a deployed
    // agent cannot be pointed at an arbitrary constitution even if the RouteContext
    // field were somehow populated.
    const code = fs.readFileSync(path.join(ROOT, 'src/server/routes.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    expect(
      code,
      'The conformance route no longer gates standardsRegistryResolutionOverride behind process.env.VITEST. ' +
        'Without that gate the test-only seam becomes reachable from production, which reintroduces ' +
        'exactly the arbitrary-registry defect src/core/standardsRegistryPath.ts closes.',
    ).toMatch(/process\.env\.VITEST\s*\?\s*ctx\.standardsRegistryResolutionOverride/);
  });

  it('an unusable constitution is never reported as an empty one', () => {
    // standardTitles() must still return an array (its callers require one), but the
    // emptiness must not be SILENT — an empty standards list is otherwise
    // indistinguishable from a legitimately empty constitution.
    for (const rel of ['src/server/AgentServer.ts', 'src/commands/server.ts']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      const idx = src.indexOf('standardTitles:');
      expect(idx, `${rel} no longer defines standardTitles`).toBeGreaterThan(-1);
      const block = src.slice(idx, idx + 1400);
      expect(
        block,
        `${rel}'s standardTitles() returns [] on an unusable constitution without saying so. ` +
          'Silent emptiness is the defect class this change exists to remove.',
      ).toMatch(/console\.warn/);
    }
  });
});

describe('the test-only resolver API has zero production callers', () => {
  it('no file under src/ references resolveStandardsRegistryFromPath', () => {
    // Round-4 finding: an optional `explicitPath` on the PRIMARY api is a footgun
    // regardless of who currently passes it, because the next caller can. The
    // production entry point now takes no argument at all, and fixture resolution
    // lives behind a separately-named export. This asserts that separation holds.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.ts$/.test(e.name)) files.push(full);
      }
    };
    walk(path.join(ROOT, 'src'));
    for (const f of files) {
      if (f.endsWith('standardsRegistryPath.ts')) continue; // the definition itself
      const code = fs.readFileSync(f, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
        .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      expect(
        code,
        `${path.relative(ROOT, f)} imports the TEST-ONLY resolveStandardsRegistryFromPath. ` +
          'Production must use resolveStandardsRegistry(), which takes no path argument.',
      ).not.toContain('resolveStandardsRegistryFromPath');
    }
  });

  it('the PUBLISH path enforces a build, so a release cannot ship a stale tree', () => {
    // Round-4 finding: the ratchet proves the artifact ships after a TESTED build, not
    // that npm's lifecycle enforces one. `prepublishOnly` is where that enforcement
    // lives — npm runs it on `npm publish`, and it rebuilds before packing.
    //
    // I FIRST added `prepack: npm run build` for belt-and-braces coverage of bare
    // `npm pack`. The full suite rejected it: npm interleaves lifecycle-script stdout
    // with `npm pack --json` output, so the build's "Generated …" lines corrupted the
    // JSON that three existing tests (and any consumer) parse. That is a real defect
    // introduced by the fix, not a test artifact — so the prepack hook was removed.
    // The publish path was already covered; bare `npm pack` is an inspection tool.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    expect(
      pkg.scripts?.prepublishOnly,
      'package.json has no prepublishOnly script — the publish path no longer enforces a build, ' +
        'so a release could ship a tarball missing the generated constitution.',
    ).toMatch(/npm run build/);
    expect(
      pkg.scripts?.prepack,
      'A prepack hook was reintroduced. Its stdout interleaves with `npm pack --json` and corrupts ' +
        'the JSON consumers parse (verified: 3 suites failed). Enforce the build via prepublishOnly.',
    ).toBeUndefined();
  });
});

describe('resolver layout matrix — every execution layout is proven, not assumed', () => {
  /**
   * Round-6 finding: the dual src/dist generation leaves "future execution layouts"
   * as a manual obligation. This makes the CURRENT layouts a checked fact and gives
   * a new one an obvious place to be added — it is the exact class that already bit
   * this change once (dist-only generation → every vitest run resolved broken-install
   * while the targeted tests passed).
   */
  it('resolves usable from BOTH the compiled and the TypeScript-source entrypoint', () => {
    // Layout A — TypeScript source, as vitest executes it. This import IS the source
    // entrypoint, so a successful resolve here proves the src/data leg.
    const fromSource = resolveStandardsRegistry();
    expect(
      fromSource.usable,
      'The TS-source layout cannot resolve the registry. vitest runs TypeScript directly, so ' +
        'src/core/standardsRegistryPath.ts resolves ../data to src/data — the generator must write ' +
        'there too, not only dist/data.',
    ).toBe(true);

    // Layout B — compiled output, as production executes it.
    const compiled = path.join(ROOT, 'dist', 'core', 'standardsRegistryPath.js');
    expect(fs.existsSync(compiled), 'dist/core/standardsRegistryPath.js absent — build first').toBe(true);
    const out = execFileSync(
      'node',
      ['-e', `import('file://${compiled}').then(m=>console.log(JSON.stringify(m.resolveStandardsRegistry())))`],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const fromCompiled = JSON.parse(out);
    expect(
      fromCompiled.usable,
      'The compiled layout cannot resolve the registry — dist/data was not generated by the build.',
    ).toBe(true);

    // Both layouts must see the SAME constitution.
    expect(fromCompiled.sha256).toBe((fromSource as { sha256: string }).sha256);
  });
});

describe('import boundary — registry access is centralized', () => {
  it('no production file reads a registry path outside the resolver module', () => {
    // Round-6 finding: the regex lint is a smoke alarm, not the mechanism. The real
    // enforcement is that exactly ONE module owns registry location. This asserts the
    // boundary directly rather than trusting the text scan.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.ts$/.test(e.name)) files.push(full);
      }
    };
    walk(path.join(ROOT, 'src'));
    const owners = files.filter((f) => {
      if (f.endsWith('standardsRegistryPath.ts')) return false;
      const code = fs.readFileSync(f, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
        .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      // A production file may READ the registry only via a path the resolver handed it.
      return /standards-registry\.(md|meta\.json)/.test(code)
          || /['"`]STANDARDS-REGISTRY\.md['"`]/.test(code);
    }).map((f) => path.relative(ROOT, f));
    expect(
      owners,
      `These files locate the registry themselves instead of taking the resolver's result: ` +
        `${owners.join(', ')}. Exactly one module may own registry location.`,
    ).toEqual([]);
  });
});

/**
 * THE VERDICT'S ONLY END-TO-END PROOF.
 *
 * Review found that NO test drove a real `resolveStandardsRegistry()` to a `verified`
 * verdict. Every route, integration and e2e test used the fixture path, which resolves
 * `caller-supplied-path` → `unverified`; the only coverage of `verified` was a
 * hand-built object literal in the auditor unit test. So the verdict whose predecessor
 * was granted by ceremony (ACT-1426) had no end-to-end coverage at all — the exact
 * shape of the defect, one level up in the test suite.
 *
 * These tests run against the REAL generated asset, through the REAL production
 * resolver, into the REAL auditor. Nothing is constructed by hand.
 */
describe('a REAL resolution earns verified end-to-end — no hand-built literals', () => {
  it('the production resolver reports a packed-meta basis with all three operands agreeing', () => {
    const res = resolveStandardsRegistry();
    expect(res.usable, res.usable ? '' : `resolver said: ${res.detail}`).toBe(true);
    if (!res.usable) return;

    expect(res.integrity.basis).toBe('packed-meta-match');
    if (res.integrity.basis !== 'packed-meta-match') return;

    // The version stamp is the operand the generator did not derive from the bytes.
    const pkgVersion = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { version: string }).version;
    expect(res.integrity.metaPackageVersion).toBe(pkgVersion);
    expect(res.integrity.runningPackageVersion).toBe(pkgVersion);
    expect(res.integrity.packageVersionMatches).toBe(true);
    expect(res.integrity.articleCountMatchesMeta).toBe(true);

    const verdict = earnsVerified(res.integrity);
    expect(verdict.verified).toBe(true);
  });

  it('that real resolution carries its bytes, and they are the bytes on disk', () => {
    const res = resolveStandardsRegistry();
    if (!res.usable) throw new Error(`resolver unusable: ${res.detail}`);
    expect(res.markdown.length).toBeGreaterThan(0);
    expect(sha256(res.markdown)).toBe(res.sha256);
    expect(res.markdown).toBe(fs.readFileSync(res.path, 'utf-8'));
  });

  it('fed through the real auditor, that resolution produces a verified report', () => {
    const res = resolveStandardsRegistry();
    if (!res.usable) throw new Error(`resolver unusable: ${res.detail}`);
    const report = computeCoverage({
      registryPath: res.path,
      projectDir: ROOT,
      registryMarkdown: res.markdown,
      integrity: res.integrity,
    });
    expect(report.summary.assessmentConfidence).toBe('verified');
    expect(report.summary.assessmentTrustworthy).toBe(true);
    expect(report.summary.guards.analyzable).toBe(true);
    // And it is graded over the WHOLE constitution, which is the point of the change.
    expect(report.summary.total).toBeGreaterThanOrEqual(60);
  });

  it('REFUSAL: a stale asset (version skew) cannot reach verified, even with a matching sha', () => {
    const res = resolveStandardsRegistry();
    if (!res.usable) throw new Error(`resolver unusable: ${res.detail}`);
    if (res.integrity.basis !== 'packed-meta-match') throw new Error('expected packed basis');

    // The precise scenario the sha pair structurally cannot see: bytes and meta agree
    // perfectly, and the asset is simply older than the code reading it.
    const stale = { ...res.integrity, metaPackageVersion: '0.0.1-ancient', packageVersionMatches: false };
    expect(earnsVerified(stale).verified).toBe(false);

    const report = computeCoverage({
      registryPath: res.path, projectDir: ROOT, registryMarkdown: res.markdown, integrity: stale,
    });
    expect(report.summary.assessmentConfidence).toBe('unverified');
    expect(report.summary.confidenceReason).toMatch(/CROSS-VERSION skew/);
  });

  it('REFUSAL: editing the constitution without rebuilding is caught — the case the stamp CANNOT see', () => {
    const res = resolveStandardsRegistry();
    if (!res.usable) throw new Error(`resolver unusable: ${res.detail}`);

    // The scenario review named as the version stamp's blind spot, reproduced exactly:
    // the asset and its meta are untouched and perfectly consistent — same sha, same
    // article count, same package version — and the AUTHORED constitution has moved on.
    // Every operand written by the build that wrote the asset still agrees.
    const authored = path.join(ROOT, 'docs', 'STANDARDS-REGISTRY.md');
    const original = fs.readFileSync(authored, 'utf-8');
    try {
      fs.writeFileSync(authored, `${original}\n### A Standard Added After The Build\n**Rule.** r.\n`);

      // Confirm the other three operands are UNMOVED — otherwise this test proves nothing.
      const stillFine = resolveStandardsRegistry();
      if (!stillFine.usable) throw new Error('resolver went unusable — wrong precondition');
      expect(earnsVerified(stillFine.integrity).verified).toBe(true);

      const report = computeCoverage({
        registryPath: stillFine.path,
        projectDir: ROOT,
        registryMarkdown: stillFine.markdown,
        integrity: stillFine.integrity,
      });
      expect(report.summary.assessmentConfidence).toBe('unverified');
      expect(report.summary.confidenceReason).toMatch(/does NOT match the authored/);
    } finally {
      fs.writeFileSync(authored, original);
    }
  });

  it('REFUSAL: a basis paired with FOREIGN bytes is rejected, not reported as verified', () => {
    const res = resolveStandardsRegistry();
    if (!res.usable) throw new Error(`resolver unusable: ${res.detail}`);
    // The inverse of the tautology: not a comparison that cannot fail, but a basis
    // accompanying content it never described. Today only one producer assembles
    // these fields; this makes the coupling a precondition rather than a convention.
    expect(() => computeCoverage({
      registryPath: res.path,
      projectDir: ROOT,
      registryMarkdown: '# a different document entirely\n',
      integrity: res.integrity,
    })).toThrow(/incoherent auditor options/);
  });

  it('a missing configured tree resolves to the real checkout by same-build evidence', () => {
    const res = resolveStandardsRegistry();
    if (!res.usable) throw new Error(`resolver unusable: ${res.detail}`);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-instar-'));
    try {
      const report = computeCoverage({
        registryPath: res.path, projectDir: empty, registryMarkdown: res.markdown, integrity: res.integrity,
      });
      expect(report.summary.guards.analyzable).toBe(true);
      expect(['executing-source-tree', 'source-tree-index-match']).toContain(report.summary.guards.basis);
      expect(report.summary.guards.freshnessVerified).toBe(true);
      expect(report.summary.guards.configuredProjectDir).toBe(empty);
      expect(report.summary.guards.sourceIndexSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(report.summary.guards.projectDir).toBe(fs.realpathSync(ROOT));
      expect(report.summary.assessmentConfidence).toBe('verified');
      expect(report.summary.assessmentTrustworthy).toBe(true);
      expect(report.summary.danglingCount).toBe(0);
    } finally {
      SafeFsExecutor.safeRmSync(empty, { recursive: true, force: true, operation: 'test.cleanup' });
    }
  });
});
