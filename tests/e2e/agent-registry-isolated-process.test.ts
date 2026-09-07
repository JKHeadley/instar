import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'test:isolated-registry-process:cleanup' }); });
it('inherits an isolated registry into actual Node startup and cleanup calls without changing HOME', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-registry-process-')); roots.push(root);
  const registry = path.join(root, 'registry'), project = path.join(root, 'project'); fs.mkdirSync(project);
  const code = `
    import { registerAgent, heartbeat, loadRegistry, unregisterAgent } from './dist/core/AgentRegistry.js';
    import { resolveAgentDir } from './dist/core/Config.js';
    import { agentRegistryDir } from './dist/core/AgentRegistryPaths.js';
    import { generateAgentToken, getAgentToken } from './dist/messaging/AgentTokenManager.js';
    const project = process.argv[1];
    registerAgent(project, 'isolated-process-agent', 43123);
    const beat = heartbeat(project), entry = loadRegistry().entries[0], resolved = resolveAgentDir(entry.name);
    const token = generateAgentToken(entry.name);
    const tokenRoundTrip = getAgentToken(entry.name) === token && generateAgentToken(entry.name) === token;
    unregisterAgent(project, { onlyIfPid: process.pid });
    console.log(JSON.stringify({ beat, entry, resolved, tokenPresent: token.length === 64, tokenRoundTrip, root: agentRegistryDir(), home: process.env.HOME, remaining: loadRegistry().entries.length }));
  `;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, project], {
    cwd: process.cwd(), env: { ...process.env, INSTAR_TEST_REGISTRY_DIR: registry }, timeout: 15000,
  });
  const result = JSON.parse(child.stdout.trim());
  expect(result).toMatchObject({ beat: true, resolved: project, tokenPresent: true, tokenRoundTrip: true, root: registry, home: process.env.HOME, remaining: 0 });
  expect(result.entry).toMatchObject({ path: project, name: 'isolated-process-agent', status: 'running' });
  expect(result.entry.pid).not.toBe(process.pid);
  expect(JSON.parse(fs.readFileSync(path.join(registry, 'registry.json'), 'utf8')).entries).toEqual([]);
  expect(fs.existsSync(path.join(registry, 'agent-tokens', 'isolated-process-agent.token'))).toBe(true);
});
