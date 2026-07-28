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
import { ensureWorktreeSpotlightExclusion, ensureClaudeTranscriptSpotlightExclusion, ensureAgentDataSpotlightExclusion } from '../../src/core/InstarWorktreeManager.js';
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

describe('PostUpdateMigrator.migrateNodeModulesSpotlightExclusion', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-spotlight-mig-'));
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

  it('drops the marker into agent-home node_modules AND shadow-install on update', () => {
    const { agentHome, stateDir } = setupAgentHome('echo-nm');
    fs.mkdirSync(path.join(agentHome, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'shadow-install', 'node_modules'), { recursive: true });
    const result = makeMigrator(stateDir).migrate();
    expect(result.upgraded.some((s) => s.includes('node-modules-spotlight-exclusion'))).toBe(true);
    expect(fs.existsSync(path.join(agentHome, 'node_modules', '.metadata_never_index'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'shadow-install', 'node_modules', '.metadata_never_index'))).toBe(true);
  });

  it('skips missing node_modules dirs without error (no node_modules present)', () => {
    const { stateDir } = setupAgentHome('echo-nm-none');
    const result = makeMigrator(stateDir).migrate();
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((s) => s.includes('node-modules-spotlight-exclusion'))).toBe(false);
  });

  it('is idempotent — second run does not re-report the exclusion', () => {
    const { agentHome, stateDir } = setupAgentHome('echo-nm-idem');
    fs.mkdirSync(path.join(agentHome, 'node_modules'), { recursive: true });
    makeMigrator(stateDir).migrate();
    const result2 = makeMigrator(stateDir).migrate();
    expect(result2.errors).toEqual([]);
    expect(result2.upgraded.some((s) => s.includes('node-modules-spotlight-exclusion'))).toBe(false);
  });
});

// ── Claude transcript exclusion (the ~18GB JSONL churn — the dominant lever) ──

describe('ensureClaudeTranscriptSpotlightExclusion', () => {
  let claudeHome: string;
  let agentHome: string;
  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transcript-'));
    claudeHome = path.join(root, '.claude');
    agentHome = path.join(root, '.instar', 'agents', 'echo');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(path.dirname(claudeHome), { recursive: true, force: true, operation: OP });
  });

  function transcriptDir(): string {
    const encoded = agentHome.replace(/[^a-zA-Z0-9]/g, '-');
    return path.join(claudeHome, 'projects', encoded);
  }

  it('drops the marker at the encoded transcript dir when it exists', () => {
    fs.mkdirSync(transcriptDir(), { recursive: true });
    expect(ensureClaudeTranscriptSpotlightExclusion(agentHome, claudeHome)).toBe(true);
    expect(fs.existsSync(path.join(transcriptDir(), '.metadata_never_index'))).toBe(true);
  });

  it('encodes the agent home with non-alphanumerics -> "-" (matches Claude Code)', () => {
    // The encoded dir name must collapse every "/" and "." to "-".
    const encoded = agentHome.replace(/[^a-zA-Z0-9]/g, '-');
    expect(encoded).not.toMatch(/[/.]/);
    fs.mkdirSync(transcriptDir(), { recursive: true });
    ensureClaudeTranscriptSpotlightExclusion(agentHome, claudeHome);
    expect(fs.existsSync(path.join(claudeHome, 'projects', encoded, '.metadata_never_index'))).toBe(true);
  });

  it('is a graceful no-op when the transcript dir does not exist yet (new agent, no sessions)', () => {
    // No mkdir — the transcript dir is absent.
    expect(ensureClaudeTranscriptSpotlightExclusion(agentHome, claudeHome)).toBe(false);
    expect(fs.existsSync(transcriptDir())).toBe(false);
  });

  it('is idempotent — returns false on the second run', () => {
    fs.mkdirSync(transcriptDir(), { recursive: true });
    expect(ensureClaudeTranscriptSpotlightExclusion(agentHome, claudeHome)).toBe(true);
    expect(ensureClaudeTranscriptSpotlightExclusion(agentHome, claudeHome)).toBe(false);
  });
});

describe('PostUpdateMigrator.migrateClaudeTranscriptSpotlightExclusion', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transcript-mig-'));
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

  it('drops the marker at the transcript dir on update when transcripts exist', () => {
    const { agentHome } = setupAgentHome('echo-transcript');
    const encoded = agentHome.replace(/[^a-zA-Z0-9]/g, '-');
    const transcriptDir = path.join(tmpHome, '.claude', 'projects', encoded);
    fs.mkdirSync(transcriptDir, { recursive: true });
    const result = makeMigrator(path.join(agentHome, '.instar')).migrate();
    expect(result.upgraded.some((s) => s.includes('claude-transcript-spotlight-exclusion'))).toBe(true);
    expect(fs.existsSync(path.join(transcriptDir, '.metadata_never_index'))).toBe(true);
  });

  it('skips without error when the transcript dir is absent (brand-new agent)', () => {
    const { agentHome } = setupAgentHome('echo-transcript-none');
    const result = makeMigrator(path.join(agentHome, '.instar')).migrate();
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((s) => s.includes('claude-transcript-spotlight-exclusion'))).toBe(false);
  });

  it('is idempotent — second run does not re-report the exclusion', () => {
    const { agentHome } = setupAgentHome('echo-transcript-idem');
    const encoded = agentHome.replace(/[^a-zA-Z0-9]/g, '-');
    fs.mkdirSync(path.join(tmpHome, '.claude', 'projects', encoded), { recursive: true });
    makeMigrator(path.join(agentHome, '.instar')).migrate();
    const result2 = makeMigrator(path.join(agentHome, '.instar')).migrate();
    expect(result2.errors).toEqual([]);
    expect(result2.upgraded.some((s) => s.includes('claude-transcript-spotlight-exclusion'))).toBe(false);
  });
});

// ── Agent runtime-data exclusion (the agent's OWN .instar churn: images/dbs/logs/state) ──

describe('ensureAgentDataSpotlightExclusion', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-data-spotlight-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }); });

  it('drops a marker in each high-churn subdir that exists', () => {
    for (const sub of ['telegram-images', 'server-data', 'logs', 'state']) {
      fs.mkdirSync(path.join(stateDir, sub), { recursive: true });
    }
    const created = ensureAgentDataSpotlightExclusion(stateDir);
    expect(created.sort()).toEqual(['logs', 'server-data', 'state', 'telegram-images']);
    for (const sub of created) {
      expect(fs.existsSync(path.join(stateDir, sub, '.metadata_never_index'))).toBe(true);
    }
  });

  it('only marks subdirs that exist — skips absent ones', () => {
    fs.mkdirSync(path.join(stateDir, 'telegram-images'), { recursive: true });
    const created = ensureAgentDataSpotlightExclusion(stateDir);
    expect(created).toEqual(['telegram-images']);
    expect(fs.existsSync(path.join(stateDir, 'server-data', '.metadata_never_index'))).toBe(false);
  });

  it('returns [] for a brand-new agent with no data subdirs yet', () => {
    expect(ensureAgentDataSpotlightExclusion(stateDir)).toEqual([]);
  });

  it('is idempotent — second run returns [] (markers already present)', () => {
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    expect(ensureAgentDataSpotlightExclusion(stateDir)).toEqual(['logs']);
    expect(ensureAgentDataSpotlightExclusion(stateDir)).toEqual([]);
  });
});

describe('PostUpdateMigrator.migrateAgentDataSpotlightExclusion', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-data-spotlight-mig-'));
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

  it('drops markers into the agent .instar/ churn subdirs on update', () => {
    const { stateDir } = setupAgentHome('echo-agent-data');
    fs.mkdirSync(path.join(stateDir, 'telegram-images'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'server-data'), { recursive: true });
    const result = makeMigrator(stateDir).migrate();
    expect(result.upgraded.some((s) => s.includes('agent-data-spotlight-exclusion'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'telegram-images', '.metadata_never_index'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'server-data', '.metadata_never_index'))).toBe(true);
  });

  it('skips without error when no churn subdirs exist (brand-new agent)', () => {
    const { stateDir } = setupAgentHome('echo-agent-data-none');
    const result = makeMigrator(stateDir).migrate();
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((s) => s.includes('agent-data-spotlight-exclusion'))).toBe(false);
  });

  it('is idempotent — second run does not re-report the exclusion', () => {
    const { stateDir } = setupAgentHome('echo-agent-data-idem');
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    makeMigrator(stateDir).migrate();
    const result2 = makeMigrator(stateDir).migrate();
    expect(result2.errors).toEqual([]);
    expect(result2.upgraded.some((s) => s.includes('agent-data-spotlight-exclusion'))).toBe(false);
  });
});
