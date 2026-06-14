// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
// safe-git-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Wiring-integrity tests for WS2.1 (cross-machine preferences pool,
 * MULTI-MACHINE-SEAMLESSNESS-SPEC §WS2.1). Two layers:
 *
 *  1. SOURCE assertions — the serve handler is registered in server.ts, the
 *     PeerPresencePuller pulls preferences-sync, the advert is passed through the
 *     fetch-capacity narrowing, and the flag default exists. A feature whose
 *     wiring is silently dropped (the #930 advert-narrowing class of bug) would
 *     pass an engine unit test but fail HERE.
 *  2. FUNCTIONAL flag-gate — the live `/preferences/session-context` route over
 *     real createRoutes: flag OFF → own-only block byte-identical to before;
 *     flag ON + replicas → the MERGED (scope:'mesh') block. This is the
 *     "both sides of the decision boundary" semantic test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createRoutes } from '../../src/server/routes.js';
import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import { PreferenceReplicaStore, type PreferencesSyncPage } from '../../src/core/PreferencesSync.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Layer 1: source wiring ──────────────────────────────────────────

describe('WS2.1 preferences-pool wiring (source touchpoints)', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'server.ts'), 'utf-8');
  const pullerSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'PeerPresencePuller.ts'), 'utf-8');
  const routesSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server', 'routes.ts'), 'utf-8');
  const meshSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'MeshRpc.ts'), 'utf-8');
  const defaultsSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'config', 'ConfigDefaults.ts'), 'utf-8');

  it('registers the `preferences-sync` serve handler in server.ts calling buildPreferencesSyncPage', () => {
    expect(serverSrc).toContain("'preferences-sync': async (cmd)");
    expect(serverSrc).toContain('buildPreferencesSyncPage');
    expect(serverSrc).toContain('getAllForSync()');
    expect(serverSrc).toContain('getReplicationAdvert()');
  });

  it('constructs the PreferenceReplicaStore + own manager under the ws21 flag gate', () => {
    expect(serverSrc).toContain('new psMod.PreferenceReplicaStore');
    expect(serverSrc).toContain('ws21PrefsPoolEnabled');
    expect(serverSrc).toContain('ws21PreferencesPool');
  });

  it('PeerPresencePuller drives preferences-sync from the peer advert', () => {
    expect(pullerSrc).toContain('drivePreferencesSync');
    expect(pullerSrc).toContain('preferencesAdvert');
    // The drive is gated on the dep being present (no-op while dark).
    expect(pullerSrc).toContain('cap.preferencesAdvert && this.d.drivePreferencesSync');
  });

  it('server.ts wires the drivePreferencesSync dep + passes the advert through fetch-capacity', () => {
    expect(serverSrc).toContain('drivePreferencesSync: async (machineId, url, advert)');
    expect(serverSrc).toContain("{ type: 'preferences-sync', request: { sinceSeq: since");
    // The #930/A2 narrowing lesson — the advert must survive the fetch return.
    expect(serverSrc).toContain('cap.preferencesAdvert ? { preferencesAdvert: cap.preferencesAdvert }');
    // And the session-status advert must be emitted.
    expect(serverSrc).toContain('preferencesAdvert ? { preferencesAdvert }');
  });

  it('routes.ts unions replicas into /preferences/session-context only when the flag is on', () => {
    expect(routesSrc).toContain('ws21PreferencesPool');
    expect(routesSrc).toContain('mergePreferenceViews');
    expect(routesSrc).toContain('preferenceReplicaStore?.allReplicas()');
  });

  it('the preferences-sync verb is in MeshRpc and the read/observe RBAC class', () => {
    expect(meshSrc).toContain("type: 'preferences-sync'");
    expect(meshSrc).toContain("case 'preferences-sync':");
  });

  it('ConfigDefaults ships the ws21PreferencesPool dark default beside the seamlessness siblings', () => {
    expect(defaultsSrc).toContain('ws21PreferencesPool: false');
  });
});

// ── Layer 2: functional flag-gate on the live route ─────────────────

describe('WS2.1 /preferences/session-context flag gate (own-only vs merged)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws21-route-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/ws21-preferences-pool-wiring.test.ts' });
  });

  // A served page A would emit for a single learned preference on m_peer.
  function peerPage(): PreferencesSyncPage {
    return {
      incarnation: 'inc-peer',
      replicationSeq: 2,
      records: [
        {
          learning: 'On the OTHER machine: lead with the action.',
          provenance: 'correction-loop',
          dedupeKey: 'tone:lead',
          recordedAt: new Date().toISOString(),
          confidence: 0.8,
          dedupeCount: 1,
          originMachineId: 'm_peer',
          lastMutatedSeq: 2,
        },
      ],
      nextSinceSeq: 2,
      done: true,
    };
  }

  async function startServer(opts: {
    ws21: boolean;
    withReplica: boolean;
  }): Promise<{ url: string; close: () => Promise<void> }> {
    // Seed an OWN preference so own-only always has content.
    const own = new PreferencesManager(dir);
    own.recordPreference({ learning: 'Own preference: be concise.', dedupeKey: 'tone:concise', confidence: 0.6 });

    let preferenceReplicaStore: PreferenceReplicaStore | undefined;
    if (opts.withReplica) {
      preferenceReplicaStore = new PreferenceReplicaStore({ stateDir: dir });
      preferenceReplicaStore.applyPage('m_peer', peerPage());
    }

    const config = {
      authToken: 'test',
      stateDir: dir,
      port: 0,
      monitoring: { correctionLearning: { enabled: true } },
      multiMachine: { seamlessness: { ws21PreferencesPool: opts.ws21 } },
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config, stateDir: dir, meshSelfId: 'm_self', preferenceReplicaStore } as any));
    return new Promise((resolve) => {
      const srv = app.listen(0, () =>
        resolve({
          url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
          close: () => new Promise<void>((r) => srv.close(() => r())),
        }),
      );
    });
  }

  it('flag OFF → own-only block (no scope:mesh, peer preference NOT injected) even when a replica is on disk', async () => {
    const server = await startServer({ ws21: false, withReplica: true });
    try {
      const res = await fetch(`${server.url}/preferences/session-context`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { present: boolean; block: string; count: number; scope?: string };
      expect(body.present).toBe(true);
      expect(body.scope).toBeUndefined(); // own-only path is untouched
      expect(body.block).toContain('be concise');
      expect(body.block).not.toContain('OTHER machine'); // replica NOT folded in
    } finally {
      await server.close();
    }
  });

  it('flag ON + replicas → merged (scope:mesh) block including the peer preference', async () => {
    const server = await startServer({ ws21: true, withReplica: true });
    try {
      const res = await fetch(`${server.url}/preferences/session-context`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { present: boolean; block: string; count: number; scope?: string };
      expect(body.present).toBe(true);
      expect(body.scope).toBe('mesh');
      expect(body.block).toContain('be concise'); // own
      expect(body.block).toContain('OTHER machine'); // replica folded in
      expect(body.count).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('flag ON but NO replicas → own-only path (byte-identical, no scope:mesh)', async () => {
    const server = await startServer({ ws21: true, withReplica: false });
    try {
      const res = await fetch(`${server.url}/preferences/session-context`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { present: boolean; block: string; scope?: string };
      expect(body.present).toBe(true);
      expect(body.scope).toBeUndefined();
      expect(body.block).toContain('be concise');
    } finally {
      await server.close();
    }
  });

  it('finding #3: the merge requires a REAL meshSelfId (no "local" fallback that breaks own-echo)', () => {
    const routesSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server', 'routes.ts'), 'utf-8');
    // The WS2.1 merge block must gate on a resolved selfId and pass it as
    // ownMachineId — never the 'local' sentinel (which would mismatch a peer's
    // named originMachineId and corrupt dedupeCount/contributingMachines).
    expect(routesSrc).toMatch(/const selfId = typeof ctx\.meshSelfId === 'string' && ctx\.meshSelfId\.length > 0/);
    expect(routesSrc).toMatch(/ws21Enabled && selfId && replicas\.length > 0/);
    expect(routesSrc).toMatch(/ownMachineId: selfId,/);
  });
});
