// Create a NEW expiring identity; never renew or copy an expired target.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../../dist/commands/init.js';

const [root, agentId, portText] = process.argv.slice(2);
const allowedHosts = new Set(['MacBook-Pro.local', 'DaBombs-Mac-Studio.local', 'Justins-Mac-mini.local']);
if (!allowedHosts.has(os.hostname()) || !root?.includes('/echo-compute/recovery-10000001794/test-a4-')
    || !path.isAbsolute(root) || !/^[a-zA-Z0-9_-]{1,64}$/.test(agentId ?? '')) throw new Error('disposable-test-host-required');
const projectDir = path.join(root, 'agent');
if (fs.existsSync(path.join(projectDir, '.instar/config.json'))) throw new Error('new-test-identity-required');
const port = Number(portText);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('test-port-invalid');
fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
process.env.INSTAR_TEST_REGISTRY_DIR = path.join(root, 'registry');
await initProject({ name: agentId, dir: projectDir, port, framework: 'codex-cli', skipPrereqs: true, expiresIn: '6h', interactive: false });
const file = path.join(projectDir, '.instar/config.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
Object.assign(config, { messaging: [], multiMachine: { enabled: false }, threadline: { enabled: false },
  dispatches: { ...config.dispatches, enabled: false }, feedback: { ...config.feedback, enabled: false }, updates: { ...config.updates, autoApply: false }, autoUpdate: { enabled: false }, tunnel: { ...config.tunnel, enabled: false } });
fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(projectDir, '.instar/jobs.json'), '[]', { mode: 0o600 });
console.log(JSON.stringify({ agentId, projectDir, expiresAt: config.throwawayAgent?.expiresAt, freshIdentity: true }));
