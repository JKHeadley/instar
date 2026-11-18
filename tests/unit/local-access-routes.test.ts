// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalAccessService, coversLoopbackV4, ensureListenerKey, localPeer, readListenerKey, verifiedLocalBudgetKey,
} from '../../src/server/localAccessRoutes.js';
import { detectStartedBy, resolveAgentDir } from '../../src/commands/dashboardOpen.js';
import { KEY_MATERIAL_DYNAMIC_DIRS, KEY_MATERIAL_FILES, KEY_MATERIAL_PATHS } from '../../src/core/keyMaterialPaths.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/local-access-routes.test.ts:cleanup';
const dirs: string[] = [];
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) SafeFsExecutor.safeRmSync(dirs.pop()!, { recursive: true, force: true, operation: OP }); });

const req = (localAddress: string, remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { localAddress, remoteAddress }, headers }) as any;

describe('local access link — helpers', () => {
  it('bind coverage reads the socket address: 127.0.0.1, 0.0.0.0 and :: cover; others do not', () => {
    expect(coversLoopbackV4({ address: '127.0.0.1', family: 'IPv4', port: 1 })).toBe(true);
    expect(coversLoopbackV4({ address: '0.0.0.0', family: 'IPv4', port: 1 })).toBe(true);
    expect(coversLoopbackV4({ address: '::', family: 'IPv6', port: 1 })).toBe(true);
    expect(coversLoopbackV4({ address: '100.64.1.2', family: 'IPv4', port: 1 })).toBe(false);
    expect(coversLoopbackV4({ address: '::1', family: 'IPv6', port: 1 })).toBe(false);
    expect(coversLoopbackV4(null)).toBe(false);
  });

  it('accepts only requests that arrived on the 127.0.0.1 socket from loopback with no forwarding header', () => {
    expect(localPeer(req('127.0.0.1', '127.0.0.1'))).toBe(true);
    expect(localPeer(req('::ffff:127.0.0.1', '::ffff:127.0.0.1'))).toBe(true);
    expect(localPeer(req('::1', '::1'))).toBe(false);
    expect(localPeer(req('127.0.0.1', '192.168.1.5'))).toBe(false);
    expect(localPeer(req('127.0.0.1', '127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }))).toBe(false);
    expect(localPeer(req('127.0.0.1', '127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' }))).toBe(false);
  });

  it('names the verified-local budget with fallbacks, never undefined', () => {
    expect(verifiedLocalBudgetKey(undefined, undefined)).toBe('local-verified:single:none');
    expect(verifiedLocalBudgetKey('m_abc', 3)).toBe('local-verified:m_abc:3');
    expect(verifiedLocalBudgetKey('bad id!', null)).toBe('local-verified:single:none');
  });

  it('creates a private 32-byte listener key once and refuses a loosened one', () => {
    const d = tmp('la-key-');
    const k1 = ensureListenerKey(d);
    const k2 = ensureListenerKey(d);
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
    const f = path.join(d, 'local-access', 'listener.key');
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    fs.chmodSync(f, 0o644);
    expect(() => readListenerKey(d)).toThrow('local-access-key-ownership-invalid');
  });

  it('writes the launcher only for a real CLI entry, mode 0700, pointing at this agent folder', () => {
    const project = tmp('la-launch-');
    const stateDir = path.join(project, '.instar');
    fs.mkdirSync(stateDir);
    const svc = new LocalAccessService({ stateDir, agentName: () => 'a', enabled: () => true, boundAddress: () => null, dashboardDir: project });
    expect(svc.writeLauncher('/usr/bin/vitest', '/usr/bin/node')).toBe(false);
    expect(svc.writeLauncher("/opt/x/it's/dist/cli.js", '/usr/local/bin/node')).toBe(true);
    const body = fs.readFileSync(svc.launcherPath(), 'utf-8');
    expect(fs.statSync(svc.launcherPath()).mode & 0o777).toBe(0o700);
    expect(body).toContain('dashboard open --dir');
    expect(body).toContain(project);
    expect(body).toContain(`'/opt/x/it'\\''s/dist/cli.js'`);
    svc.close();
  });

  it('sweeps launch documents no live ticket owns, even with the switch off', () => {
    const project = tmp('la-sweep-');
    const stateDir = path.join(project, '.instar');
    const launch = path.join(stateDir, 'local-access', 'launch');
    fs.mkdirSync(launch, { recursive: true });
    const orphan = path.join(launch, `${'Z'.repeat(22)}.html`);
    fs.writeFileSync(orphan, 'x');
    const svc = new LocalAccessService({ stateDir, agentName: () => 'a', enabled: () => false, boundAddress: () => null, dashboardDir: project });
    svc.sweepLaunchDocuments();
    expect(fs.existsSync(orphan)).toBe(false);
    svc.close();
  });

  it('is off when the socket does not cover 127.0.0.1, and when the switch is off', () => {
    const project = tmp('la-off-');
    const stateDir = path.join(project, '.instar');
    fs.mkdirSync(stateDir);
    const mk = (enabled: boolean, address: string) => new LocalAccessService({ stateDir, agentName: () => 'a', enabled: () => enabled, boundAddress: () => ({ address, family: 'IPv4', port: 9 }), dashboardDir: project });
    expect(mk(false, '127.0.0.1').unavailableReason()).toBe('off');
    expect(mk(true, '100.64.0.1').unavailableReason()).toBe('not-listening-on-127.0.0.1');
    const on = mk(true, '127.0.0.1');
    expect(on.unavailableReason()).toBeNull();
    on.close();
  });
});

describe('local access link — CLI resolution', () => {
  it('finds the enclosing agent, else the only standalone agent, else asks for --dir', () => {
    const home = tmp('la-home-');
    const agents = path.join(home, '.instar', 'agents');
    fs.mkdirSync(path.join(agents, 'one', '.instar'), { recursive: true });
    fs.writeFileSync(path.join(agents, 'one', '.instar', 'config.json'), '{}');
    expect(resolveAgentDir(undefined, home, home)).toEqual({ dir: path.join(agents, 'one') });
    fs.mkdirSync(path.join(agents, 'two', '.instar'), { recursive: true });
    fs.writeFileSync(path.join(agents, 'two', '.instar', 'config.json'), '{}');
    const many = resolveAgentDir(undefined, home, home);
    expect('error' in many && many.error).toContain('More than one agent');
    expect(resolveAgentDir(path.join(agents, 'two'), home, home)).toEqual({ dir: path.join(agents, 'two') });
  });

  it('reports startedBy as telemetry from the environment', () => {
    expect(detectStartedBy({}, true)).toBe('terminal');
    expect(detectStartedBy({ INSTAR_SESSION_ID: 'x' }, true)).toBe('session');
    expect(detectStartedBy({}, false)).toBe('session');
  });
});

describe('local access link — wiring and registration', () => {
  it('registers the key material and the dev-gated switch', () => {
    expect(KEY_MATERIAL_PATHS).toContain('local-access/');
    expect(KEY_MATERIAL_FILES).toContain('local-access/listener.key');
    expect(KEY_MATERIAL_DYNAMIC_DIRS).toContain('local-access/launch/');
    expect(DEV_GATED_FEATURES.some((f) => f.configPath === 'security.localAccessLink.enabled')).toBe(true);
  });

  it('every dashboard PIN unlock goes through the local-access helper (ratchet)', () => {
    const root = path.resolve(__dirname, '../../dashboard');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(js|mjs|html)$/.test(e.name) || e.name === 'local-access.js') continue;
        const text = fs.readFileSync(p, 'utf-8');
        // Every direct post must be the load-failure fallback on the same line as the helper import.
        for (const line of text.split('\n')) {
          if (/fetch\(\s*['"`]\/dashboard\/unlock['"`]/.test(line) && !line.includes("import('/dashboard/local-access.js')")) offenders.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('the unlock route consults the local link before its budgets', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/server/AgentServer.ts'), 'utf-8');
    const unlock = src.indexOf("this.app.post('/dashboard/unlock'");
    const verify = src.indexOf('verifyUnlockLocalAccess(req)', unlock);
    const localBudget = src.indexOf('localPinBlocked(now)', unlock);
    expect(unlock).toBeGreaterThan(0);
    expect(verify).toBeGreaterThan(unlock);
    expect(verify).toBeLessThan(localBudget);
  });
});
