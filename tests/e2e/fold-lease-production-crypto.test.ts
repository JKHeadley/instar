/**
 * context-budget-layered-summaries §9.3/§14 — e2e: the fold lock built by the
 * production factory (createFoldLeaseLock) on two paired machine identities
 * (real MachineIdentityManager, real Ed25519 keys on disk, each registered in
 * the other's registry), sharing the `local` medium directory as one machine
 * would with itself across two hands. Proves the production signing and
 * verification path: a lock one machine holds is honoured by the other, a
 * lock naming an unpaired machine is not, the key is bound, and the
 * coordinator → sentinel handover works on real keys.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachineIdentityManager, generateMachineId, generateSigningKeyPair, generateEncryptionKeyPair } from '../../src/core/MachineIdentity.js';
import { createFoldLeaseLock, foldLeaseDir } from '../../src/core/foldLeaseFactory.js';
import { LocalKeyedLeaseStore } from '../../src/core/KeyedLease.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/fold-lease-production-crypto.test.ts';

function machine(name: string) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `fold-lease-e2e-${name}-`));
  const mgr = new MachineIdentityManager(stateDir);
  const machineId = generateMachineId();
  const signing = generateSigningKeyPair();
  const enc = generateEncryptionKeyPair();
  const strip = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  const identity = {
    machineId, signingPublicKey: strip(signing.publicKey), encryptionPublicKey: strip(enc.publicKey),
    name, platform: `${os.platform()}-${os.arch()}`, createdAt: new Date().toISOString(), capabilities: ['sessions'],
  };
  const dir = path.join(stateDir, 'machine');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(identity));
  fs.writeFileSync(path.join(dir, 'signing-private.pem'), signing.privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'encryption-private.pem'), enc.privateKey, { mode: 0o600 });
  mgr.registerMachine(identity as never, 'awake');
  return { stateDir, mgr, machineId, identity };
}

describe('fold lock — production factory on real machine identities', () => {
  let a: ReturnType<typeof machine>;
  let b: ReturnType<typeof machine>;
  let c: ReturnType<typeof machine>;
  let shared: string;

  beforeAll(() => {
    a = machine('a'); b = machine('b'); c = machine('unpaired');
    // Pairing as the real flow leaves it: a registry entry plus the peer's stored identity.
    a.mgr.registerMachine(b.identity as never, 'standby');
    b.mgr.registerMachine(a.identity as never, 'standby');
    a.mgr.storeRemoteIdentity(b.identity as never);
    b.mgr.storeRemoteIdentity(a.identity as never);
    shared = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-lease-e2e-shared-'));
  });
  afterAll(() => { for (const d of [a.stateDir, b.stateDir, c.stateDir, shared]) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  it('the default medium is a per-topic file under state/fold-leases', () => {
    const lock = createFoldLeaseLock({ stateDir: a.stateDir, selfMachineId: a.machineId, idMgr: a.mgr });
    const r = lock.acquire('141133', 'coordinator');
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(foldLeaseDir(a.stateDir), '141133.json'))).toBe(true);
  });

  it("a paired machine honours the holder's lock; an unpaired machine's lock is not honoured", () => {
    const store = () => new LocalKeyedLeaseStore(shared);
    const la = createFoldLeaseLock({ stateDir: a.stateDir, selfMachineId: a.machineId, idMgr: a.mgr, store: store() });
    const lb = createFoldLeaseLock({ stateDir: b.stateDir, selfMachineId: b.machineId, idMgr: b.mgr, store: store() });
    const lc = createFoldLeaseLock({ stateDir: c.stateDir, selfMachineId: c.machineId, idMgr: c.mgr, store: store() });
    expect(la.acquire('200', 'coordinator').ok).toBe(true);
    expect(lb.acquire('200', 'coordinator')).toMatchObject({ ok: false, reason: 'held', holder: { holder: a.machineId } });
    // An unpaired machine writes a lock: b (who does not know it) treats it as not held.
    expect(lc.acquire('201', 'coordinator').ok).toBe(true);
    const r = lb.acquire('201', 'coordinator');
    expect(r.ok && r.lease.generation).toBe(2);
  });

  it('a lock for one topic cannot be replayed as another topic (key in the signature)', () => {
    const la = createFoldLeaseLock({ stateDir: a.stateDir, selfMachineId: a.machineId, idMgr: a.mgr, store: new LocalKeyedLeaseStore(shared) });
    const got = la.acquire('300', 'coordinator');
    if (!got.ok) throw new Error('acquire failed');
    fs.writeFileSync(path.join(shared, '301.json'), JSON.stringify({ lease: { ...got.lease, key: '301' } }));
    expect(la.holds({ ...got.lease, key: '301' })).toBe(false);
  });

  it('coordinator → sentinel handover on real keys fences the coordinator', () => {
    const la = createFoldLeaseLock({ stateDir: a.stateDir, selfMachineId: a.machineId, idMgr: a.mgr, store: new LocalKeyedLeaseStore(shared) });
    const got = la.acquire('400', 'coordinator');
    if (!got.ok) throw new Error('acquire failed');
    const h = la.handover(got.lease, 'sentinel');
    if (!h.ok) throw new Error('handover failed');
    expect(la.holds(got.lease, { allowExpired: true })).toBe(false);
    expect(la.holds(h.lease)).toBe(true);
  });
});
