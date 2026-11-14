/**
 * context-budget-layered-summaries §9.2 rung 1 — the clear-seed hook prints a
 * staged fold packet after an Instar-injected /clear, and nothing otherwise.
 *
 * Both sides of every decision boundary, against the rendered hook and the real
 * pointer writer:
 *   - a valid pointer for this session ⇒ the packet prints once, the pointer is
 *     claimed, the seeded marker carries epoch = foldId
 *   - a second clear on the same pointer ⇒ nothing (single use)
 *   - no pointer (a human /clear) ⇒ nothing, exit 0
 *   - expired lock, sha mismatch, another session's pointer, a packet outside the
 *     context-layers root ⇒ nothing
 *   - switch off, or a non-Claude engine ⇒ nothing
 *   - a worktree session reads the agent home's state root
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  writeClearSeedPointer,
  clearSeedPointerPath,
  removeClearSeedPointer,
  contextLayersRoot,
  CLEAR_SEED_MAX_PACKET_BYTES,
} from '../../src/monitoring/clearSeedPointer.js';

const OP = 'tests/unit/clear-seed-hook.test.ts';
const SID = 'sess-1234_ab'; // the NEW Claude session id the hook sees after /clear
const IID = 'inst-77'; // INSTAR_SESSION_ID, stable across the clear
const OLD = 'claude-before-clear';
const FOLD = 'fold-0001';
const PACKET = '=== FOLD PACKET ===\nAnchor: build the context budget\n';

let projectDir: string;
let stateDir: string;
let hookPath: string;

function writePacket(root: string, body = PACKET): string {
  const dir = path.join(contextLayersRoot(root), 'topic-1', 'folds', FOLD);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'packet.md');
  fs.writeFileSync(f, body);
  return f;
}

function run(input: unknown, env: Record<string, string> = {}): { out: string; status: number | null } {
  const r = spawnSync('bash', [hookPath], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { PATH: process.env.PATH ?? '', HOME: projectDir, CLAUDE_PROJECT_DIR: projectDir, INSTAR_SESSION_ID: IID, ...env },
    timeout: 20_000,
  });
  return { out: r.stdout.toString('utf-8'), status: r.status };
}

const markerFile = (root: string) => path.join(contextLayersRoot(root), '_seeded', `${SID}.json`);

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-seed-'));
  stateDir = path.join(projectDir, '.instar');
  const hooksDir = path.join(stateDir, 'hooks', 'instar');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 1 }));
  const migrator = new PostUpdateMigrator({ stateDir, port: 1, sessions: { claudePath: 'claude' } } as never);
  hookPath = path.join(hooksDir, 'clear-seed.sh');
  fs.writeFileSync(hookPath, (migrator as unknown as { getHookContent(n: string): string }).getHookContent('clear-seed'), { mode: 0o755 });
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: OP });
});

describe('clear-seed hook (§9.2 rung 1)', () => {
  it('prints the staged packet once, claims the pointer and writes the seeded marker with epoch = foldId', () => {
    const p = writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: OLD, foldId: FOLD, packetFile: writePacket(stateDir), leaseExpiresAt: Date.now() + 60_000 });
    expect(p).not.toBeNull();
    const r = run({ source: 'clear', session_id: SID });
    expect(r.status).toBe(0);
    expect(r.out).toBe(PACKET);
    expect(fs.existsSync(clearSeedPointerPath(stateDir, IID)!)).toBe(false);
    const m = JSON.parse(fs.readFileSync(markerFile(stateDir), 'utf-8'));
    expect(m).toMatchObject({ sessionId: SID, epoch: FOLD, source: 'clear' });
    expect(fs.statSync(markerFile(stateDir)).mode & 0o777).toBe(0o600);
    // Single use: a second clear finds no pointer.
    expect(run({ source: 'clear', session_id: SID }).out).toBe('');
  });

  it('prints nothing on a human /clear (no staged pointer)', () => {
    const r = run({ source: 'clear', session_id: SID });
    expect(r.status).toBe(0);
    expect(r.out).toBe('');
    expect(fs.existsSync(markerFile(stateDir))).toBe(false);
  });

  it('refuses an expired lock', () => {
    writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: OLD, foldId: FOLD, packetFile: writePacket(stateDir), leaseExpiresAt: Date.now() + 60_000 });
    const ptr = clearSeedPointerPath(stateDir, IID)!;
    const p = JSON.parse(fs.readFileSync(ptr, 'utf-8'));
    fs.writeFileSync(ptr, JSON.stringify({ ...p, leaseExpiresAt: Date.now() - 1 }));
    expect(run({ source: 'clear', session_id: SID }).out).toBe('');
    expect(fs.existsSync(ptr)).toBe(true);
  });

  it('refuses a packet whose bytes changed after staging', () => {
    const f = writePacket(stateDir);
    writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: OLD, foldId: FOLD, packetFile: f, leaseExpiresAt: Date.now() + 60_000 });
    fs.appendFileSync(f, 'tampered');
    expect(run({ source: 'clear', session_id: SID }).out).toBe('');
  });

  it("refuses another Instar session's pointer", () => {
    writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: OLD, foldId: FOLD, packetFile: writePacket(stateDir), leaseExpiresAt: Date.now() + 60_000 });
    // A pointer file copied under another id still names IID inside: refused.
    fs.copyFileSync(clearSeedPointerPath(stateDir, IID)!, clearSeedPointerPath(stateDir, 'other-inst')!);
    expect(run({ source: 'clear', session_id: SID }, { INSTAR_SESSION_ID: 'other-inst' }).out).toBe('');
    // And a session with no INSTAR_SESSION_ID (hand-started) never seeds.
    expect(run({ source: 'clear', session_id: SID }, { INSTAR_SESSION_ID: '' }).out).toBe('');
  });

  it('seeds only on source "clear"', () => {
    writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: OLD, foldId: FOLD, packetFile: writePacket(stateDir), leaseExpiresAt: Date.now() + 60_000 });
    expect(run({ source: 'startup', session_id: SID }).out).toBe('');
    expect(run({ session_id: SID }).out).toBe('');
    expect(run({ source: 'clear', session_id: SID }).out).toBe(PACKET);
  });

  it('refuses a hand-written pointer whose packet escapes the context-layers root', () => {
    const outside = path.join(projectDir, 'secret.txt');
    fs.writeFileSync(outside, 'SECRET');
    const ptr = clearSeedPointerPath(stateDir, IID)!;
    fs.mkdirSync(path.dirname(ptr), { recursive: true });
    const sha = crypto.createHash('sha256').update('SECRET').digest('hex');
    fs.writeFileSync(ptr, JSON.stringify({ instarSessionId: IID, foldId: FOLD, packetPath: '../../../secret.txt', sha256: sha, leaseExpiresAt: Date.now() + 60_000 }));
    expect(run({ source: 'clear', session_id: SID }).out).toBe('');
  });

  it('with the switch off, prints nothing', () => {
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ contextBudget: { compactionRecovery: { enabled: false } } }));
    writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: OLD, foldId: FOLD, packetFile: writePacket(stateDir), leaseExpiresAt: Date.now() + 60_000 });
    expect(run({ source: 'clear', session_id: SID }).out).toBe('');
  });

  it('prints nothing on a non-Claude engine', () => {
    writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: OLD, foldId: FOLD, packetFile: writePacket(stateDir), leaseExpiresAt: Date.now() + 60_000 });
    expect(run({ source: 'clear', session_id: SID }, { INSTAR_FRAMEWORK: 'codex-cli' }).out).toBe('');
  });

  it('prints nothing for unreadable stdin', () => {
    expect(run('not json').out).toBe('');
  });

  it('reads the agent home state root for a worktree session', () => {
    const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-seed-home-'));
    try {
      const homeState = path.join(agentHome, '.instar');
      fs.mkdirSync(homeState, { recursive: true });
      writeClearSeedPointer(homeState, { instarSessionId: IID, claudeSessionId: OLD, foldId: FOLD, packetFile: writePacket(homeState), leaseExpiresAt: Date.now() + 60_000 });
      expect(run({ source: 'clear', session_id: SID }, { INSTAR_AGENT_HOME: agentHome }).out).toBe(PACKET);
      expect(fs.existsSync(markerFile(homeState))).toBe(true);
    } finally {
      SafeFsExecutor.safeRmSync(agentHome, { recursive: true, force: true, operation: OP });
    }
  });
});

describe('writeClearSeedPointer', () => {
  it('refuses an unsafe session or fold id, a past expiry, and a packet outside the root', () => {
    const f = writePacket(stateDir);
    const future = Date.now() + 60_000;
    expect(writeClearSeedPointer(stateDir, { instarSessionId: '../x', claudeSessionId: OLD, foldId: FOLD, packetFile: f, leaseExpiresAt: future })).toBeNull();
    expect(writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: OLD, foldId: 'a/b', packetFile: f, leaseExpiresAt: future })).toBeNull();
    expect(writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: OLD, foldId: FOLD, packetFile: f, leaseExpiresAt: Date.now() - 1 })).toBeNull();
    const outside = path.join(projectDir, 'p.md');
    fs.writeFileSync(outside, 'x');
    expect(writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: OLD, foldId: FOLD, packetFile: outside, leaseExpiresAt: future })).toBeNull();
  });

  it('refuses a packet over the hook limit', () => {
    const f = writePacket(stateDir, 'x'.repeat(CLEAR_SEED_MAX_PACKET_BYTES + 1));
    expect(writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: OLD, foldId: FOLD, packetFile: f, leaseExpiresAt: Date.now() + 60_000 })).toBeNull();
  });

  it('writes 0600 under a 0700 directory, and remove withdraws it', () => {
    const p = writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: OLD, foldId: FOLD, packetFile: writePacket(stateDir), leaseExpiresAt: Date.now() + 60_000 });
    expect(p!.packetPath).toBe(path.join('topic-1', 'folds', FOLD, 'packet.md'));
    const ptr = clearSeedPointerPath(stateDir, IID)!;
    expect(fs.statSync(ptr).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(ptr)).mode & 0o777).toBe(0o700);
    removeClearSeedPointer(stateDir, IID);
    expect(fs.existsSync(ptr)).toBe(false);
  });

  it('remove also releases the claimed copies the hook left, and nothing of another session', () => {
    writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: OLD, foldId: FOLD, packetFile: writePacket(stateDir), leaseExpiresAt: Date.now() + 60_000 });
    expect(run({ source: 'clear', session_id: SID }).out).toBe(PACKET);
    writeClearSeedPointer(stateDir, { instarSessionId: 'other-inst', claudeSessionId: OLD, foldId: FOLD, packetFile: writePacket(stateDir), leaseExpiresAt: Date.now() + 60_000 });
    const dir = path.dirname(clearSeedPointerPath(stateDir, IID)!);
    expect(fs.readdirSync(dir).some(f => f.startsWith(`${IID}.json.claimed-`))).toBe(true);
    removeClearSeedPointer(stateDir, IID);
    expect(fs.readdirSync(dir)).toEqual(['other-inst.json']);
  });
});

describe('settings carry the clear matcher (Migration Parity)', () => {
  it('migrateSettings adds one clear-seed entry to an existing SessionStart, idempotently', () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const ss = { type: 'command', command: 'bash "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/session-start.sh"', timeout: 5 };
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [
      { matcher: 'startup', hooks: [ss] }, { matcher: 'resume', hooks: [ss] }, { matcher: 'compact', hooks: [ss] },
    ] } }));
    const m = new PostUpdateMigrator({ projectDir, stateDir, port: 4042, hasTelegram: false, projectName: 't' } as never);
    const runIt = () => {
      const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
      (m as unknown as { migrateSettings(r: typeof result): void }).migrateSettings(result);
      return result;
    };
    const r1 = runIt();
    expect(r1.upgraded.some(u => u.includes('clear matcher'))).toBe(true);
    runIt();
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const clear = after.hooks.SessionStart.filter((e: { matcher: string }) => e.matcher === 'clear');
    expect(clear).toHaveLength(1);
    expect(clear[0].hooks[0].command).toContain('clear-seed.sh');
  });
});
