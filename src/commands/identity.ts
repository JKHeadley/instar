/**
 * `instar identity` — replacing an EXISTING agent identity is a command on that machine,
 * run by the agent after a human yes (a2a-single-agent-identity §1.4).
 *
 *   instar identity adopt --from <machine-name-or-id>
 *       Under the identity lock, FIRST moves the existing identity file(s) and
 *       `threadline/agent-info.json` aside (`*.superseded-<ISO>`; a present-but-invalid
 *       file as `identity.json.invalid-<ISO>`) so this machine's observe answer reads
 *       `not-provisioned` and its stale memory cannot pin; THEN requests the identity from
 *       the named sibling over `agent-identity-request`; verifies signature, AAD, the sealed
 *       key hashing to the value and the in-memory keypair check — WITHOUT the
 *       `reachable-agree` and last-known rules (the human named the source, and this
 *       machine's memory is precisely what is being corrected); installs; calls the reload
 *       lever on the running server; restarts a running listener daemon. ANY refusal or
 *       failure restores every moved file and says so.
 *
 *   instar identity init --standalone --i-understand-peers-must-repin
 *       Mints a NEW identity on a fleet with no usable candidate (provenance
 *       `minted-by-operator-recovery`). Peers must re-pin the new address.
 *
 *   instar identity status
 *       The on-disk posture + fingerprint (never key material).
 *
 * Nothing here ever DELETES an identity file (L12: superseded files are renamed).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
import { MachineIdentityManager, isRegistryEntryActive, sign, verify } from '../core/MachineIdentity.js';
import { MeshRpcClient } from '../core/MeshRpcClient.js';
import type { MeshCommand } from '../core/MeshRpc.js';
import {
  installAdoptedIdentity,
  openAdoptionEnvelope,
  readAgentIdentityPosture,
  verifyObserveResponse,
  type ObserveCommand,
  type RequestCommand,
} from '../core/AgentIdentityAdoption.js';
import { AgentIdentityAudit } from '../core/AgentIdentityAudit.js';
import { withIdentityLock, IdentityLockedError, type IdentityLockDeps } from '../core/AgentIdentityLock.js';
import { fingerprintOf } from '../core/AgentIdentityHandover.js';
import { readIdentityKeyFile, writeFileAtomicOwnerOnly } from '../identity/IdentityKeyFile.js';
import { generateIdentityKeyPair } from '../threadline/ThreadlineCrypto.js';
import { restartListener } from './listener.js';

// ── Pure cores (injectable transport; the commander actions below bind the real one) ──

export type SiblingSend = (cmd: MeshCommand, timeoutMs: number) => Promise<{ ok: true; result: unknown } | { ok: false; reason: 'no-handler' | 'transport' }>;

export interface AdoptFromSiblingDeps {
  stateDir: string;
  agentName: string;
  selfMachineId: string;
  from: { machineId: string; nickname: string };
  send: SiblingSend;
  verifySig: (machineId: string, canonical: string, sig: string) => boolean;
  ownEncryptionPrivateKeyPem: string | null;
  /** The reload lever on the running server (§1.2); resolves `{ ok:false }` when no server is up. */
  reload: () => Promise<{ ok: boolean; detail: string }>;
  listenerRunning: () => boolean;
  restartListener: () => Promise<void>;
  audit?: AgentIdentityAudit;
  now?: () => Date;
  mintNonce?: () => string;
  lockDeps?: IdentityLockDeps;
}

export type MovedFile = { from: string; to: string };

export type AdoptResult =
  | { ok: true; fingerprint: string; movedAside: MovedFile[]; reloaded: { ok: boolean; detail: string }; listenerRestarted: boolean; voidFill: boolean }
  | { ok: false; reason: string; detail: string; restored: MovedFile[] };

const IDENTITY_FILES = ['identity.json', path.join('threadline', 'identity.json')];
const LAST_KNOWN_FILE = path.join('threadline', 'agent-info.json');

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Move the existing identity file(s) and the last-known pin aside (rename, never unlink).
 * A present-but-invalid or encrypted identity file is moved as `.invalid-<ISO>`.
 */
export function moveIdentityAside(stateDir: string, now: Date): MovedFile[] {
  const moved: MovedFile[] = [];
  for (const rel of IDENTITY_FILES) {
    const full = path.join(stateDir, rel);
    if (!fs.existsSync(full)) continue;
    let usable = false;
    try {
      const loaded = readIdentityKeyFile(full, { repair: false });
      usable = !!loaded && !loaded.encrypted && !!loaded.privateKey;
    } catch {
      usable = false;
    }
    const to = `${full}.${usable ? 'superseded' : 'invalid'}-${stamp(now)}`;
    fs.renameSync(full, to);
    moved.push({ from: full, to });
  }
  const lastKnown = path.join(stateDir, LAST_KNOWN_FILE);
  if (fs.existsSync(lastKnown)) {
    const to = `${lastKnown}.superseded-${stamp(now)}`;
    fs.renameSync(lastKnown, to);
    moved.push({ from: lastKnown, to });
  }
  return moved;
}

/** Put every moved file back (only the ones that are still at their backup path). */
export function restoreMoved(moved: MovedFile[]): MovedFile[] {
  const restored: MovedFile[] = [];
  for (const m of moved) {
    try {
      if (fs.existsSync(m.to) && !fs.existsSync(m.from)) {
        fs.renameSync(m.to, m.from);
        restored.push(m);
      }
    } catch {
      /* a backup that cannot be moved back stays where it is — never deleted */
    }
  }
  return restored;
}

/** `instar identity adopt --from <sibling>` — the core, pure over the injected transport. */
export async function adoptFromSibling(d: AdoptFromSiblingDeps): Promise<AdoptResult> {
  const now = d.now ?? (() => new Date());
  const nonce = d.mintNonce ?? (() => crypto.randomBytes(12).toString('hex'));
  const existing = readAgentIdentityPosture(d.stateDir);
  const voidFill = existing.state === 'not-provisioned';

  // 1. Under the lock: move the existing files aside so this machine reads not-provisioned.
  let moved: MovedFile[] = [];
  try {
    moved = withIdentityLock(d.stateDir, () => moveIdentityAside(d.stateDir, now()), d.lockDeps);
  } catch (err) {
    const reason = err instanceof IdentityLockedError ? 'identity-locked' : 'move-aside-failed';
    return { ok: false, reason, detail: err instanceof Error ? err.message : String(err), restored: [] };
  }
  const fail = (reason: string, detail: string): AdoptResult => {
    const restored = restoreMoved(moved);
    d.audit?.append('cli-adopt', { machineId: d.selfMachineId, from: d.from.machineId, ok: false, reason, detail, restored: restored.map((m) => path.basename(m.from)) });
    return { ok: false, reason, detail, restored };
  };

  // 2. Observe the named sibling (signed) for the value it publishes.
  const obsNonce = nonce();
  const obs = await d.send({ type: 'agent-identity-observe', agentName: d.agentName, requesterNonce: obsNonce } satisfies ObserveCommand, 8000);
  if (!obs.ok) return fail(`observe-${obs.reason}`, obs.reason === 'no-handler' ? `${d.from.nickname} runs an older version without the identity verbs — update it first` : `${d.from.nickname} could not be reached`);
  const verified = verifyObserveResponse(obs.result, { machineId: d.from.machineId, requesterNonce: obsNonce, nickname: d.from.nickname }, d.verifySig);
  if (verified.state === 'unreachable') return fail(`observe-${verified.reason ?? 'unverified'}`, `${d.from.nickname}'s answer did not verify against its registered machine key`);
  if (verified.state !== 'provisioned' || !verified.fingerprint) return fail('source-not-provisioned', `${d.from.nickname} publishes no agent identity; nothing to adopt from it`);
  const expected = verified.fingerprint;

  // 3. Request the identity; verify signature, nonce, AAD, key hashing, keypair IN MEMORY.
  if (!d.ownEncryptionPrivateKeyPem) return fail('no-encryption-key', 'this machine has no X25519 encryption key to open a sealed identity (re-run `instar join`)');
  const reqNonce = nonce();
  const req = await d.send({ type: 'agent-identity-request', agentName: d.agentName, expectedFingerprint: expected, requesterNonce: reqNonce } satisfies RequestCommand, 15000);
  if (!req.ok) return fail(`request-${req.reason}`, `the request to ${d.from.nickname} failed (${req.reason})`);
  const opened = openAdoptionEnvelope({
    response: req.result,
    responderMachineId: d.from.machineId,
    selfMachineId: d.selfMachineId,
    expectedFingerprint: expected,
    requesterNonce: reqNonce,
    ownEncryptionPrivateKeyPem: d.ownEncryptionPrivateKeyPem,
    verifySig: d.verifySig,
  });
  if (!opened.ok) {
    const reason = opened.rejection === 'refused' ? `refused:${opened.refusal ?? 'unknown'}` : opened.rejection;
    return fail(reason, `${d.from.nickname} answered ${reason}`);
  }

  // 4. Install (void-fill — the files were moved aside, so a present file means a race).
  const installed = installAdoptedIdentity({
    stateDir: d.stateDir,
    identity: opened.identity,
    origin: 'adopted-by-operator',
    selfMachineId: d.selfMachineId,
    adoptedFrom: opened.adoptedFrom,
    producedBy: 'instar identity adopt',
    lockDeps: d.lockDeps,
  });
  if (!installed.ok) return fail(installed.reason, installed.detail ?? installed.reason);

  // 5. The reload lever on the running server (nothing if no server is up — the next boot
  //    loads the new file), then a running listener daemon is restarted (stop + start).
  const reloaded = await d.reload();
  let listenerRestarted = false;
  if (d.listenerRunning()) {
    try {
      await d.restartListener();
      listenerRestarted = true;
    } catch {
      listenerRestarted = false;
    }
  }
  d.audit?.append('cli-adopt', { machineId: d.selfMachineId, from: d.from.machineId, ok: true, fingerprint: installed.fingerprint, voidFill, movedAside: moved.map((m) => path.basename(m.to)), reloaded: reloaded.ok, listenerRestarted });
  return { ok: true, fingerprint: installed.fingerprint, movedAside: moved, reloaded, listenerRestarted, voidFill };
}

export interface InitStandaloneDeps {
  stateDir: string;
  selfMachineId: string | null;
  acknowledged: boolean;
  reload: () => Promise<{ ok: boolean; detail: string }>;
  listenerRunning: () => boolean;
  restartListener: () => Promise<void>;
  audit?: AgentIdentityAudit;
  now?: () => Date;
  lockDeps?: IdentityLockDeps;
}

export type InitResult =
  | { ok: true; fingerprint: string; movedAside: MovedFile[]; reloaded: { ok: boolean; detail: string }; listenerRestarted: boolean }
  | { ok: false; reason: string; detail: string; restored: MovedFile[] };

/** `instar identity init --standalone --i-understand-peers-must-repin` — the core. */
export async function initStandalone(d: InitStandaloneDeps): Promise<InitResult> {
  if (!d.acknowledged) {
    return { ok: false, reason: 'not-acknowledged', detail: 'a new identity is a NEW address: every peer must re-pin it. Re-run with --i-understand-peers-must-repin to confirm.', restored: [] };
  }
  const now = d.now ?? (() => new Date());
  let moved: MovedFile[] = [];
  let fingerprint = '';
  try {
    withIdentityLock(d.stateDir, () => {
      moved = moveIdentityAside(d.stateDir, now());
      // Deliberate operator mint — the one minting site outside the guarded primitives
      // (listed in the mint-site census by file).
      const kp = generateIdentityKeyPair();
      fingerprint = fingerprintOf(kp.publicKey.toString('base64'));
      const file = {
        version: 1,
        publicKey: kp.publicKey.toString('base64'),
        privateKey: kp.privateKey.toString('base64'),
        privateKeyEncryption: 'none',
        createdAt: now().toISOString(),
        provenance: {
          schemaVersion: 1,
          origin: 'minted-by-operator-recovery',
          rootFingerprint: fingerprint,
          machineId: d.selfMachineId ?? 'standalone',
          createdAt: now().toISOString(),
          producedBy: 'instar identity init --standalone',
        },
      };
      writeFileAtomicOwnerOnly(path.join(d.stateDir, 'identity.json'), JSON.stringify(file, null, 2) + '\n');
    }, d.lockDeps);
  } catch (err) {
    const restored = restoreMoved(moved);
    const reason = err instanceof IdentityLockedError ? 'identity-locked' : 'mint-failed';
    d.audit?.append('cli-init-standalone', { machineId: d.selfMachineId, ok: false, reason, restored: restored.map((m) => path.basename(m.from)) });
    return { ok: false, reason, detail: err instanceof Error ? err.message : String(err), restored };
  }
  const reloaded = await d.reload();
  let listenerRestarted = false;
  if (d.listenerRunning()) {
    try {
      await d.restartListener();
      listenerRestarted = true;
    } catch {
      listenerRestarted = false;
    }
  }
  d.audit?.append('cli-init-standalone', { machineId: d.selfMachineId, ok: true, fingerprint, movedAside: moved.map((m) => path.basename(m.to)), reloaded: reloaded.ok, listenerRestarted });
  return { ok: true, fingerprint, movedAside: moved, reloaded, listenerRestarted };
}

// ── Binding to the real machine (commander actions) ─────────────────────────

interface IdentityCliOptions {
  dir?: string;
  from?: string;
  standalone?: boolean;
  iUnderstandPeersMustRepin?: boolean;
}

function resolveSibling(mgr: MachineIdentityManager, selfId: string, nameOrId: string): { machineId: string; nickname: string } | null {
  const byNick = mgr.resolveNickname(nameOrId);
  const registry = mgr.loadRegistry();
  const id = byNick ?? Object.entries(registry.machines).find(([mid, e]) => isRegistryEntryActive(e) && mid !== selfId && (e.name === nameOrId || mid === nameOrId || mid.startsWith(nameOrId)))?.[0] ?? null;
  if (!id || id === selfId) return null;
  const e = registry.machines[id];
  return { machineId: id, nickname: e?.nickname ?? e?.name ?? id };
}

function peerUrlOf(mgr: MachineIdentityManager, machineId: string): string | null {
  const direct = mgr.getMachineUrl(machineId);
  if (direct) return direct;
  const endpoints = mgr.getMachineEndpoints(machineId) ?? [];
  for (const ep of endpoints as Array<{ url?: string }>) if (typeof ep?.url === 'string' && ep.url) return ep.url;
  return null;
}

/** POST /agent-identity/reload on the local server, if one is up. */
async function reloadOnLocalServer(config: { port?: number; authToken?: string }): Promise<{ ok: boolean; detail: string }> {
  const port = config.port ?? 4040;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/agent-identity/reload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.authToken ?? ''}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json().catch(() => ({}))) as { fingerprint?: string; connected?: boolean; reason?: string; error?: string };
    if (!r.ok) return { ok: false, detail: `server answered ${r.status}${j.error ? ` (${j.error})` : ''}` };
    return { ok: true, detail: `server reloaded (${j.fingerprint ?? 'no fingerprint'}; ${j.connected ? 'relay connected' : j.reason ?? 'not connected'})` };
  } catch {
    return { ok: false, detail: 'no server is up on this machine — the next boot loads the new file' };
  }
}

function listenerRunningIn(stateDir: string): boolean {
  try {
    const pid = parseInt(fs.readFileSync(path.join(stateDir, 'listener-daemon.pid'), 'utf-8').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function describeMoved(moved: MovedFile[]): string {
  return moved.length ? moved.map((m) => `    ${path.basename(m.from)} → ${path.basename(m.to)}`).join('\n') : '    (nothing to move — the identity slot was empty)';
}

export async function identityAdopt(options: IdentityCliOptions): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(options.dir);
  } catch {
    console.log(pc.red('Not initialized. Run `instar init` first.'));
    process.exit(1);
  }
  if (!options.from) {
    console.log(pc.red('Name the sibling to adopt from: instar identity adopt --from <machine-name-or-id>'));
    process.exit(1);
  }
  const mgr = new MachineIdentityManager(config.stateDir);
  if (!mgr.hasIdentity()) {
    console.log(pc.red('This machine is not paired (no machine identity). Pair it first with `instar join`.'));
    process.exit(1);
  }
  const self = mgr.loadIdentity();
  const from = resolveSibling(mgr, self.machineId, options.from);
  if (!from) {
    console.log(pc.red(`No ACTIVE sibling named "${options.from}" in the machine registry.`));
    process.exit(1);
  }
  const url = peerUrlOf(mgr, from.machineId);
  if (!url) {
    console.log(pc.red(`${from.nickname} has no known URL in the registry; it must be online and reachable.`));
    process.exit(1);
  }
  const signingPem = mgr.loadSigningKey();
  let n = 0;
  const client = new MeshRpcClient({ selfMachineId: self.machineId, sign: (c) => sign(c, signingPem), nonce: () => `${self.machineId}:idcli:${Date.now()}:${++n}` });
  const send: SiblingSend = async (cmd, timeoutMs) => {
    try {
      const r = await client.send({ machineId: from.machineId, url }, cmd, 0, { timeoutMs });
      if (r.ok) return { ok: true, result: r.result };
      return { ok: false, reason: r.reason === 'no-handler' ? 'no-handler' : 'transport' };
    } catch {
      return { ok: false, reason: 'transport' };
    }
  };
  console.log(pc.blue(`Adopting the agent identity ${from.nickname} publishes onto this machine (${self.name ?? self.machineId})…`));
  const result = await adoptFromSibling({
    stateDir: config.stateDir,
    agentName: config.projectName,
    selfMachineId: self.machineId,
    from,
    send,
    verifySig: (machineId, canonical, sig) => {
      const pem = mgr.getSigningPublicKeyPem(machineId);
      if (!pem) return false;
      try { return verify(canonical, sig, pem); } catch { return false; }
    },
    ownEncryptionPrivateKeyPem: (() => { try { return mgr.loadEncryptionKey(); } catch { return null; } })(),
    reload: () => reloadOnLocalServer(config),
    listenerRunning: () => listenerRunningIn(config.stateDir),
    restartListener: () => restartListener({ dir: options.dir }),
    audit: new AgentIdentityAudit(config.stateDir),
  });
  if (!result.ok) {
    console.log(pc.red(`  Refused (${result.reason}): ${result.detail}`));
    console.log(pc.dim(`  Restored ${result.restored.length} moved file(s); nothing was changed.`));
    process.exit(1);
  }
  console.log(pc.green(`  Installed ${result.fingerprint} (adopted-by-operator, from ${from.nickname}).`));
  console.log(pc.dim('  Moved aside (kept, never deleted):\n' + describeMoved(result.movedAside)));
  console.log(pc.dim(`  Reload: ${result.reloaded.detail}`));
  if (result.listenerRestarted) console.log(pc.dim('  Listener daemon restarted under the new key.'));
}

export async function identityInit(options: IdentityCliOptions): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(options.dir);
  } catch {
    console.log(pc.red('Not initialized. Run `instar init` first.'));
    process.exit(1);
  }
  if (!options.standalone) {
    console.log(pc.red('`instar identity init` only mints with --standalone (a fleet with no usable candidate). To copy a sibling\'s identity use `instar identity adopt --from <machine>`.'));
    process.exit(1);
  }
  const mgr = new MachineIdentityManager(config.stateDir);
  const selfId = mgr.hasIdentity() ? mgr.loadIdentity().machineId : null;
  const result = await initStandalone({
    stateDir: config.stateDir,
    selfMachineId: selfId,
    acknowledged: options.iUnderstandPeersMustRepin === true,
    reload: () => reloadOnLocalServer(config),
    listenerRunning: () => listenerRunningIn(config.stateDir),
    restartListener: () => restartListener({ dir: options.dir }),
    audit: new AgentIdentityAudit(config.stateDir),
  });
  if (!result.ok) {
    console.log(pc.red(`  Refused (${result.reason}): ${result.detail}`));
    process.exit(1);
  }
  console.log(pc.green(`  Minted a NEW agent identity ${result.fingerprint} (minted-by-operator-recovery).`));
  console.log(pc.yellow('  Every peer that pinned the old address must re-pin this one.'));
  console.log(pc.dim('  Moved aside (kept, never deleted):\n' + describeMoved(result.movedAside)));
  console.log(pc.dim(`  Reload: ${result.reloaded.detail}`));
  if (result.listenerRestarted) console.log(pc.dim('  Listener daemon restarted under the new key.'));
}

export async function identityStatus(options: IdentityCliOptions): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(options.dir);
  } catch {
    console.log(pc.red('Not initialized. Run `instar init` first.'));
    process.exit(1);
  }
  const posture = readAgentIdentityPosture(config.stateDir);
  if (posture.state === 'provisioned') console.log(`${pc.green('provisioned')}  fingerprint ${posture.fingerprint}  (${path.relative(config.stateDir, posture.path)})`);
  else if (posture.state === 'invalid') console.log(`${pc.red('invalid')}  ${posture.path}: ${posture.reason} — \`instar identity adopt --from <sibling>\` moves it aside and installs the fleet's identity`);
  else console.log(`${pc.yellow('not-provisioned')}  no agent identity on this machine — a paired machine adopts it from a sibling automatically; a standalone one mints with \`instar identity init --standalone --i-understand-peers-must-repin\``);
}
