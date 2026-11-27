// safe-fs-allow: isolated test files; cleanup uses SafeFsExecutor.
import { it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { UsageWallRescue, type WallRescueConfigView } from '../../src/core/UsageWallRescue.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { CodexCliIntelligenceProvider } from '../../src/core/CodexCliIntelligenceProvider.js';
import { SUPPORTED_REVIEWER_FRAMEWORKS } from '../../src/core/crossModelReviewer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); while (cleanups.length) await cleanups.pop()!(); });

it('Sol source review obtains a real authenticated local lease and the child uses that home; refusal starts no child', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-review-alive-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'routine review lifecycle cleanup' }));
  const home = path.join(dir, 'amrch'); fs.mkdirSync(home);
  const record = path.join(dir, 'child-home.json');
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/usr/bin/env node\nconst fs=require('node:fs'); const args=process.argv.slice(2);\nif(args.includes('--version')){console.log('codex 0.170.0');process.exit(0)}\nprocess.stdin.resume(); process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({home:process.env.CODEX_HOME,args}));const i=args.indexOf('--output-last-message');if(i>=0)fs.writeFileSync(args[i+1],'VERDICT: CLEAN\\nNo issues.');console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));});\n`);
  fs.chmodSync(bin, 0o755);
  const state = new StateManager(path.join(dir, 'state'));
  const pool = new SubscriptionPool({ stateDir: dir });
  pool.addFixture({ id: 'amrch', nickname: 'amrch', email: 'fixture@example.test', provider: 'openai', framework: 'codex-cli', configHome: home });
  pool.update('amrch', { lastQuota: { measuredAt: new Date().toISOString(), windowsListed: ['sevenDay'], sevenDay: { utilizationPct: 11, resetsAt: '2099-01-01T00:00:00Z' } } });
  const cfg: WallRescueConfigView = { routineCodexPlacement: { enabled: true, accountIds: ['amrch', 'sagemindai'], expiresAt: new Date(Date.now() + 60_000).toISOString() } };
  const rescue = new UsageWallRescue({ readConfig: () => cfg, listAccounts: () => pool.list(), getSession: () => undefined, configHomeForSession: () => undefined,
    resolveDefaultAccountId: async () => null, swap: async () => ({ swapped: false, toAccountId: null, reason: 'unused' }) });
  const manager = new SessionManager({ projectDir: dir, maxSessions: 5, protectedSessions: [], completionPatterns: ['done'], tmuxPath: '/usr/bin/true', claudePath: '/usr/bin/true' } as any, state);
  cleanups.push(() => manager.stopMonitoring());
  manager.setCodexSpawnAccountResolver(context => rescue.codexSpawnAccount(context));
  const app = express(); app.use(express.json());
  app.use(createRoutes({ config: { authToken: 'fixture-only', stateDir: dir, projectDir: dir, sessions: {}, subscriptionPool: cfg },
    startTime: new Date(), sessionManager: manager, state, subscriptionPool: pool, usageWallRescue: rescue } as any));
  const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  vi.stubEnv('INSTAR_AUTH_TOKEN', 'fixture-only');
  const provider = new CodexCliIntelligenceProvider({ codexPath: bin, resolveExecJson: () => true });
  const reviewer = SUPPORTED_REVIEWER_FRAMEWORKS.find(f => f.id === 'codex-cli')!;
  // The shipped skill driver threads the optional policy with the local port.
  const args = { promptText: 'Review source', timeoutMs: 5000, reviewerConfig: { port, subscriptionPool: cfg },
    detectionOverride: { available: true as const, framework: 'codex-cli' as const, model: 'gpt-6.2-sol' }, providerOverride: provider };
  const result = await reviewer.review(args); expect(result.status).toBe('ok');
  const child = JSON.parse(fs.readFileSync(record, 'utf8'));
  expect(child.home).toBe(home); expect(child.args).toContain('cli_auth_credentials_store="file"');
  expect(child.args).toContain('gpt-6.2-sol');
  fs.renameSync(record, path.join(dir, 'first-child.json'));
  for (const execJson of [true, false]) {
    const queuedProvider = new CodexCliIntelligenceProvider({ codexPath: bin, resolveExecJson: () => execJson });
    const result = await reviewer.review({ ...args, providerOverride: { evaluate: async (prompt, options) => {
      cfg.routineCodexPlacement!.enabled = false;
      return queuedProvider.evaluate(prompt, options);
    } } });
    expect(result.status).toBe('degraded'); expect(fs.existsSync(record)).toBe(false);
    cfg.routineCodexPlacement!.enabled = true;
  }
  pool.update('amrch', { status: 'disabled' });
  expect((await reviewer.review(args)).status).toBe('degraded');
  expect(fs.existsSync(record)).toBe(false);
});
