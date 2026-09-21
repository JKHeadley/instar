// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * setup-autonomous.sh — vault-aware auth + loud registration refusal
 * (VAULT_AUTH_RESOLVE). Runs the REAL bundled script against a real local HTTP
 * server, so what is proven is behaviour, not bytes:
 *   - the bearer token reaching the server comes from the vault when
 *     config.json holds the SecretMigrator placeholder ({"secret": true});
 *   - a REFUSED registration (403) aborts an admission-enforcing install
 *     loudly instead of writing a run that sits "preparing" forever;
 *   - a non-enforcing install keeps registration best-effort (loud, not fatal).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SETUP = path.resolve(__dirname, '../../.claude/skills/autonomous/scripts/setup-autonomous.sh');
const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

function startServer(registerStatus: number, registerBody: unknown) {
  const seen: { registerAuth?: string } = {};
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/autonomous/can-start')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ allowed: true }));
      return;
    }
    if (req.method === 'POST' && req.url === '/autonomous/register') {
      seen.registerAuth = req.headers.authorization;
      res.statusCode = registerStatus;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(registerBody));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  cleanups.push(() => server.close());
  return new Promise<{ port: number; seen: typeof seen }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, seen }));
  });
}

function makeAgentDir(port: number, opts: { enforcing: boolean; configToken?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-vault-auth-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'setup-vault-auth-test.cleanup' }));
  fs.mkdirSync(path.join(dir, '.instar', 'scripts'), { recursive: true });
  const config: Record<string, unknown> = {
    port,
    authToken: opts.configToken ?? { secret: true }, // the SecretMigrator placeholder
    projectName: opts.enforcing ? 'echo' : 'plain-agent',
    ...(opts.enforcing ? { developmentAgent: true, monitoring: { windowRunLiveness: { enabled: true, dryRun: false } } } : {}),
  };
  fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, '.instar', 'scripts', 'secret-get.mjs'), "process.stdout.write('vault-secret-token\\n');\n");
  return dir;
}

function runSetup(cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('bash', [SETUP, '--goal', 'test goal', '--duration', '1h', '--report-topic', '424242'],
      { cwd, timeout: 60_000 },
      (err, stdout, stderr) => resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

describe('setup-autonomous.sh vault-aware auth (VAULT_AUTH_RESOLVE)', () => {
  it('a placeholder config token resolves from the vault — the server receives the vault value', async () => {
    const { port, seen } = await startServer(403, { error: 'forbidden' });
    const dir = makeAgentDir(port, { enforcing: false });
    const r = await runSetup(dir);
    expect(seen.registerAuth).toBe('Bearer vault-secret-token');
    expect(r.code).toBe(0); // non-enforcing: best-effort registration, run proceeds
    expect(r.stderr).toContain('registration REFUSED (HTTP 403)');
    expect(fs.existsSync(path.join(dir, '.instar', 'autonomous', '424242.local.md'))).toBe(true);
  });

  it('a real string token in config wins over the vault', async () => {
    const { port, seen } = await startServer(200, { runId: 'r-1', initialStatus: 'active' });
    const dir = makeAgentDir(port, { enforcing: false, configToken: 'config-token' });
    const r = await runSetup(dir);
    expect(seen.registerAuth).toBe('Bearer config-token');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('runId r-1');
  });

  it('an admission-enforcing install ABORTS loudly when registration is refused', async () => {
    const { port } = await startServer(403, { error: 'forbidden' });
    const dir = makeAgentDir(port, { enforcing: true });
    const r = await runSetup(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('ABORTING SETUP');
    // the silent no-start is closed: no state file is written for the topic
    expect(fs.existsSync(path.join(dir, '.instar', 'autonomous', '424242.local.md'))).toBe(false);
  });

  it('an enforcing install with an UNREACHABLE server still starts preparing (existing contract preserved)', async () => {
    const dir = makeAgentDir(1, { enforcing: true }); // port 1: nothing listens
    const r = await runSetup(dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('registration unavailable');
    const state = fs.readFileSync(path.join(dir, '.instar', 'autonomous', '424242.local.md'), 'utf8');
    expect(state).toContain('status: preparing');
  });
});
