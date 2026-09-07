import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentRegistryDir, agentRegistryPath } from '../../src/core/AgentRegistryPaths.js';
import { loadRegistry, registerAgent, heartbeat, unregisterAgent, forceRemoveRegistryLock } from '../../src/core/AgentRegistry.js';
import { resolveAgentDir } from '../../src/core/Config.js';
import { buildAgentList } from '../../src/messaging/GitSyncTransport.js';
import { validateRegistry } from '../../src/commands/discovery.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateAgentToken, getAgentToken } from '../../src/messaging/AgentTokenManager.js';

describe('explicit registry isolation for native process trials', () => {
  let root: string, defaultDir: string, isolated: string;
  const sentinel = JSON.stringify({ version: 1, entries: [{ name: 'untouched', path: '/tmp/untouched', status: 'stale', lastHeartbeat: '2000-01-01' }] });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-paths-'));
    defaultDir = path.join(root, 'home', '.instar'); isolated = path.join(root, 'isolated');
    fs.mkdirSync(defaultDir, { recursive: true }); fs.writeFileSync(path.join(defaultDir, 'registry.json'), sentinel);
    vi.spyOn(os, 'homedir').mockReturnValue(path.dirname(defaultDir));
    vi.stubEnv('INSTAR_TEST_REGISTRY_DIR', isolated);
  });
  afterEach(() => {
    expect(fs.readFileSync(path.join(defaultDir, 'registry.json'), 'utf8')).toBe(sentinel);
    vi.unstubAllEnvs(); vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'test:agent-registry-paths:cleanup' });
  });
  it('preserves the production default when no override is supplied', () => {
    vi.stubEnv('INSTAR_TEST_REGISTRY_DIR', undefined);
    expect(agentRegistryDir()).toBe(defaultDir); expect(agentRegistryPath()).toBe(path.join(defaultDir, 'registry.json'));
    const token = generateAgentToken('default-agent');
    expect(getAgentToken('default-agent') === token).toBe(true);
    expect(fs.existsSync(path.join(defaultDir, 'agent-tokens', 'default-agent.token'))).toBe(true);
    expect(fs.existsSync(path.join(isolated, 'agent-tokens'))).toBe(false);
  });
  it('contains persistent agent authentication tokens in the selected directory', () => {
    const token = generateAgentToken('isolated-agent');
    expect(token.length).toBe(64);
    expect(generateAgentToken('isolated-agent') === token).toBe(true);
    expect(getAgentToken('isolated-agent') === token).toBe(true);
    const tokenFile = path.join(isolated, 'agent-tokens', 'isolated-agent.token');
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(tokenFile)).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(defaultDir, 'agent-tokens'))).toBe(false);
  });
  it('contains registration, stale cleanup, heartbeat and fenced unregister in the selected directory', () => {
    registerAgent(path.join(root, 'dead'), 'dead', 43000, 'project-bound', 99999999);
    const project = path.join(root, 'project'); fs.mkdirSync(path.join(project, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(project, '.instar', 'config.json'), '{}');
    registerAgent(project, 'isolated-agent', 43001);
    expect(loadRegistry().entries.map(entry => entry.name)).toEqual(['isolated-agent']);
    expect(heartbeat(project)).toBe(true);
    expect(resolveAgentDir('isolated-agent')).toBe(project);
    expect(validateRegistry(root).validAgents.map(agent => agent.name)).toEqual(['isolated-agent']);
    unregisterAgent(project, { onlyIfPid: process.pid + 1 }); expect(loadRegistry().entries).toHaveLength(1);
    unregisterAgent(project, { onlyIfPid: process.pid }); expect(loadRegistry().entries).toHaveLength(0);
    expect(fs.readdirSync(isolated)).toEqual(['registry.json']);
  });
  it('keeps legacy migration and lock recovery in the same isolated root', () => {
    fs.mkdirSync(isolated);
    fs.writeFileSync(path.join(isolated, 'port-registry.json'), JSON.stringify({ entries: [{ projectName: 'legacy', projectDir: root, port: 43002, pid: process.pid, registeredAt: '2026-01-01', lastHeartbeat: '2026-01-01' }] }));
    expect(loadRegistry().entries[0].name).toBe('legacy');
    expect(fs.existsSync(path.join(isolated, 'port-registry.json.migrated'))).toBe(true);
    fs.mkdirSync(path.join(defaultDir, 'registry.json.lock')); fs.mkdirSync(path.join(isolated, 'registry.json.lock'));
    expect(forceRemoveRegistryLock()).toBe(true);
    expect(fs.existsSync(path.join(defaultDir, 'registry.json.lock'))).toBe(true);
    expect(fs.existsSync(path.join(isolated, 'registry.json.lock'))).toBe(false);
  });
  it('uses the selected directory for the legacy heartbeat agent-list reader too', () => {
    fs.mkdirSync(isolated); fs.writeFileSync(agentRegistryPath(), JSON.stringify({ agents: [{ name: 'isolated-heartbeat', status: 'running', port: 43003 }] }));
    expect(buildAgentList()).toEqual([{ name: 'isolated-heartbeat', port: 43003, status: 'running' }]);
  });
  it.each(['', 'relative/path', '/'])('rejects invalid explicit override %j without fallback', value => {
    vi.stubEnv('INSTAR_TEST_REGISTRY_DIR', value);
    for (const read of [agentRegistryPath, loadRegistry, () => resolveAgentDir('missing-agent'), () => validateRegistry(root), buildAgentList]) {
      expect(read).toThrow('INSTAR_TEST_REGISTRY_DIR');
    }
    expect(() => registerAgent(root, 'blocked', 43004)).toThrow('INSTAR_TEST_REGISTRY_DIR');
    expect(() => generateAgentToken('blocked')).toThrow('INSTAR_TEST_REGISTRY_DIR');
  });
});
