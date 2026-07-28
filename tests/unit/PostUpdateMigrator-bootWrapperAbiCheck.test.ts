/**
 * Verifies migrateBootWrapperAbiCheck regenerates the boot wrapper for
 * existing .cjs agents that predate the ABI-aware node self-heal, and
 * skips idempotently once the ABI-check marker is present.
 *
 * recurring-SQLite-bane fix: the .js→.cjs migration skips agents already
 * on .cjs, so they never received the selfHealNodeSymlink ABI check.
 * This migration closes that gap.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { installBootWrapper } from '../../src/commands/setup.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function run(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateBootWrapperAbiCheck(r: MigrationResult): void }).migrateBootWrapperAbiCheck(result);
  return result;
}

const MARKER = 'cannot load better-sqlite3 (ABI drift)';
const MARKER_VMNODE = 'version-managed node candidates';
const MARKER_INSTALLPATH = 'npm_config_scripts_prepend_node_path';

describe('PostUpdateMigrator — boot-wrapper ABI-check regeneration', () => {
  let projectDir: string;
  let bootWrapperPath: string;
  const isDarwin = process.platform === 'darwin';

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-bootabi-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    bootWrapperPath = path.join(projectDir, '.instar', 'instar-boot.cjs');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-bootWrapperAbiCheck.test.ts:cleanup',
    });
  });

  it('skips when the boot wrapper has ALL THREE markers — ABI-check, version-managed-node, install-path (idempotent)', () => {
    if (!isDarwin) {
      // On non-darwin the migration short-circuits; assert that instead.
      const result = run(newMigrator(projectDir));
      expect(result.skipped.some(s => s.includes('non-darwin'))).toBe(true);
      return;
    }
    fs.writeFileSync(bootWrapperPath, `#!/usr/bin/env node\n// has markers: ${MARKER} + ${MARKER_VMNODE} + ${MARKER_INSTALLPATH}\n`);
    const result = run(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('already current'))).toBe(true);
    // Must NOT have rewritten it.
    expect(result.upgraded.some(u => u.includes('ABI-check'))).toBe(false);
  });

  it('REGENERATES when ABI-check + version-managed-node are present but the install-path marker is absent (the launchd "command not found" reinstall case)', () => {
    if (!isDarwin) return; // installBootWrapper is darwin-launchd-specific
    // A wrapper from before the install-path fix: it has both prior markers (so the
    // two-marker sniff treated it as current) but its reinstall path does NOT put
    // node/npm on PATH, so native postinstalls (sharp) die with "command not found"
    // under a launchd-spawned boot child and the shadow install never heals.
    fs.writeFileSync(bootWrapperPath, `#!/usr/bin/env node\n// has: ${MARKER} + ${MARKER_VMNODE} (but NOT the install-path fix)\n`);
    const result = run(newMigrator(projectDir));
    expect(result.skipped.some(s => s.includes('already current'))).toBe(false);
    const tookRegenBranch =
      result.upgraded.some(u => u.includes('ABI-check')) ||
      result.errors.some(e => e.includes('ABI-check'));
    expect(tookRegenBranch).toBe(true);
  });

  it('REGENERATES when the ABI-check marker is present but the version-managed-node marker is absent (the instar-codey deadlock case)', () => {
    if (!isDarwin) return; // installBootWrapper is darwin-launchd-specific
    // This is exactly Codey's on-disk state: it had the ABI check (so the old
    // single-marker sniff treated it as "current") but NOT the asdf/nvm `which
    // node` candidate discovery — so it could not heal back to a matching-ABI
    // node and self-healed FORWARD to the wrong ABI.
    fs.writeFileSync(bootWrapperPath, `#!/usr/bin/env node\n// has only: ${MARKER}\n`);
    const result = run(newMigrator(projectDir));
    expect(result.skipped.some(s => s.includes('already current'))).toBe(false);
    const tookRegenBranch =
      result.upgraded.some(u => u.includes('ABI-check')) ||
      result.errors.some(e => e.includes('ABI-check'));
    expect(tookRegenBranch).toBe(true);
  });

  it('the generated boot wrapper includes the version-managed `which node` candidate discovery (cross-platform — proves the fix is in the template)', () => {
    // installBootWrapper only writes into <projectDir>/.instar (no launchd side
    // effects), so the generated wrapper is assertable on any platform. The
    // returned `js` field is the .cjs PATH (caller-compat); read its content.
    const { js: jsPath } = installBootWrapper(projectDir);
    const js = fs.readFileSync(jsPath, 'utf-8');
    // The new marker the migrator sniffs for.
    expect(js).toContain('version-managed node candidates');
    // The actual discovery mechanism: resolve the PATH node (asdf/nvm/volta shim).
    expect(js).toContain("execFileSync('which', ['node']");
    // It must be ADDED to the candidate pool BEFORE the ABI-compatibility loop
    // that picks the node able to load the existing better-sqlite3 binary.
    const whichIdx = js.indexOf("execFileSync('which', ['node']");
    const abiLoopIdx = js.indexOf('Found compatible node for native modules');
    expect(whichIdx).toBeGreaterThan(-1);
    expect(abiLoopIdx).toBeGreaterThan(whichIdx);
    // The prior ABI-check marker is still present (we ADD to, not replace, the heal).
    expect(js).toContain('cannot load better-sqlite3 (ABI drift)');
  });

  it('the generated .cjs reinstall puts node on PATH + sets scripts-prepend-node-path, and is syntactically valid (cross-platform)', () => {
    const { js: jsPath } = installBootWrapper(projectDir);
    const js = fs.readFileSync(jsPath, 'utf-8');
    // The reinstall must pass an env so native postinstalls resolve node/npm.
    expect(js).toContain('npm_config_scripts_prepend_node_path');
    expect(js).toContain('path.dirname(nodeBin) + path.delimiter');
    // The env must actually be wired into the npm install call.
    expect(js).toContain('env: installEnv');
    // Syntactic validity of the generated wrapper — a template-escaping slip here
    // would brick the boot shim for every agent, so assert `node --check` passes.
    const { spawnSync } = require('node:child_process');
    const check = spawnSync(process.execPath, ['--check', jsPath], { encoding: 'utf-8' });
    expect(check.status).toBe(0);
  });

  it('the generated .sh reinstall exports node onto PATH + sets scripts-prepend-node-path', () => {
    const { sh: shPath } = installBootWrapper(projectDir);
    const sh = fs.readFileSync(shPath, 'utf-8');
    expect(sh).toContain('npm_config_scripts_prepend_node_path=true');
    expect(sh).toContain('PATH="$(dirname "$NODE_BIN"):$PATH"');
  });

  it('skips gracefully when no boot wrapper exists', () => {
    const result = run(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    if (isDarwin) {
      expect(result.skipped.some(s => s.includes('no instar-boot.cjs'))).toBe(true);
    } else {
      expect(result.skipped.some(s => s.includes('non-darwin'))).toBe(true);
    }
  });

  it('attempts regeneration when the marker is absent (darwin only)', () => {
    if (!isDarwin) return; // installBootWrapper is darwin-launchd-specific
    fs.writeFileSync(bootWrapperPath, '#!/usr/bin/env node\n// old wrapper without ABI logic\n');

    // Spy on installBootWrapper indirectly: it will try to write files. We
    // only assert the migration RECOGNIZED the marker as missing and took
    // the regeneration branch (upgraded OR errored — both prove it didn't
    // silently skip). It must not land in "already current".
    const result = run(newMigrator(projectDir));
    expect(result.skipped.some(s => s.includes('already current'))).toBe(false);
    const tookRegenBranch =
      result.upgraded.some(u => u.includes('ABI-check')) ||
      result.errors.some(e => e.includes('ABI-check'));
    expect(tookRegenBranch).toBe(true);
  });
});
