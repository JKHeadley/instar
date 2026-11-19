/**
 * docs/specs/guard-runtime-state-scope.md: the read-only route (`GET /source-tree-guard/scope`
 * and `?scope=pool`), and the callers whose silent catches now record a degradation (the
 * canary's cleanup without truncation, the node_modules clone staging delete).
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSourceTreeGuardScopeRoutes, GUARD_SCOPE_SCHEMA } from '../../src/server/sourceTreeGuardScopeRoutes.js';
import { configureGuardRuntimeScope, _resetGuardRuntimeScopeForTesting } from '../../src/core/guardRuntimeScope.js';
import { appendDisposition, recordDiff, _resetLedgerMemoryForTesting } from '../../src/core/guardScopeLedger.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { prepareCanaryFixture } from '../../src/feedback-factory/execute/confinementCanary.js';
import { _cloneNodeModulesForTesting } from '../../src/core/InstarWorktreeManager.js';
import { makeGuardFixture, type GuardFixture } from '../fixtures/guardScopeFixture.js';
import type { ConfinementPaths } from '../../src/feedback-factory/execute/executePolicy.js';

let fx: GuardFixture;
const prevLedger = process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR;
const servers: http.Server[] = [];

beforeEach(() => {
  fx = makeGuardFixture();
  process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR = fx.ledgerDir;
  _resetGuardRuntimeScopeForTesting();
  _resetLedgerMemoryForTesting();
  DegradationReporter.resetForTesting();
});
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  _resetGuardRuntimeScopeForTesting();
  DegradationReporter.resetForTesting();
  process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR = prevLedger;
  fx.cleanup();
});

async function serve(app: express.Express): Promise<string> {
  const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function appWith(ctx: Parameters<typeof createSourceTreeGuardScopeRoutes>[0]): express.Express {
  const app = express();
  app.use(createSourceTreeGuardScopeRoutes(ctx, { peerTimeoutMs: 500, fanOutDeadlineMs: 2_000 }));
  return app;
}

const baseCtx = (over: Record<string, unknown> = {}) => ({
  config: { authToken: 't', multiMachine: {} } as never,
  meshSelfId: 'm_self',
  machinePoolRegistry: null,
  resolvePeerUrls: null,
  recordRopeResult: undefined,
  ...over,
}) as Parameters<typeof createSourceTreeGuardScopeRoutes>[0];

describe('GET /source-tree-guard/scope', () => {
  it('returns the mode and the per-class counts, and lists undisposed rows', async () => {
    recordDiff({ direction: 'would-deny', verb: 'unlink', recursive: false, reason: 'inside-source', caller: 'c', operation: 'a', samplePath: '/s/a.ts', targetClass: 'source-file' }, new Date(), fx.ledgerDir);
    recordDiff({ direction: 'would-allow', verb: 'unlink', recursive: false, reason: 'ordinary', caller: 'c', operation: 'b', samplePath: '/o/link', targetClass: 'other' }, new Date(), fx.ledgerDir);
    const url = await serve(appWith(baseCtx({ ledgerDir: () => fx.ledgerDir })));
    const body = await (await fetch(`${url}/source-tree-guard/scope`)).json() as Record<string, any>;
    expect(body).toMatchObject({ schema: GUARD_SCOPE_SCHEMA, scope: 'local', mode: 'report', effectiveMode: 'report', incomplete: false });
    expect(body.counts).toMatchObject({ wouldDeny: 1, wouldAllow: 1, distinct: 2, undisposed: 2, byClass: { 'source-file': 1, 'checkout-root': 0, other: 1 } });
    appendDisposition(body.undisposed[0].fingerprint, 'correct-refusal', 'ok', 't', fx.ledgerDir);
    const again = await (await fetch(`${url}/source-tree-guard/scope`)).json() as Record<string, any>;
    expect(again.counts.undisposed).toBe(1);
    configureGuardRuntimeScope({ mode: 'enforce' });
    const enforced = await (await fetch(`${url}/source-tree-guard/scope`)).json() as Record<string, any>;
    expect(enforced).toMatchObject({ mode: 'enforce', effectiveMode: 'enforce' });
  });

  it('?scope=pool lists every machine and names an unreachable one', async () => {
    const peerLedger = path.join(fx.base, 'peer-ledger');
    recordDiff({ direction: 'would-deny', verb: 'rm', recursive: true, reason: 'inside-source', caller: 'c', operation: 'peer', samplePath: '/p', targetClass: 'other' }, new Date(), peerLedger);
    const peerUrl = await serve(appWith(baseCtx({ meshSelfId: 'm_peer', ledgerDir: () => peerLedger })));
    const url = await serve(appWith(baseCtx({
      ledgerDir: () => fx.ledgerDir,
      resolvePeerUrls: () => [{ machineId: 'm_peer', url: peerUrl }, { machineId: 'm_dead', url: 'http://127.0.0.1:1' }],
    })));
    const body = await (await fetch(`${url}/source-tree-guard/scope?scope=pool`)).json() as Record<string, any>;
    expect(body.scope).toBe('pool');
    expect(body.machines.map((m: { machineId: string }) => m.machineId).sort()).toEqual(['m_peer', 'm_self']);
    const peer = body.machines.find((m: { machineId: string }) => m.machineId === 'm_peer');
    expect(peer.state.counts.wouldDeny).toBe(1);
    expect(body.couldNotRead).toEqual([expect.objectContaining({ machineId: 'm_dead' })]);
  });
});

describe('silent catches record a degradation', () => {
  it('a refused staging delete records a guard-refused degradation and leaves the folder', () => {
    configureGuardRuntimeScope({ mode: 'enforce' });
    // A worktree root that is NOT a listed worktree: the scope refuses the staging delete.
    const notListed = path.join(fx.home, 'not-listed');
    const source = path.join(fx.outside, 'nm');
    fs.mkdirSync(path.join(source, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(source, 'pkg', 'ok.js'), '1');
    fs.writeFileSync(path.join(source, 'pkg', 'locked.js'), '2');
    fs.chmodSync(path.join(source, 'pkg', 'locked.js'), 0o000); // cp fails part-way, leaving the staging folder
    fs.mkdirSync(notListed);
    const ok = _cloneNodeModulesForTesting(source, path.join(notListed, 'node_modules'));
    expect(ok).toBe(false);
    const leftovers = fs.readdirSync(notListed).filter((n) => n.startsWith('node_modules.clone-'));
    expect(leftovers).toHaveLength(1);
    const events = DegradationReporter.getInstance().getEvents();
    expect(events.some((e) => e.feature === 'SafeFsExecutor.guard-refused' && e.primary.includes('node_modules.clone-'))).toBe(true);
  });
});

describe('the canary cleanup: unlink only, never truncate', () => {
  function canaryPaths(): ConfinementPaths {
    const workspace = path.join(fx.home, '.worktrees', 'feedback-fb-1-abcd1234-a1');
    fs.mkdirSync(workspace, { recursive: true });
    return {
      workspace, tmpDir: path.join(fx.outside, 'tmp'), depsCache: path.join(fx.outside, 'deps'), agentHome: fx.home,
      publishClone: path.join(fx.outside, 'pub'), testRunnerHoldersFile: path.join(fx.outside, 'holders'), homeDir: path.join(fx.outside, 'userhome'),
    };
  }

  it('a refused unlink leaves the file and its hard-linked twin untouched and records a degradation; ENOENT records nothing; the system-temp probe is unlinked', async () => {
    configureGuardRuntimeScope({ mode: 'enforce' });
    const paths = canaryPaths();
    fs.mkdirSync(paths.homeDir!, { recursive: true });
    // secretsDir inside the checkout's source area (not .instar/): its unlink is refused in enforce.
    const secretsDir = path.join(fx.home, 'secrets-in-source');
    const fixture = await prepareCanaryFixture(paths, { secretsDir, configPath: path.join(fx.outside, 'config.json') });
    const twin = path.join(fx.outside, 'twin');
    fs.linkSync(fixture.noncePath, twin);
    // The system-temp write probe exists with a hard-linked twin: it must be unlinked, not truncated.
    const tmpProbe = fixture.systemTmpWritePath;
    fs.writeFileSync(tmpProbe, 'probe-bytes');
    const tmpTwin = path.join(fx.outside, 'tmp-twin');
    fs.linkSync(tmpProbe, tmpTwin);
    await fixture.close();
    expect(fs.readFileSync(fixture.noncePath, 'utf8')).toBe(`canary-secret-${fixture.nonce}`);
    expect(fs.readFileSync(twin, 'utf8')).toBe(`canary-secret-${fixture.nonce}`);
    expect(fs.existsSync(tmpProbe)).toBe(false);
    expect(fs.readFileSync(tmpTwin, 'utf8')).toBe('probe-bytes');
    // The sibling files were in scope and removed; w.txt never existed (ENOENT: clean, nothing recorded).
    expect(fs.existsSync(fixture.siblingDir)).toBe(false);
    const events = DegradationReporter.getInstance().getEvents();
    expect(events.some((e) => e.feature === 'SafeFsExecutor.guard-refused' && e.primary.includes(fixture.noncePath))).toBe(true);
    expect(events.some((e) => e.primary.includes('w.txt'))).toBe(false);
  });
});
