// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * AC4 (a2a-single-agent-identity §1.4): `instar identity adopt --from` moves the identity
 * file(s) and `agent-info.json` aside, is NOT refused by `requester-publishes-identity` (the
 * observe handler reads disk) or the last-known pin, installs, calls the reload lever,
 * restarts a running listener, and restores every moved file on a refusal; a re-run after a
 * crash proceeds as a void-fill; `init --standalone` mints with the recovery provenance and
 * refuses without the acknowledgement flag; `machines remove` prints the still-signs notice.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoptFromSibling, initStandalone, moveIdentityAside, restoreMoved } from '../../src/commands/identity.js';
import { AgentIdentityServer, readAgentIdentityOnDisk, readAgentIdentityPosture } from '../../src/core/AgentIdentityAdoption.js';
import { AgentIdentityAudit } from '../../src/core/AgentIdentityAudit.js';
import { generateSigningKeyPair, generateEncryptionKeyPair, pemToBase64, sign, verify } from '../../src/core/MachineIdentity.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../src/threadline/client/MessageEncryptor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MeshCommand } from '../../src/core/MeshRpc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rm = (d: string) => SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/agent-identity-operator-cli.test.ts' });

function writeIdentity(stateDir: string, kp = generateIdentityKeyPair(), rel = 'identity.json'): { fingerprint: string; privateKey: Buffer } {
  fs.mkdirSync(path.dirname(path.join(stateDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(stateDir, rel), JSON.stringify({ publicKey: kp.publicKey.toString('base64'), privateKey: kp.privateKey.toString('base64'), privateKeyEncryption: 'none', createdAt: '2026-05-01T00:00:00.000Z' }), { mode: 0o600 });
  return { fingerprint: computeFingerprint(kp.publicKey), privateKey: kp.privateKey };
}

/** One sibling serving the real handlers; the CLI's `send` is bound to it directly. */
function sibling(agentName = 'echo') {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-sib-'));
  const signing = generateSigningKeyPair();
  const requester = { id: 'm_target', enc: generateEncryptionKeyPair(), signing: generateSigningKeyPair() };
  const observeAnswers: Array<{ state: string; fingerprint: string | null }> = [];
  const srv = new AgentIdentityServer({
    stateDir,
    agentName,
    selfMachineId: 'm_source',
    sign: (c) => sign(c, signing.privateKey),
    isMachineActive: (id) => id === requester.id,
    registryEncryptionPublicKey: (id) => (id === requester.id ? pemToBase64(requester.enc.publicKey) : null),
    // The void-check reads the REQUESTER's own observe answer back — from the requester's disk.
    observeRequester: async () => observeAnswers.at(-1) ?? null,
  });
  const verifySig = (machineId: string, canonical: string, sig: string) => (machineId === 'm_source' ? verify(canonical, sig, signing.publicKey) : false);
  return { stateDir, srv, signing, requester, verifySig, observeAnswers };
}

function cliDeps(target: string, sib: ReturnType<typeof sibling>, overrides: Partial<Parameters<typeof adoptFromSibling>[0]> = {}) {
  const calls = { reload: 0, listener: 0 };
  // The requester's disk is what the source's void-check reads: emulate the observe handler
  // on the TARGET (reads disk through the single reader).
  const targetObserve = () => {
    const on = readAgentIdentityOnDisk(target);
    sib.observeAnswers.push(on ? { state: 'provisioned', fingerprint: on.fingerprint } : { state: 'not-provisioned', fingerprint: null });
  };
  const deps: Parameters<typeof adoptFromSibling>[0] = {
    stateDir: target,
    agentName: 'echo',
    selfMachineId: sib.requester.id,
    from: { machineId: 'm_source', nickname: 'mini' },
    send: async (cmd: MeshCommand) => {
      if (cmd.type === 'agent-identity-observe') return { ok: true, result: sib.srv.observe(cmd, sib.requester.id) };
      if (cmd.type === 'agent-identity-request') {
        targetObserve();
        return { ok: true, result: await sib.srv.request(cmd, sib.requester.id) };
      }
      return { ok: false, reason: 'no-handler' };
    },
    verifySig: sib.verifySig,
    ownEncryptionPrivateKeyPem: sib.requester.enc.privateKey,
    reload: async () => { calls.reload += 1; return { ok: true, detail: 'reloaded' }; },
    listenerRunning: () => true,
    restartListener: async () => { calls.listener += 1; },
    audit: new AgentIdentityAudit(target),
    lockDeps: { pid: 4242, processStartMs: 0, isPidAlive: () => true, processStartOf: () => 0 },
    ...overrides,
  };
  return { deps, calls };
}

describe('§1.4 instar identity adopt --from <sibling>', () => {
  it('moves the identity file(s) AND agent-info.json aside, is not refused by requester-publishes-identity or the last-known pin, installs, reloads, restarts the listener', async () => {
    const sib = sibling();
    const source = writeIdentity(sib.stateDir);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-target-'));
    const old = writeIdentity(target); // the SPLIT identity this machine currently publishes
    writeIdentity(target, generateIdentityKeyPair(), path.join('threadline', 'identity.json')); // a disagreeing legacy mirror
    fs.writeFileSync(path.join(target, 'threadline', 'agent-info.json'), JSON.stringify({ name: 'echo', fingerprint: old.fingerprint })); // stale memory
    const { deps, calls } = cliDeps(target, sib);
    const r = await adoptFromSibling(deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fingerprint).toBe(source.fingerprint);
    expect(r.voidFill).toBe(false);
    expect(r.movedAside.map((m) => path.basename(m.to))).toEqual([
      expect.stringMatching(/^identity\.json\.superseded-/),
      expect.stringMatching(/^identity\.json\.superseded-/),
      expect.stringMatching(/^agent-info\.json\.superseded-/),
    ]);
    for (const m of r.movedAside) expect(fs.existsSync(m.to)).toBe(true); // kept, never deleted
    const now = readAgentIdentityOnDisk(target)!;
    expect(now.fingerprint).toBe(source.fingerprint);
    expect(now.privateKey.equals(source.privateKey)).toBe(true);
    const file = JSON.parse(fs.readFileSync(path.join(target, 'identity.json'), 'utf-8')) as { provenance: { origin: string; adoptedFrom: { machineId: string } } };
    expect(file.provenance.origin).toBe('adopted-by-operator');
    expect(file.provenance.adoptedFrom.machineId).toBe('m_source');
    expect(calls).toEqual({ reload: 1, listener: 1 });
    // The audit never carries key bytes.
    const audit = fs.readFileSync(path.join(target, 'logs', 'agent-identity.jsonl'), 'utf-8');
    expect(audit).toContain('cli-adopt');
    expect(audit).not.toContain(source.privateKey.toString('base64'));
    rm(sib.stateDir); rm(target);
  });

  it('a present-but-invalid file is moved aside as .invalid-<ISO>', async () => {
    const sib = sibling();
    writeIdentity(sib.stateDir);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-target-'));
    fs.writeFileSync(path.join(target, 'identity.json'), '{ garbage');
    const { deps } = cliDeps(target, sib);
    const r = await adoptFromSibling(deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.movedAside.map((m) => path.basename(m.to))).toEqual([expect.stringMatching(/^identity\.json\.invalid-/)]);
    expect(readAgentIdentityPosture(target).state).toBe('provisioned');
    rm(sib.stateDir); rm(target);
  });

  it('ANY refusal restores BOTH moved files and says so (fingerprint-mismatch via a source that changed, and a transport failure)', async () => {
    const sib = sibling();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-target-'));
    const old = writeIdentity(target);
    fs.mkdirSync(path.join(target, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(target, 'threadline', 'agent-info.json'), JSON.stringify({ fingerprint: old.fingerprint }));
    // The source publishes nothing → source-not-provisioned.
    const { deps, calls } = cliDeps(target, sib);
    const r1 = await adoptFromSibling(deps);
    expect(r1).toMatchObject({ ok: false, reason: 'source-not-provisioned' });
    if (!r1.ok) expect(r1.restored.map((m) => path.basename(m.from))).toEqual(['identity.json', 'agent-info.json']);
    expect(readAgentIdentityOnDisk(target)?.fingerprint).toBe(old.fingerprint);
    expect(JSON.parse(fs.readFileSync(path.join(target, 'threadline', 'agent-info.json'), 'utf-8')).fingerprint).toBe(old.fingerprint);
    expect(calls.reload).toBe(0);
    // Transport failure mid-way.
    writeIdentity(sib.stateDir);
    const r2 = await adoptFromSibling({ ...deps, send: async (cmd) => (cmd.type === 'agent-identity-observe' ? { ok: true, result: sib.srv.observe(cmd, sib.requester.id) } : { ok: false, reason: 'transport' }) });
    expect(r2).toMatchObject({ ok: false, reason: 'request-transport' });
    expect(readAgentIdentityOnDisk(target)?.fingerprint).toBe(old.fingerprint);
    // An older sibling without the verbs is named as such.
    const r3 = await adoptFromSibling({ ...deps, send: async () => ({ ok: false, reason: 'no-handler' }) });
    expect(r3).toMatchObject({ ok: false, reason: 'observe-no-handler' });
    if (!r3.ok) expect(r3.detail).toMatch(/older version/);
    rm(sib.stateDir); rm(target);
  });

  it('a re-run after a crash between move-aside and install proceeds as a VOID-fill (the backups stay on disk)', async () => {
    const sib = sibling();
    const source = writeIdentity(sib.stateDir);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-target-'));
    writeIdentity(target);
    // Simulate the crash: the files were moved aside and nothing was installed.
    const moved = moveIdentityAside(target, new Date('2026-10-09T10:00:00Z'));
    expect(moved).toHaveLength(1);
    expect(readAgentIdentityPosture(target).state).toBe('not-provisioned');
    const { deps } = cliDeps(target, sib);
    const r = await adoptFromSibling(deps);
    expect(r).toMatchObject({ ok: true, voidFill: true, fingerprint: source.fingerprint });
    if (r.ok) expect(r.movedAside).toEqual([]);
    expect(fs.existsSync(moved[0].to)).toBe(true); // the earlier backup is still there
    rm(sib.stateDir); rm(target);
  });

  it('a lock held by another live process refuses `identity-locked` and moves nothing', async () => {
    const sib = sibling();
    writeIdentity(sib.stateDir);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-target-'));
    const old = writeIdentity(target);
    fs.writeFileSync(path.join(target, 'identity.lock'), JSON.stringify({ pid: 7777, startedAt: new Date(0).toISOString(), at: new Date().toISOString() }));
    let t = Date.now();
    const { deps } = cliDeps(target, sib, { lockDeps: { pid: 4242, processStartMs: 0, isPidAlive: () => true, processStartOf: () => 0, now: () => t, sleepMs: (ms) => { t += ms; }, waitMs: 500 } });
    const r = await adoptFromSibling(deps);
    expect(r).toMatchObject({ ok: false, reason: 'identity-locked' });
    expect(readAgentIdentityOnDisk(target)?.fingerprint).toBe(old.fingerprint);
    rm(sib.stateDir); rm(target);
  });
});

describe('§1.4 instar identity init --standalone', () => {
  it('refuses without --i-understand-peers-must-repin and changes nothing', async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-init-'));
    const old = writeIdentity(target);
    const r = await initStandalone({ stateDir: target, selfMachineId: 'm', acknowledged: false, reload: async () => ({ ok: true, detail: '' }), listenerRunning: () => false, restartListener: async () => undefined });
    expect(r).toMatchObject({ ok: false, reason: 'not-acknowledged' });
    expect(readAgentIdentityOnDisk(target)?.fingerprint).toBe(old.fingerprint);
    rm(target);
  });

  it('mints a NEW identity with provenance minted-by-operator-recovery, moving an existing one aside, and reloads', async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-init-'));
    const old = writeIdentity(target);
    let reloads = 0;
    const r = await initStandalone({ stateDir: target, selfMachineId: 'm', acknowledged: true, reload: async () => { reloads += 1; return { ok: true, detail: '' }; }, listenerRunning: () => false, restartListener: async () => undefined, audit: new AgentIdentityAudit(target), lockDeps: { pid: 1, processStartMs: 0, isPidAlive: () => true, processStartOf: () => 0 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fingerprint).not.toBe(old.fingerprint);
    expect(r.movedAside.map((m) => path.basename(m.to))).toEqual([expect.stringMatching(/^identity\.json\.superseded-/)]);
    const file = JSON.parse(fs.readFileSync(path.join(target, 'identity.json'), 'utf-8')) as { provenance: { origin: string } };
    expect(file.provenance.origin).toBe('minted-by-operator-recovery');
    expect(readAgentIdentityOnDisk(target)?.fingerprint).toBe(r.fingerprint);
    expect(reloads).toBe(1);
    expect(fs.statSync(path.join(target, 'identity.json')).mode & 0o077).toBe(0);
    rm(target);
  });

  it('restoreMoved puts back only what is still at its backup path', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-restore-'));
    writeIdentity(d);
    const moved = moveIdentityAside(d, new Date());
    expect(fs.existsSync(path.join(d, 'identity.json'))).toBe(false);
    const restored = restoreMoved(moved);
    expect(restored).toHaveLength(1);
    expect(fs.existsSync(path.join(d, 'identity.json'))).toBe(true);
    expect(restoreMoved(moved)).toEqual([]); // idempotent
    rm(d);
  });
});

describe('§1.4 instar machines remove prints the still-signs notice', () => {
  it('the removal text says the machine still holds a copy of the agent identity until rotation', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'commands', 'machine.ts'), 'utf-8');
    expect(src).toContain('still holds a copy of the agent identity and can sign as');
    expect(src).toContain('until the identity is rotated fleet-wide');
  });
});
