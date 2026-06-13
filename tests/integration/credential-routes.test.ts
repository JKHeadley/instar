/**
 * Tier-2 integration — full HTTP pipeline for the WS5.2 Step 7 /credentials/* levers. Boots a real
 * Express app with createRoutes() + the real authMiddleware, a real CredentialLocationLedger, a
 * real CredentialSwapExecutor (in-memory keychain + injected oracle resolver), the real
 * CredentialAuditEmit chokepoint, and real CredentialManualLevers. Hermetic — zero network, zero
 * real keychain, zero credentials persisted.
 *
 * Proves: dark=503 on every lever; live=execute behind a test-enabled flag; Bearer-401; rebalancer
 * 503; the §2.9 scrub chokepoint (no token in a response body); restore-enrollment one-directional
 * park of an incoherent blob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { CredentialLocationLedger, type IdentityOracle } from '../../src/core/CredentialLocationLedger.js';
import {
  CredentialSwapExecutor,
  type KeychainCredentialExec,
  type ResolveSlotIdentity,
} from '../../src/core/CredentialSwapExecutor.js';
import { CredentialAuditEmit } from '../../src/core/CredentialAuditEmit.js';
import { CredentialManualLevers } from '../../src/core/CredentialManualLevers.js';
import { CredentialEnvTokenGate, type EnvTokenFleetSession } from '../../src/core/CredentialEnvTokenGate.js';
import { claudeCredentialService } from '../../src/core/OAuthRefresher.js';
import { CredentialWriteFunnel } from '../../src/core/CredentialWriteFunnel.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-cred-routes';
const SLOT_A = '/h/.claude';
const SLOT_B = '/h/.claude-2';
const ACC_A = 'acc-A';
const ACC_B = 'acc-B';
const REAL_TOKEN = 'sk-ant-oat01-LeAkMe1234567890_AbCdEfGhIjKlMnOpQrStUv-987654321';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

/** In-memory keychain whose blobs carry a real-looking token (the leak vector). */
function memKeychain(): KeychainCredentialExec & { map: Map<string, string> } {
  const map = new Map<string, string>();
  map.set(claudeCredentialService(SLOT_A), JSON.stringify({ claudeAiOauth: { accessToken: `${REAL_TOKEN}-A`, refreshToken: `${REAL_TOKEN}-rA` } }));
  map.set(claudeCredentialService(SLOT_B), JSON.stringify({ claudeAiOauth: { accessToken: `${REAL_TOKEN}-B`, refreshToken: `${REAL_TOKEN}-rB` } }));
  return {
    map,
    async readService(s) { return map.get(s) ?? null; },
    async writeService(s, v) { map.set(s, v); },
    async deleteService(s) { map.delete(s); },
  };
}

const noopOracle: IdentityOracle = { async resolveSlotTenant() { return { unavailable: true }; } };

function buildLedger(stateDir: string): CredentialLocationLedger {
  const led = new CredentialLocationLedger({ stateDir, pool: { list: () => [] }, oracle: noopOracle });
  led.recordAssignment(SLOT_A, ACC_A, { op: 'seed' });
  led.recordAssignment(SLOT_B, ACC_B, { op: 'seed' });
  return led;
}

/** Identity resolver mapping the in-memory blob's token → its account (commit-side ALLOW). */
const resolveAllow: ResolveSlotIdentity = async (slot) => ({ accountId: slot === SLOT_A ? ACC_B : ACC_A });

function makeApp(opts: {
  enabled: boolean;
  manualLeversEnabled?: boolean;
  anthropicApiKey?: string;
  fleet?: EnvTokenFleetSession[];
}): { app: express.Express; stateDir: string; auditLines: string[] } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-routes-'));
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  const ledger = buildLedger(stateDir);
  const km = memKeychain();
  const auditLines: string[] = [];
  const audit = new CredentialAuditEmit({ writeLine: (l) => auditLines.push(l) });
  const swapExecutor = new CredentialSwapExecutor({
    funnel: new CredentialWriteFunnel(),
    ledger,
    keychain: km,
    resolveIdentity: resolveAllow,
    config: { enabled: opts.enabled, dryRun: true }, // dry-run so the route exercises the live path without real writes
    reverifyDelayMs: 5,
  });
  const credentialRepointing = {
    ledger,
    swapExecutor,
    resolveIdentity: resolveAllow,
    audit,
    levers: new CredentialManualLevers(),
    envTokenGate: new CredentialEnvTokenGate({
      getAnthropicApiKey: () => opts.anthropicApiKey ?? '',
      listSessions: () => opts.fleet ?? [],
    }),
    readBlob: async (slot: string) => {
      const raw = km.map.get(claudeCredentialService(slot)) ?? null;
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return { raw, oauth: (parsed.claudeAiOauth ?? null) as never };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH));
  const ctx = {
    config: { authToken: AUTH, stateDir, port: 0, subscriptionPool: { credentialRepointing: { enabled: opts.enabled, manualLeversEnabled: opts.manualLeversEnabled ?? true } } },
    startTime: new Date(),
    credentialRepointing,
  } as never;
  app.use(createRoutes(ctx));
  return { app, stateDir, auditLines };
}

describe('/credentials/* routes (integration)', () => {
  let server: TestServer;
  let stateDir: string;
  const cleanup: string[] = [];
  afterEach(async () => {
    await server?.close();
    for (const d of cleanup.splice(0)) { try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/credential-routes.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ } }
  });
  const api = (p: string, init?: RequestInit) =>
    fetch(server.url + p, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH}` }, ...init })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  it('DARK: every POST lever 503s; rebalancer 503', async () => {
    const built = makeApp({ enabled: false }); stateDir = built.stateDir; cleanup.push(stateDir);
    server = await listen(built.app);
    expect((await api('/credentials/swap', { method: 'POST', body: JSON.stringify({ slotA: SLOT_A, slotB: SLOT_B }) })).status).toBe(503);
    expect((await api('/credentials/set-default', { method: 'POST', body: JSON.stringify({ accountId: ACC_A }) })).status).toBe(503);
    expect((await api('/credentials/restore-enrollment', { method: 'POST', body: '{}' })).status).toBe(503);
    expect((await api('/credentials/rebalancer')).status).toBe(503);
    // GET /credentials/locations still answers (read surface), reporting the dark mode.
    const loc = await api('/credentials/locations');
    expect(loc.status).toBe(200);
    expect(loc.body.enabled).toBe(false);
  });

  it('Step 8 §2.10: rebalancer surfaces the env-token gate refusal (config field set), scrubbed', async () => {
    const built = makeApp({ enabled: true, anthropicApiKey: 'sk-ant-oat01-LeAkMe1234567890_secret' });
    stateDir = built.stateDir; cleanup.push(stateDir);
    server = await listen(built.app);
    const r = await api('/credentials/rebalancer');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.envTokenGate.refused).toBe(true);
    expect(r.body.envTokenGate.reason).toBe('config-anthropic-api-key-set');
    // The reason is a CATEGORY, not a credential — and the response routes through the scrub
    // chokepoint regardless, so no token byte leaks even though the config key carries one.
    expect(JSON.stringify(r.body)).not.toContain('LeAkMe1234567890');
  });

  it('Step 8 §2.10: rebalancer surfaces the live-fleet refusal (mid-life flip), config empty', async () => {
    const built = makeApp({
      enabled: true,
      anthropicApiKey: '',
      fleet: [
        { framework: 'claude-code', status: 'running', credentialSource: 'store' },
        { framework: 'claude-code', status: 'running', credentialSource: 'env' },
      ],
    });
    stateDir = built.stateDir; cleanup.push(stateDir);
    server = await listen(built.app);
    const r = await api('/credentials/rebalancer');
    expect(r.status).toBe(200);
    expect(r.body.envTokenGate.refused).toBe(true);
    expect(r.body.envTokenGate.reason).toBe('env-token-session-in-fleet');
    expect(r.body.envTokenGate.envSessionCount).toBe(1);
  });

  it('Step 8 §2.10: rebalancer PERMITS (refused:false) when config empty + all-store fleet', async () => {
    const built = makeApp({
      enabled: true,
      anthropicApiKey: '',
      fleet: [{ framework: 'claude-code', status: 'running', credentialSource: 'store' }],
    });
    stateDir = built.stateDir; cleanup.push(stateDir);
    server = await listen(built.app);
    const r = await api('/credentials/rebalancer');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.balancerWired).toBe(false);
    expect(r.body.envTokenGate.refused).toBe(false);
  });

  it('LIVE (flag on): POST /credentials/swap executes the executor; response carries NO token', async () => {
    const built = makeApp({ enabled: true }); stateDir = built.stateDir; cleanup.push(stateDir);
    server = await listen(built.app);
    const r = await api('/credentials/swap', { method: 'POST', body: JSON.stringify({ slotA: SLOT_A, slotB: SLOT_B }) });
    expect(r.status).toBe(200);
    // dry-run executor → outcome 'dry-run' (live decision loop ran, zero writes).
    expect(r.body.outcome).toBe('dry-run');
    // §2.9 chokepoint: no token byte in the response body, even though the blobs carry one.
    expect(JSON.stringify(r.body)).not.toContain('LeAkMe1234567890');
    // The audit jsonl also carries no token.
    expect(built.auditLines.join('')).not.toContain('LeAkMe1234567890');
  });

  it('param-validate: unknown slot → 400 (never reaches a keychain write)', async () => {
    const built = makeApp({ enabled: true }); stateDir = built.stateDir; cleanup.push(stateDir);
    server = await listen(built.app);
    const r = await api('/credentials/swap', { method: 'POST', body: JSON.stringify({ slotA: '/etc/passwd', slotB: SLOT_B }) });
    expect(r.status).toBe(400);
  });

  it('manualLeversEnabled:false → levers refuse 403', async () => {
    const built = makeApp({ enabled: true, manualLeversEnabled: false }); stateDir = built.stateDir; cleanup.push(stateDir);
    server = await listen(built.app);
    expect((await api('/credentials/swap', { method: 'POST', body: JSON.stringify({ slotA: SLOT_A, slotB: SLOT_B }) })).status).toBe(403);
  });

  it('restore-enrollment parks an incoherent slot one-directionally (never exchanged)', async () => {
    const built = makeApp({ enabled: true }); stateDir = built.stateDir; cleanup.push(stateDir);
    server = await listen(built.app);
    // The oracle resolver (resolveAllow) returns ACC_B for SLOT_A but the ledger lineage is ACC_A
    // → identity-incoherent → parked. (SLOT_B: ACC_A vs lineage ACC_B → also parked.)
    const r = await api('/credentials/restore-enrollment', { method: 'POST', body: '{}' });
    expect(r.status).toBe(200);
    expect(r.body.parked.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toContain('LeAkMe1234567890');
  });

  it('Bearer-401: every lever refuses without the token', async () => {
    const built = makeApp({ enabled: true }); stateDir = built.stateDir; cleanup.push(stateDir);
    server = await listen(built.app);
    const noauth = (p: string, init?: RequestInit) =>
      fetch(server.url + p, { headers: { 'Content-Type': 'application/json' }, ...init }).then((r) => r.status);
    expect(await noauth('/credentials/swap', { method: 'POST', body: JSON.stringify({ slotA: SLOT_A, slotB: SLOT_B }) })).toBe(401);
    expect(await noauth('/credentials/set-default', { method: 'POST', body: JSON.stringify({ accountId: ACC_A }) })).toBe(401);
    expect(await noauth('/credentials/restore-enrollment', { method: 'POST', body: '{}' })).toBe(401);
    expect(await noauth('/credentials/locations')).toBe(401);
  });

  // ── B4 — the §5 livetest battery entrypoint (the dry-run→live promotion gate) ──
  it('B4 livetest: DARK → POST /credentials/livetest 503 (no-op)', async () => {
    const built = makeApp({ enabled: false }); stateDir = built.stateDir; cleanup.push(stateDir);
    server = await listen(built.app);
    expect((await api('/credentials/livetest', { method: 'POST', body: '{}' })).status).toBe(503);
  });

  it('B4 livetest: ENABLED + NOT armed → refused report, ZERO swaps', async () => {
    const built = makeApp({ enabled: true }); stateDir = built.stateDir; cleanup.push(stateDir);
    server = await listen(built.app);
    const r = await api('/credentials/livetest', {
      method: 'POST',
      body: JSON.stringify({ enrolledPair: { slotA: SLOT_A, slotB: SLOT_B }, defaultSlotPair: { defaultSlot: SLOT_A, enrolledSlot: SLOT_B } }),
    });
    expect(r.status).toBe(200);
    expect(r.body.armed).toBe(false);
    expect(r.body.refusedReason).toMatch(/PROMOTION gate/);
    expect(r.body.steps).toEqual([]);
    expect(Array.isArray(r.body.manualSteps)).toBe(true);
    expect(r.body.manualSteps.length).toBeGreaterThan(0);
  });

  it('B4 livetest: ENABLED + armed → runs the battery (armed report, steps present)', async () => {
    const built = makeApp({ enabled: true }); stateDir = built.stateDir; cleanup.push(stateDir);
    server = await listen(built.app);
    const r = await api('/credentials/livetest', {
      method: 'POST',
      body: JSON.stringify({ armed: true, enrolledPair: { slotA: SLOT_A, slotB: SLOT_B }, defaultSlotPair: { defaultSlot: SLOT_A, enrolledSlot: SLOT_B } }),
    });
    expect(r.status).toBe(200);
    expect(r.body.armed).toBe(true);
    expect(Array.isArray(r.body.steps)).toBe(true);
    expect(r.body.steps.length).toBe(2); // (a) enrolled + (b) default round-trips
    expect(r.body.promotable).toBe(false); // manual items remain outstanding
  });

  it('B4 livetest: unknown slot → 400 (no harness run)', async () => {
    const built = makeApp({ enabled: true }); stateDir = built.stateDir; cleanup.push(stateDir);
    server = await listen(built.app);
    const r = await api('/credentials/livetest', {
      method: 'POST',
      body: JSON.stringify({ enrolledPair: { slotA: '~/.does-not-exist', slotB: SLOT_B }, defaultSlotPair: { defaultSlot: SLOT_A, enrolledSlot: SLOT_B } }),
    });
    expect(r.status).toBe(400);
  });
});
