// safe-git-allow: test fixture builds a throwaway git repo in a tmpdir to exercise tracked/untracked detection
/**
 * PostUpdateMigrator.migrateSubscriptionPoolToMachineLocal (instar#2122; spec
 * subscription-pool-authority-foundation "legacy single-file staged migration").
 * A git-tracked legacy file is left in place (a deletion would propagate to peers
 * through the agent home's repo); an untracked one is removed after publication.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'PostUpdateMigrator-subscription-pool-machine-local.test:cleanup' });
});

async function agentHome(opts: { git: boolean; trackLegacy: boolean }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pum-pool-'));
  dirs.push(home);
  const stateDir = path.join(home, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const mgr = new MachineIdentityManager(stateDir);
  const identity = await mgr.generateIdentity({ name: 'test-machine' });
  const here = path.join(home, 'claude-here');
  fs.mkdirSync(here);
  const legacy = path.join(stateDir, 'subscription-pool.json');
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, accounts: [
    { id: 'here', nickname: 'here', email: 'h@example.com', provider: 'anthropic', framework: 'claude-code', configHome: here, status: 'active', enrolledAt: '2026-01-01T00:00:00.000Z', version: 1 },
    { id: 'elsewhere', nickname: 'elsewhere', email: 'e@example.com', provider: 'anthropic', framework: 'claude-code', configHome: path.join(home, 'missing-home'), status: 'active', enrolledAt: '2026-01-01T00:00:00.000Z', version: 1 },
  ] }, null, 2));
  fs.writeFileSync(path.join(home, '.gitignore'), 'node_modules/\n');
  if (opts.git) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: home, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    git('init', '-q');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.gitignore');
    if (opts.trackLegacy) git('add', '-f', '.instar/subscription-pool.json');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  }
  return { home, stateDir, legacy, machineId: identity.machineId };
}

function run(home: string, stateDir: string) {
  const migrator = new PostUpdateMigrator({ projectDir: home, stateDir, port: 4042, hasTelegram: false, projectName: 'test' });
  const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
  (migrator as unknown as { migrateSubscriptionPoolToMachineLocal(r: typeof result): void }).migrateSubscriptionPoolToMachineLocal(result);
  return result;
}

describe('PostUpdateMigrator.migrateSubscriptionPoolToMachineLocal', () => {
  it('git-tracked legacy: publishes the per-machine authority (dropping homes not on this machine), leaves the shared file, adds the ignore entry, and is idempotent', async () => {
    const { home, stateDir, legacy, machineId } = await agentHome({ git: true, trackLegacy: true });
    const before = fs.readFileSync(legacy, 'utf8');
    const first = run(home, stateDir);
    expect(first.errors).toEqual([]);
    expect(first.upgraded.some((u) => u.includes('published 1 account(s)') && u.includes('dropped 1') && u.includes('elsewhere') && u.includes('left in place'))).toBe(true);
    expect(first.upgraded.some((u) => u.startsWith('gitignore: .instar/subscription-pool.json'))).toBe(true);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(home, '.gitignore'), 'utf8')).toMatch(/^\.instar\/subscription-pool\.json$/m);
    expect(new SubscriptionPool({ stateDir, machineId }).list().map((a) => a.id)).toEqual(['here']);

    const second = run(home, stateDir);
    expect(second.upgraded).toEqual([]);
    expect(second.errors).toEqual([]);
  });

  it('untracked legacy: publishes and removes the source file', async () => {
    const { home, stateDir, legacy, machineId } = await agentHome({ git: true, trackLegacy: false });
    const result = run(home, stateDir);
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('legacy file removed'))).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(new SubscriptionPool({ stateDir, machineId }).list().map((a) => a.id)).toEqual(['here']);
  });

  it('no git repo: tracking is unknown, so the file is kept (never delete on an uncertain answer)', async () => {
    const { home, stateDir, legacy, machineId } = await agentHome({ git: false, trackLegacy: false });
    const result = run(home, stateDir);
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('tracking unknown'))).toBe(true);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(new SubscriptionPool({ stateDir, machineId }).list().map((a) => a.id)).toEqual(['here']);
  });
});
