/**
 * Wiring-integrity tests for WS5.2 Account Follow-Me PR1 — proves the security primitives +
 * the subscription-account-meta kind are actually WIRED, not just present as isolated modules.
 * A feature whose registration/config/awareness is silently dropped passes its unit tests but
 * FAILS here. Mirrors the ws25-evolution-actions-wiring pattern.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import {
  SUBSCRIPTION_ACCOUNT_META_KIND_REGISTRATION,
  SUBSCRIPTION_ACCOUNT_META_KIND,
  SUBSCRIPTION_ACCOUNT_META_STORE_KEY,
} from '../../src/core/SubscriptionAccountMetaReplicatedStore.js';
import { JOURNAL_KINDS, DEFAULT_RETENTION } from '../../src/core/CoherenceJournal.js';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('WS5.2 dual-registry coupling', () => {
  it('subscription-account-meta is in JOURNAL_KINDS (the static half)', () => {
    expect(JOURNAL_KINDS).toContain(SUBSCRIPTION_ACCOUNT_META_KIND);
  });
  it('has a DEFAULT_RETENTION entry that is NEVER rotateKeep:0 (compliance parity)', () => {
    const r = DEFAULT_RETENTION[SUBSCRIPTION_ACCOUNT_META_KIND as keyof typeof DEFAULT_RETENTION];
    expect(r).toBeTruthy();
    expect(r.rotateKeep).toBeGreaterThan(0);
  });
  it('the registry accepts the registration + resolves it by kind AND store', () => {
    const registry = new ReplicatedKindRegistry();
    registry.register(SUBSCRIPTION_ACCOUNT_META_KIND_REGISTRATION);
    expect(registry.isReplicatedKind(SUBSCRIPTION_ACCOUNT_META_KIND)).toBe(true);
    expect(registry.getByStore(SUBSCRIPTION_ACCOUNT_META_STORE_KEY)?.kind).toBe(SUBSCRIPTION_ACCOUNT_META_KIND);
  });
});

describe('WS5.2 server.ts wiring (source touchpoints)', () => {
  const serverSrc = read('src/commands/server.ts');
  it('registers SUBSCRIPTION_ACCOUNT_META_KIND_REGISTRATION onto the shared registry', () => {
    expect(serverSrc).toContain('replicatedKindRegistry.register(SUBSCRIPTION_ACCOUNT_META_KIND_REGISTRATION)');
  });
  it('injects the accountFollowMe-gated store entry so the emitter gate resolves on accountFollowMe', () => {
    expect(serverSrc).toContain('_accountFollowMeEnabled');
    expect(serverSrc).toContain("subscriptionAccountMeta: { enabled: true }");
  });
  it('wires the SubscriptionPool meta-replication emit adapter, gated on the emitter + accountFollowMe', () => {
    expect(serverSrc).toContain('subscriptionPool.setMetaReplicationEmitter');
    expect(serverSrc).toContain('buildSubscriptionAccountMetaData');
    expect(serverSrc).toContain('buildSubscriptionAccountMetaTombstoneData');
  });
});

describe('WS5.2 SubscriptionPool emit seam (source touchpoints)', () => {
  const poolSrc = read('src/core/SubscriptionPool.ts');
  it('exposes setMetaReplicationEmitter + fires put on add/update + delete on remove', () => {
    expect(poolSrc).toContain('setMetaReplicationEmitter');
    expect(poolSrc).toContain('this.metaReplication?.emitPut');
    expect(poolSrc).toContain('this.metaReplication?.emitDelete');
  });
  it('R0: the header no longer claims credential-blob is the default', () => {
    expect(poolSrc).toContain('DEFAULT is RE-MINT PER MACHINE');
    expect(poolSrc).not.toMatch(/a future\s*\n?\s*\* cross-machine sync \(decision 1B\) is a clean bolt-on that ships each account/);
  });
});

describe('WS5.2 ConfigDefaults + dev-gate', () => {
  it('ConfigDefaults ships the accountFollowMe block (OMITS enabled — dev-gated)', () => {
    const defaultsSrc = read('src/config/ConfigDefaults.ts');
    expect(defaultsSrc).toMatch(/accountFollowMe:\s*\{/);
    expect(defaultsSrc).toContain('credentialTransport: {}');
    expect(defaultsSrc).toContain('maxFollowMachines: 5');
    // WS5.2 R6b — the remote/cloud scrape-timeout budget knob (3min default).
    expect(defaultsSrc).toContain('remoteScrapeTimeoutMs: 180000');
    // The enabled literal must NOT be hardcoded under accountFollowMe (dev-gate decides).
    expect(defaultsSrc).not.toMatch(/accountFollowMe:\s*\{[^}]*enabled:\s*false/s);
  });
  it('the dev-gate classifies accountFollowMe (live-on-dev, dark-on-fleet)', () => {
    const devGated = read('src/core/devGatedFeatures.ts');
    expect(devGated).toContain("configPath: 'multiMachine.accountFollowMe.enabled'");
  });
});

describe('WS5.2 awareness (Agent Awareness + Migration Parity standards)', () => {
  it('the CLAUDE.md template names the WS5.2 capability', () => {
    expect(read('src/scaffold/templates.ts')).toContain('Cross-Machine Account Follow-Me (WS5.2');
  });
  it('the PostUpdateMigrator splices it into already-deployed agents', () => {
    expect(read('src/core/PostUpdateMigrator.ts')).toContain('Cross-Machine Account Follow-Me (WS5.2');
  });
});
