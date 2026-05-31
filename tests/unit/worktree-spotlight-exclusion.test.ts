/**
 * OS resource hygiene (Responsible Resource Usage standard): the worktrees
 * container carries a `.metadata_never_index` marker so macOS Spotlight skips
 * re-indexing every worktree beneath it. Covers the reusable helper and the
 * PostUpdateMigrator backfill (existing agents get the marker on update).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureWorktreeSpotlightExclusion } from '../../src/core/InstarWorktreeManager.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/worktree-spotlight-exclusion.test.ts';

describe('ensureWorktreeSpotlightExclusion', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-spotlight-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: OP }); });

  it('creates the .metadata_never_index marker at the worktrees root', () => {
    const created = ensureWorktreeSpotlightExclusion(tmp);
    expect(created).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.metadata_never_index'))).toBe(true);
  });

  it('is idempotent — returns false when the marker already exists', () => {
    expect(ensureWorktreeSpotlightExclusion(tmp)).toBe(true);
    expect(ensureWorktreeSpotlightExclusion(tmp)).toBe(false);
    // Still exactly one marker, still empty.
    expect(fs.readFileSync(path.join(tmp, '.metadata_never_index'), 'utf-8')).toBe('');
  });

  it('never throws on an unwritable path — best-effort OS hint', () => {
    expect(ensureWorktreeSpotlightExclusion('/proc/nonexistent-xyz/.worktrees')).toBe(false);
  });
});

// ── Migration backfill (mirrors migrateWorktreeConvention.test.ts hermetic setup) ──

let originalHome: string | undefined;
let originalAuditDir: string | undefined;
let tmpHome: string;

function setHome(dir: string): void { originalHome = process.env.HOME; process.env.HOME = dir; }
function restoreHome(): void {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
}

function setupAgentHome(name: string): { agentHome: string; stateDir: string } {
  const instarHome = path.join(tmpHome, '.instar');
  fs.mkdirSync(instarHome, { recursive: true });
  fs.writeFileSync(path.join(instarHome, 'registry.json'), JSON.stringify({
    version: 1,
    entries: [{
      name, type: 'standalone', path: path.join(instarHome, 'agents', name),
      port: 9999, pid: 0, status: 'stopped',
      createdAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
    }],
  }));
  const agentHome = path.join(instarHome, 'agents', name);
  const stateDir = path.join(agentHome, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return { agentHome, stateDir };
}

function makeMigrator(stateDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir: path.dirname(stateDir), stateDir, port: 9999, hasTelegram: false, projectName: 'integ-agent',
  });
}

describe('PostUpdateMigrator.migrateWorktreeSpotlightExclusion', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-spotlight-mig-'));
    setHome(tmpHome);
    originalAuditDir = process.env.INSTAR_AUDIT_LOG_DIR;
    process.env.INSTAR_AUDIT_LOG_DIR = path.join(tmpHome, 'audit');
  });
  afterEach(() => {
    if (originalAuditDir === undefined) delete process.env.INSTAR_AUDIT_LOG_DIR;
    else process.env.INSTAR_AUDIT_LOG_DIR = originalAuditDir;
    restoreHome();
    SafeFsExecutor.safeRmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100, operation: OP });
  });

  it('backfills the marker into an existing .worktrees/ on update', () => {
    const { agentHome } = setupAgentHome('echo-spotlight');
    const result = makeMigrator(path.join(agentHome, '.instar')).migrate();
    expect(result.upgraded.some((s) => s.includes('worktree-spotlight-exclusion'))).toBe(true);
    expect(fs.existsSync(path.join(agentHome, '.worktrees', '.metadata_never_index'))).toBe(true);
  });

  it('is idempotent — second run reports already-present, no error', () => {
    const { agentHome } = setupAgentHome('echo-spotlight-idem');
    makeMigrator(path.join(agentHome, '.instar')).migrate();
    const result2 = makeMigrator(path.join(agentHome, '.instar')).migrate();
    expect(result2.errors).toEqual([]);
    expect(result2.skipped.some((s) => s.includes('worktree-spotlight-exclusion: marker already present'))).toBe(true);
  });
});
