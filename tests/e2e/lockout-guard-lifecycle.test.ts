import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import request from 'supertest';
import { createRequire } from 'node:module';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { installBrowserScripts } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const require = createRequire(import.meta.url);
const run = promisify(execFile);
let server: AgentServer | undefined;
let home: string | undefined;
let oldHome: string | undefined;
let oldCodex: string | undefined;
afterEach(async () => {
  await server?.stop(); server = undefined;
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
  if (home) SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/e2e/lockout-guard-lifecycle.test.ts' });
});
describe('lockout guard alive on production server and installed helper path', () => {
  it('protects installed credentials, keeps password reads, and consumes one PIN approval', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lockout-life-'));
    oldHome = process.env.HOME; oldCodex = process.env.CODEX_HOME;
    process.env.HOME = home; process.env.CODEX_HOME = path.join(home, '.codex');
    const stateDir = path.join(home, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    const config = { projectName: 'lockout-test', projectDir: home, stateDir, port: 0, authToken: 'test-agent-token', dashboardPin: '123456', requestTimeoutMs: 10_000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {} };
    server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null, on: () => {} }, state: new StateManager(stateDir) } as never);
    await server.start();
    const app = server.getApp();
    const helpers = path.join(stateDir, 'scripts');
    installBrowserScripts(home);
    fs.copyFileSync('src/templates/scripts/secret-get.mjs', path.join(helpers, 'secret-get.mjs'));
    // Disposable vault implementation: this checks the deployed script boundary, never the OS keychain.
    fs.mkdirSync(path.join(home, 'dist/core'), { recursive: true });
    fs.writeFileSync(path.join(home, 'dist/core/SecretStore.js'), 'exports.SecretStore=class { read(){return {password:"ordinary",npm_recovery_codes:"breakglass"}} };');
    fs.mkdirSync(path.join(stateDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'secrets/config.secrets.enc'), 'fixture');
    // Find the real bound port without assuming production internals expose it.
    const listener = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => listener.once('listening', resolve));
    const port = (listener.address() as { port: number }).port;
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ ...config, port }));
    const invoke = (args: string[]) => run(process.execPath, [path.join(helpers, 'secret-get.mjs'), ...args], { cwd: home, env: { ...process.env, INSTAR_OPERATOR_APPROVAL: '' } });
    try {
      expect((await invoke(['password'])).stdout).toBe('ordinary');
      await expect(invoke(['npm_recovery_codes'])).rejects.toMatchObject({ stdout: '', stderr: expect.stringContaining('break-glass access refused') });
      const { action } = require(path.join(helpers, 'browser/lockout-guard.cjs'));
      await request(app).post('/lockout/request').send({ action: action('secret-get', 'npm_recovery_codes', 'null', '') }).expect(401);
      const r = await request(app).post('/lockout/request').set('Authorization', 'Bearer test-agent-token').send({ action: action('secret-get', 'npm_recovery_codes', 'null', '') }).expect(200);
      await request(app).get(`/lockout/approve/${r.body.id}`).expect(200);
      await request(app).post(`/lockout/approve/${r.body.id}`).set('Authorization', 'Bearer test-agent-token').send({ approved: true }).expect(403);
      await request(app).post(`/lockout/approve/${r.body.id}`).send({ pin: '123456' }).expect(200);
      expect((await invoke(['npm_recovery_codes', `--operator-approval=${r.body.id}`])).stdout).toBe('breakglass');
      await expect(invoke(['npm_recovery_codes', `--operator-approval=${r.body.id}`])).rejects.toMatchObject({ stdout: '' });
      const clickCode = 'document.querySelector("form").submit()';
      const browserAction = action('chrome-js.sh', 'acct', clickCode, 'https://npmjs.com');
      const browserRequest = await request(app).post('/lockout/request').set('Authorization', 'Bearer test-agent-token').send({ action: browserAction }).expect(200);
      await request(app).post(`/lockout/approve/${browserRequest.body.id}`).send({ pin: '123456' }).expect(200);
      const browserArgs = [path.join(helpers, 'browser/lockout-guard.cjs'), 'wrap', home, 'chrome-js.sh', 'acct', clickCode, 'https://npmjs.com'];
      const approved = await run(process.execPath, browserArgs, { env: { ...process.env, INSTAR_OPERATOR_APPROVAL: browserRequest.body.id } });
      let submits = 0;
      vm.runInNewContext(approved.stdout, { document: { body: { innerText: 'Warning: account suspension' }, querySelector: () => ({ submit: () => submits++ }) } });
      expect(submits).toBe(1);
      await expect(run(process.execPath, browserArgs, { env: { ...process.env, INSTAR_OPERATOR_APPROVAL: browserRequest.body.id } })).rejects.toMatchObject({ stdout: '' });
      // Exercise the normal Bitwarden/custom-field + local-writer handoff with disposable transports.
      fs.writeFileSync(path.join(home, 'dist/core/SecretStore.js'), `const fs=require('node:fs');exports.SecretStore=class { read(){return {}} get(){return undefined} set(k,v){fs.writeFileSync('stored-value.json',JSON.stringify({k,v}))} };`);
      fs.writeFileSync(path.join(helpers, 'bw-session.cjs'), `let item;exports.openBw=()=>({close(){},bw(args,input){if(args[0]==='list')return '[]';if(args[1]==='template')return '{}';if(args[0]==='encode')return input;if(args[0]==='create'){item=JSON.parse(input);item.id='test';return JSON.stringify(item)}if(args[0]==='get')return JSON.stringify(item);throw Error('unexpected command')}});`);
      const stored = await new Promise<{code: number | null; stderr: string}>(resolve => {
        const child = spawn(process.execPath, [path.join(helpers, 'credential-store.mjs'), 'normal_key', '--bw-name', 'login', '--bw-field', 'api token'], { cwd: home });
        let stderr = ''; child.stderr.on('data', b => { stderr += b; });
        child.on('close', code => resolve({code, stderr})); child.stdin.end('ordinary-value');
      });
      expect(stored.code, stored.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(home, 'stored-value.json'), 'utf8'))).toEqual({ k: 'normal_key', v: 'ordinary-value' });
      // A named Bitwarden recovery field is refused before reading stdin or invoking bw.
      await expect(run(process.execPath, [path.join(helpers, 'credential-store.mjs'), 'normal_key', '--bw-name', 'login', '--bw-field', 'backup codes'], { cwd: home })).rejects.toMatchObject({ stdout: '', stderr: expect.stringContaining('break-glass access refused') });
    } finally { await new Promise<void>((resolve, reject) => listener.close(e => e ? reject(e) : resolve())); }
  }, 120_000);
});
