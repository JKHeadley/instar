// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * planned-restart-keeps-lead — the pure and file-shaped parts: window resolution at every
 * boundary, the signed continuity file, the restart budget, the episode end rule, the boot
 * measurement, the ledger lookup and the local store's pending marker.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import {
  resolveWindowMs, resolveMarginMs, pendingCadenceMs, clampSampleMs, evaluateEpisodeEnd, bootDurationMs,
  consumedAliveBoundMs, canonicalContinuityMeta, LeaseContinuityStore, EPISODE_CAP_MS, EPISODE_ABSENCE_MS,
  type ContinuityMeta,
} from '../../src/core/LeaseContinuity.js';
import { UNSIGNED_WINDOW_CEILING_MS, resolvePlannedRestartLeaseContinuity } from '../../src/core/BootClaimHold.js';
import { findRestartRequestRecord, recordRestartRequest, cleanString } from '../../src/core/restartRequestAttribution.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const KEYS = Object.fromEntries(['studio', 'mini'].map((id) => [id, crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})])) as Record<string, { publicKey: string; privateKey: string }>;
function crypt(self: string): LeaseCrypto {
  return {
    selfMachineId: self,
    sign: (c) => crypto.sign(null, Buffer.from(c), KEYS[self].privateKey).toString('base64'),
    verify: (c, sig, holder) => { const pub = KEYS[holder]?.publicKey; if (!pub) return false; try { return crypto.verify(null, Buffer.from(c), pub, Buffer.from(sig, 'base64')); } catch { return false; } },
  };
}
const TTL = 60_000;
const fl = (id: string) => new FencedLease(crypt(id), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'LeaseContinuity-test-cleanup' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-cont-')); dirs.push(d); return d; };

const echo = (over: Partial<Parameters<typeof resolveWindowMs>[0]> = {}) => resolveWindowMs({
  ttlMs: TTL, pendingRenewIntervalMs: 10_000, bootSamplesMs: [], failoverThresholdMs: 15 * 60_000,
  unsignedCeilingMs: UNSIGNED_WINDOW_CEILING_MS, ownNonRenewalMissedObservations: 6, ...over,
});

describe('window resolution (§ The window)', () => {
  it('margin on Echo is 53 s and the unmeasured base 233 s', () => {
    expect(resolveMarginMs({ pendingRenewIntervalMs: 10_000 })).toBe(53_000);
    const v = echo();
    expect(v.baseMs).toBe(3 * TTL + 53_000);
    expect(v.windowMs).toBe(233_000);
    expect(v.measured).toBe(false);
    expect(v.clamped).toBeNull();
  });
  it('the ceiling on Echo is the stale-holder cap, 352 s, and a slow measured boot is clamped to it', () => {
    const v = echo({ bootSamplesMs: [400_000] });
    expect(v.ceilingMs).toBe(TTL * 6 - 8_000);
    expect(v.ceilingSource).toBe('stale-holder');
    expect(v.windowMs).toBe(352_000);
    expect(v.clamped).toBe('ceiling');
  });
  it('a measured boot sets the base to slowest + margin', () => {
    const v = echo({ bootSamplesMs: [70_000, 150_000, 90_000] });
    expect(v.windowMs).toBe(150_000 + 53_000);
    expect(v.measured).toBe(true);
  });
  it('the floor is TTL + margin; a tiny measured boot or override cannot go under it', () => {
    expect(echo({ bootSamplesMs: [1_000] }).windowMs).toBe(TTL + 53_000);
    expect(echo({ windowMsOverride: 5_000 }).clamped).toBe('floor');
  });
  it('an explicit windowMs replaces the base and is still capped', () => {
    expect(echo({ windowMsOverride: 300_000 }).windowMs).toBe(300_000);
    expect(echo({ windowMsOverride: 900_000 }).windowMs).toBe(352_000);
  });
  it('a smaller own nonRenewalMissedObservations lowers the cap; a larger one does not raise it past the assumed 6', () => {
    expect(echo({ ownNonRenewalMissedObservations: 3 }).ceilingMs).toBe(TTL * 3 - 8_000);
    expect(echo({ ownNonRenewalMissedObservations: 20 }).ceilingMs).toBe(TTL * 6 - 8_000);
  });
  it('when the floor and the ceiling conflict the ceiling wins, because peers enforce it', () => {
    const v = echo({ ownNonRenewalMissedObservations: 1 }); // cap TTL − 8 s = 52 s, under the 113 s floor
    expect(v.ceilingMs).toBe(TTL - 8_000);
    expect(v.windowMs).toBe(TTL - 8_000);
    expect(v.clamped).toBe('ceiling');
  });
  it('a short failover threshold becomes the cap; R1 ceiling caps a long TTL pool', () => {
    expect(echo({ failoverThresholdMs: 120_000 }).ceilingSource).toBe('presumed-dead');
    const long = resolveWindowMs({ ttlMs: 300_000, pendingRenewIntervalMs: 10_000, bootSamplesMs: [], failoverThresholdMs: 60 * 60_000, unsignedCeilingMs: UNSIGNED_WINDOW_CEILING_MS, ownNonRenewalMissedObservations: 6 });
    expect(long.ceilingSource).toBe('r1-ceiling');
    expect(long.windowMs).toBe(UNSIGNED_WINDOW_CEILING_MS);
  });
  it('non-finite samples are discarded; a non-finite override falls back to the base', () => {
    expect(echo({ bootSamplesMs: [NaN, Infinity] }).measured).toBe(false);
    expect(echo({ windowMsOverride: NaN }).windowMs).toBe(233_000);
    expect(clampSampleMs(900_000, UNSIGNED_WINDOW_CEILING_MS)).toBe(UNSIGNED_WINDOW_CEILING_MS);
    expect(clampSampleMs(-5, UNSIGNED_WINDOW_CEILING_MS)).toBe(0);
  });
  it('the margin follows the store cadence: a git-only mesh keeps renewIntervalMs', () => {
    expect(pendingCadenceMs(30_000, true)).toBe(10_000);
    expect(pendingCadenceMs(30_000, false)).toBe(30_000);
    expect(resolveMarginMs({ pendingRenewIntervalMs: 30_000 })).toBe(73_000);
    expect(resolveWindowMs({ ttlMs: 120_000, pendingRenewIntervalMs: 10_000, bootSamplesMs: [], failoverThresholdMs: 15 * 60_000, unsignedCeilingMs: UNSIGNED_WINDOW_CEILING_MS }).marginMs).toBe(53_000);
  });
});

describe('the continuity switch', () => {
  it('rides the development-agent gate; takeoverReadyPool.enabled:false is the rollback', () => {
    expect(resolvePlannedRestartLeaseContinuity({ developmentAgent: true }).enabled).toBe(true);
    expect(resolvePlannedRestartLeaseContinuity({ developmentAgent: false }).enabled).toBe(false);
    expect(resolvePlannedRestartLeaseContinuity({ developmentAgent: true, multiMachine: { takeoverReadyPool: { enabled: false } } }).enabled).toBe(false);
    expect(resolvePlannedRestartLeaseContinuity({ developmentAgent: false, multiMachine: { takeoverReadyPool: { plannedRestartLeaseContinuity: { enabled: true, windowMs: 200_000 } } } })).toEqual({ enabled: true, windowMs: 200_000 });
  });
});

function storeFor(dir: string, self = 'studio', now = () => 1_000_000_000_000) {
  const f = fl(self);
  const c = crypt(self);
  return new LeaseContinuityStore({ stateDir: dir, selfMachineId: self, sign: (x) => f.signContinuityMeta(x), verify: (x, sig, h) => f.verifyContinuityMeta(x, sig, h), verifyLease: (l) => f.verifyLease(l), unsignedCeilingMs: UNSIGNED_WINDOW_CEILING_MS, now, ...(c ? {} : {}) });
}
const meta = (over: Partial<ContinuityMeta> = {}): ContinuityMeta => ({
  requestedBy: 'role-change', reason: 'this machine took the lease', requestedAt: '2026-11-21T09:38:35.370Z',
  episodeOpenedAt: new Date(1_000_000_000_000).toISOString(), renewedAt: new Date(1_000_000_000_000).toISOString(),
  windowMs: 233_000, confirmed: true, exitedAt: null, ...over,
});

describe('the continuity file (§1 step 4, §2 fold checks)', () => {
  it('writes, reads and verifies its own record; the meta signature is domain-tagged over the nonce', () => {
    const dir = tmp(); const st = storeFor(dir);
    const lease = fl('studio').signLease(41, new Date(1_000_000_000_000 - TTL).toISOString(), new Date(1_000_000_000_000 + 233_000).toISOString(), 7);
    st.write(st.sign({ v: 1, episodeId: st.newEpisodeId(), lease, meta: meta() }));
    const r = st.read();
    expect(r.verdict).toBe('ok');
    expect(r.file?.lease.nonce).toBe(7);
    expect(canonicalContinuityMeta(7, meta())).toMatch(/^\["lease-continuity-v1",7,/);
    expect(fs.statSync(st.filePath).mode & 0o777).toBe(0o600);
  });
  it('refuses a tampered meta, a tampered lease, another holder, a foreign key and an expired lease', () => {
    const dir = tmp(); const st = storeFor(dir);
    const lease = fl('studio').signLease(41, new Date(1_000_000_000_000 - TTL).toISOString(), new Date(1_000_000_000_000 + 233_000).toISOString(), 7);
    const good = st.sign({ v: 1, episodeId: 'e1', lease, meta: meta() });
    fs.mkdirSync(path.dirname(st.filePath), { recursive: true });
    fs.writeFileSync(st.filePath, JSON.stringify({ ...good, meta: { ...good.meta, reason: 'edited' } }));
    expect(st.read().verdict).toBe('meta-signature-invalid');
    fs.writeFileSync(st.filePath, JSON.stringify({ ...good, lease: { ...good.lease, expiresAt: new Date(1_000_000_000_000 + 9_999_000).toISOString() } }));
    expect(st.read().verdict).toBe('lease-signature-invalid');
    const miniLease = fl('mini').signLease(41, lease.acquiredAt, lease.expiresAt, 7);
    fs.writeFileSync(st.filePath, JSON.stringify({ ...good, lease: miniLease }));
    expect(st.read().verdict).toBe('wrong-holder');
    const foreign = storeFor(dir, 'mini');
    fs.writeFileSync(st.filePath, JSON.stringify(foreign.sign({ v: 1, episodeId: 'e1', lease, meta: meta() })));
    expect(st.read().verdict).toBe('meta-signature-invalid');
    const late = storeFor(dir, 'studio', () => 1_000_000_000_000 + 300_000);
    fs.writeFileSync(st.filePath, JSON.stringify(good));
    expect(late.read().verdict).toBe('expired');
    fs.writeFileSync(st.filePath, '{not json');
    expect(st.read().verdict).toBe('unreadable');
    st.delete();
    expect(st.read().verdict).toBe('missing');
  });
  it('stamps exitedAt only for the lease this process confirmed, re-signing the meta', () => {
    const dir = tmp(); const st = storeFor(dir, 'studio', () => 1_000_000_000_000 + 5_000);
    const lease = fl('studio').signLease(41, new Date(1_000_000_000_000 - TTL).toISOString(), new Date(1_000_000_000_000 + 233_000).toISOString(), 7);
    st.write(st.sign({ v: 1, episodeId: 'e1', lease, meta: meta() }));
    expect(st.stampExit(8)).toBe(false);
    expect(st.stampExit(7)).toBe(true);
    const r = st.read();
    expect(r.verdict).toBe('ok');
    expect(r.file?.meta.exitedAt).toBe(new Date(1_000_000_000_000 + 5_000).toISOString());
  });
});

describe('the restart budget (§2 step 7)', () => {
  it('keeps the last twenty, clamps on read, and returns slowest below twenty and p95 from twenty', () => {
    const dir = tmp(); const st = storeFor(dir);
    expect(st.restartBudgetMs()).toBeNull();
    expect(st.appendBootSample(70_000, 'planned', 'peer-confirmed').previousSlowestMs).toBeNull();
    expect(st.appendBootSample(150_000, 'planned', 'peer-confirmed').previousSlowestMs).toBe(70_000);
    expect(st.restartBudgetMs()).toBe(150_000);
    for (let i = 0; i < 25; i++) st.appendBootSample(80_000 + i * 1_000, 'planned', 'peer-confirmed');
    expect(st.readBudget()).toHaveLength(20);
    expect(st.restartBudgetMs()).toBe(80_000 + 23_000); // p95 of the twenty newest (85 000 … 104 000)
    fs.writeFileSync(st.budgetPath, JSON.stringify({ samples: [{ at: 'x', ms: 999_999_999, outcome: 'planned' }, { at: 'y', ms: 'bad', outcome: 'planned' }, { at: 'z', ms: NaN }] }));
    expect(st.bootSamplesMs()).toEqual([UNSIGNED_WINDOW_CEILING_MS]);
    st.appendBootSample(-5, 'planned', 'peer-confirmed');
    expect(st.readBudget()).toHaveLength(1);
  });
});

describe('the episode end rule (§1 step 3)', () => {
  const base = { nowMs: 100_000, openedAtMs: 0, fileLastSeenMs: 50_000, filePresent: true, consumptionAtMs: null, ledgerCoverage: 'full' as const, withdrawn: false };
  it('stays open while the file is present', () => expect(evaluateEpisodeEnd(base)).toEqual({ ended: false }));
  it('ends on withdrawal at once', () => expect(evaluateEpisodeEnd({ ...base, withdrawn: true })).toEqual({ ended: true, cause: 'withdrawn' }));
  it('a consumer deletion with a ledger row keeps it open; alive past the bound ends it', () => {
    expect(evaluateEpisodeEnd({ ...base, filePresent: false, consumptionAtMs: 90_000 })).toEqual({ ended: false });
    expect(evaluateEpisodeEnd({ ...base, nowMs: 90_000 + consumedAliveBoundMs(20_000), filePresent: false, consumptionAtMs: 90_000 })).toEqual({ ended: true, cause: 'consumed-process-alive' });
    expect(consumedAliveBoundMs(20_000)).toBe(60_000);
    expect(consumedAliveBoundMs(90_000)).toBe(118_000);
  });
  it('a file absent 60 s with no row ends it; absent 59 s does not; a cut or unreadable ledger keeps it open', () => {
    const gone = { ...base, filePresent: false, fileLastSeenMs: 40_000 };
    expect(evaluateEpisodeEnd({ ...gone, nowMs: 40_000 + EPISODE_ABSENCE_MS - 1 })).toEqual({ ended: false });
    expect(evaluateEpisodeEnd({ ...gone, nowMs: 40_000 + EPISODE_ABSENCE_MS })).toEqual({ ended: true, cause: 'removed-without-consumption' });
    expect(evaluateEpisodeEnd({ ...gone, nowMs: 200_000, ledgerCoverage: 'cut' })).toEqual({ ended: false });
    expect(evaluateEpisodeEnd({ ...gone, nowMs: 200_000, ledgerCoverage: 'unreadable' })).toEqual({ ended: false });
  });
  it('the four-hour cap ends it whatever the file says', () => {
    expect(evaluateEpisodeEnd({ ...base, nowMs: EPISODE_CAP_MS })).toEqual({ ended: true, cause: 'cap' });
  });
});

describe('boot measurement and the ledger lookup', () => {
  it('measures from the later of the exit stamp, the last renewal and the consumption row; negative is unknown', () => {
    const t = 1_000_000_000_000;
    expect(bootDurationMs({ nowMs: t + 90_000, exitedAt: new Date(t).toISOString(), renewedAt: new Date(t - 9_000).toISOString(), consumptionAtMs: null })).toBe(90_000);
    expect(bootDurationMs({ nowMs: t + 90_000, exitedAt: null, renewedAt: new Date(t - 9_000).toISOString(), consumptionAtMs: t - 2_000 })).toBe(92_000);
    expect(bootDurationMs({ nowMs: t, exitedAt: new Date(t + 5_000).toISOString(), renewedAt: new Date(t).toISOString(), consumptionAtMs: null })).toBeNull();
  });
  it('finds this request\'s consumption row by requestedAt, an unattributed row for an unattributed flag, and reports coverage', () => {
    const dir = tmp();
    const reqAt = '2026-11-21T09:38:35.370Z';
    recordRestartRequest(dir, { requestedAt: '2026-11-21T08:00:00.000Z', requestedBy: 'role-change', plannedRestart: true }, 'supervisor', new Date('2026-11-21T08:14:00.000Z'));
    recordRestartRequest(dir, { requestedAt: reqAt, requestedBy: 'role-change', plannedRestart: true }, 'supervisor', new Date('2026-11-21T09:45:31.526Z'));
    recordRestartRequest(dir, {}, 'foreground-watcher', new Date('2026-11-21T10:00:00.000Z'));
    const since = Date.parse('2026-11-21T09:38:00.000Z');
    const hit = findRestartRequestRecord(dir, { requestedAt: reqAt, sinceMs: since });
    expect(hit.record?.at).toBe('2026-11-21T09:45:31.526Z');
    expect(hit.coverage).toBe('full');
    expect(findRestartRequestRecord(dir, { requestedAt: '2026-11-21T09:55:13.469Z', sinceMs: since }).record).toBeNull();
    const unattributed = findRestartRequestRecord(dir, { requestedAt: null, sinceMs: Date.parse('2026-11-21T09:50:00.000Z') });
    expect(unattributed.record?.attributed).toBe(false);
    expect(findRestartRequestRecord(path.join(dir, 'nope'), { requestedAt: reqAt, sinceMs: since })).toEqual({ record: null, coverage: 'full' });
    expect(cleanString(' a\nb ')).toBe('a b');
  });
});

describe('the local store\'s pending marker (§1 step 4, Terms "Window lease")', () => {
  it('is written with a pending renewal, survives casWrite in the same episode, and is cleared by refresh without it, by force-expiry and explicitly', () => {
    const dir = tmp();
    const file = path.join(dir, 'lease-local.json');
    const store = new LocalLeaseStore({ filePath: file });
    const t = 1_000_000_000_000;
    const l1 = fl('studio').signLease(41, new Date(t).toISOString(), new Date(t + TTL).toISOString(), 1);
    expect(store.casWrite(l1).ok).toBe(true);
    expect(store.readPendingEpisodeId()).toBeNull();
    const w = fl('studio').signLease(41, new Date(t).toISOString(), new Date(t + 233_000).toISOString(), 2);
    expect(store.refreshWithPending(w, 'ep-1')).toBe(true);
    expect(new LocalLeaseStore({ filePath: file }).readPendingEpisodeId()).toBe('ep-1');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pendingEpisodeId).toBe('ep-1');
    const l2 = fl('studio').signLease(42, new Date(t + 1).toISOString(), new Date(t + 1 + TTL).toISOString(), 3);
    expect(store.casWrite(l2).ok).toBe(true);
    expect(store.readPendingEpisodeId()).toBe('ep-1'); // carried through casWrite in the same episode
    const r = fl('studio').signLease(42, new Date(t + 1).toISOString(), new Date(t + 1 + TTL).toISOString(), 4);
    expect(store.refreshWithPending(r, null)).toBe(true);
    expect(new LocalLeaseStore({ filePath: file }).readPendingEpisodeId()).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pendingEpisodeId).toBeUndefined();
    store.refreshWithPending(r, 'ep-2');
    store.forceLocalExpiry();
    expect(new LocalLeaseStore({ filePath: file }).readPendingEpisodeId()).toBeNull();
    store.refreshWithPending(fl('studio').signLease(42, new Date(t + 1).toISOString(), new Date(t + 1 + TTL).toISOString(), 5), 'ep-3');
    store.clearPendingEpisodeId();
    expect(new LocalLeaseStore({ filePath: file }).readPendingEpisodeId()).toBeNull();
    expect(store.read().lease?.nonce).toBe(5);
  });
});
