/**
 * Boot wiring for the owner record (identity-security piece 2b). Kept out of server.ts, whose startup
 * function is at the compiler's flow-analysis limit: server.ts calls three functions here and nothing more.
 *
 * Ships on: the record grants nothing by itself (later pieces read it through `OwnerRecordStore.gate()`).
 * `security.ownerRecord.enabled: false` turns it off; the route then answers 503 and no mesh traffic runs.
 */
import { OwnerRecordStore, type OwnerRecordSelf } from './ownerRecordStore.js';
import { OwnerRecordSync, type ClaimPeerCheck, type OwnerRecordPullCmd, type OwnerRecordPushCmd } from './ownerRecordSync.js';
import { sign as machineSign } from './MachineIdentity.js';
import type { MachineIdentityManager } from './MachineIdentity.js';
import type { OwnerRecordRouteDeps } from '../server/ownerRecordRoutes.js';
import { PeerBuildLedger, fenceInForce, keyFingerprint } from './identityBuildFence.js';
import { MESH_VERB_FENCE_CLASS, setBelowFencePredicate, setMeshFencePolicy } from './meshVerbFenceClass.js';
import { getInstarVersion } from './Config.js';
import { makeFirstOwnerProofVerifier } from './ownerApprover.js';
import { readLocalRecordKey } from './ownerRecordLocalKey.js';
import type { GateVerdict } from './ownerRecordStore.js';

const PULL_INTERVAL_MS = 15 * 60 * 1000;
const FIRST_PULL_DELAY_MS = 30 * 1000;

let live: { store: OwnerRecordStore; sync: OwnerRecordSync | null } | null = null;

/** Piece 3a: what the first-approver claim needs from this machine's record and mesh. */
interface ClaimBase { stateDir: string; agentId: string; identity: MachineIdentityManager; selfMachineId: string | null; leaseHolder: (() => string | null) | null; splitBrain: (() => boolean) | null }
let claimBase: ClaimBase | null = null;
let approverFactsFn: (() => { unvouched: number; migratedAt?: string | null; retired?: string[] }) | null = null;
let peerRetiredFn: ((hashes: string[]) => void) | null = null;
let peerMigrationsFn: ((earliest: string | null, allAnswered: boolean) => void) | null = null;
let claimLiveFn: (() => boolean) | null = null;

/** Piece 3a §3: the server tells the sync how many unvouched owner devices this machine has, and whether a claim is live. */
export function setOwnerRecordApproverHooks(h: { approverFacts: () => { unvouched: number; migratedAt?: string | null; retired?: string[] }; claimLive: () => boolean; peerMigrations?: (earliest: string | null, allAnswered: boolean) => void; peerRetired?: (hashes: string[]) => void } | null): void {
  peerRetiredFn = h?.peerRetired ?? null;
  approverFactsFn = h?.approverFacts ?? null;
  peerMigrationsFn = h?.peerMigrations ?? null;
  claimLiveFn = h?.claimLive ?? null;
}

export interface ApproverClaimEnv {
  store: OwnerRecordStore;
  agentId: string;
  stateDir: string;
  /** Every other registered machine. */
  peers: () => string[];
  /** Ask every other machine now; null when there are peers but no running sync (the claim then refuses). */
  check: ((timeoutMs: number) => Promise<ClaimPeerCheck>) | null;
  /** This machine holds the lease (a lone agent is its own holder) and no split-brain is reported. */
  leaseHere: () => boolean;
  splitBrain: () => boolean;
  /** Carry new entries to every machine (no-op on a lone agent). */
  push: (ids: string[]) => void;
}

/** Piece 3a: the claim's view of the record and mesh; null while the owner record is off. */
export function approverClaimEnv(): ApproverClaimEnv | null {
  if (!live || !claimBase) return null;
  const b = claimBase;
  const sync = live.sync;
  const self = b.selfMachineId;
  const peers = (): string[] => { try { return b.identity.hasIdentity() ? b.identity.getActiveMachines().map((m) => m.machineId).filter((id) => id !== self) : []; } catch { return ['(unreadable machine registry)']; /* @silent-fallback-ok: an unreadable registry names a placeholder machine, which closes the claim */ } };
  return {
    store: live.store, agentId: b.agentId, stateDir: b.stateDir, peers,
    check: sync ? (ms) => sync.claimCheck(ms) : (peers().length === 0 ? async () => ({ silent: [], enrolled: [], olderBuild: [], unvouched: [] }) : null),
    leaseHere: () => (b.leaseHolder ? b.leaseHolder() === self : peers().length === 0),
    splitBrain: () => (b.splitBrain ? b.splitBrain() : false),
    push: (ids) => { if (sync) void sync.pushToPeers(ids); },
  };
}
let timers: NodeJS.Timeout[] = [];

export interface OwnerRecordConfigView {
  stateDir: string;
  projectName?: string;
  security?: { ownerRecord?: { enabled?: boolean } };
}

export function ownerRecordEnabled(config: OwnerRecordConfigView): boolean {
  return config.security?.ownerRecord?.enabled !== false;
}

/** The route's view (GET /owner-record); null while off. */
export function ownerRecordRouteDeps(): OwnerRecordRouteDeps | null {
  return live ? { store: live.store, sync: live.sync } : null;
}

/** Build and load the store. Works on every machine, with or without a machine identity. */
export function wireOwnerRecordStore(config: OwnerRecordConfigView, identity: MachineIdentityManager): OwnerRecordStore | null {
  if (!ownerRecordEnabled(config)) return null;
  const self = (): OwnerRecordSelf | null => {
    // Piece 3a §2: a lone agent signs with its record-only key, and only once it has one (created at the claim).
    if (!identity.hasIdentity()) {
      try { return readLocalRecordKey(config.stateDir); } catch { return null; /* @silent-fallback-ok: an unreadable record-only key signs nothing; the claim refuses and names it */ }
    }
    const machineId = identity.loadIdentity().machineId;
    const publicKeyPem = identity.getSigningPublicKeyPem(machineId);
    if (!publicKeyPem) return null;
    return { machineId, publicKeyPem, sign: (text) => machineSign(text, identity.loadSigningKey()) };
  };
  const store = new OwnerRecordStore({
    instarDir: config.stateDir,
    agentId: config.projectName ?? 'agent',
    self,
    registeredKey: (machineId) => {
      const me = self();
      if (me && me.machineId === machineId && machineId.startsWith('m_local_')) return me.publicKeyPem;
      return identity.isMachineActive(machineId) || me?.machineId === machineId ? identity.getSigningPublicKeyPem(machineId) : null;
    },
    // Piece 3a §3: the first owner key's proof is checked against the record itself.
    verifyFirstOwnerProof: makeFirstOwnerProofVerifier(config.projectName ?? 'agent'),
  });
  claimBase = { stateDir: config.stateDir, agentId: config.projectName ?? 'agent', identity, selfMachineId: identity.hasIdentity() ? identity.loadIdentity().machineId : null, leaseHolder: null, splitBrain: null };
  const { corruptLines } = store.load();
  if (corruptLines > 0) console.warn(`[owner-record] ${corruptLines} unreadable line(s) in the stored record; they will be pulled again from a peer`);
  live = { store, sync: null };
  return store;
}

/** Any signed, verified mesh message from a peer re-arms the bootstrap breaker (2b §3). */
export function ownerRecordHeardFrom(peer: string): void {
  live?.sync?.heardVerified(peer);
}

/** The two mesh handlers. Registered always, so a peer gets a clean "disabled" answer, never no-handler. */
export function ownerRecordMeshHandlers(): Record<'owner-record-push' | 'owner-record-pull', (cmd: unknown, sender: string, env?: { timestamp?: number }) => unknown> {
  return {
    'owner-record-push': (cmd, sender) => {
      if (!live?.sync) return { ok: false, reason: 'owner-record disabled' };
      return live.sync.handlePush(sender, cmd as OwnerRecordPushCmd);
    },
    'owner-record-pull': (cmd, sender, env) => {
      if (!live?.sync) return { ok: false, reason: 'owner-record disabled' };
      // The envelope's signed time orders this peer's build statements (piece 2c §2).
      return live.sync.handlePull(sender, cmd as OwnerRecordPullCmd, typeof env?.timestamp === 'number' ? env.timestamp : undefined);
    },
  };
}

export interface OwnerRecordSyncWiring {
  config: OwnerRecordConfigView;
  identity: MachineIdentityManager;
  selfMachineId: string;
  send: (machineId: string, cmd: OwnerRecordPushCmd | OwnerRecordPullCmd) => Promise<{ ok: boolean; result?: unknown }>;
  leaseHolder: () => string | null;
  splitBrain: () => boolean;
  degrade: (summary: string) => void;
  /** Piece 2c: the one aggregated owner notice about machines below the fence. */
  notify?: (summary: string) => void;
  machineName?: (machineId: string) => string;
  clearNotice?: () => void;
  /** Piece 2d: the ownership record for a session (who owns it, at what epoch). */
  activeOwner?: (sessionKey: string) => { owner: string | null; epoch: number; status: string | null };
  degradeFence?: (summary: string) => void;
}

/**
 * The one place later pieces ask what the owner record means right now (piece 2b §5): basic, record or hold.
 * Null while the owner record is off.
 */
export function ownerRecordGate(): GateVerdict | null {
  if (!live) return null;
  const view = live.sync ? live.sync.peerView() : { allAnswered: true, honouredPeerMarker: false };
  return live.store.gate(view);
}

/**
 * The fence a join or a rollback must respect (piece 2c §4): the live one when the owner record runs here,
 * else the last verified fence saved on disk. Null before enrolment.
 */
export function ownerRecordFence(stateDir: string): string | null {
  if (live?.sync) return live.sync.fence().value;
  if (live) return fenceInForce(live.store.state(), PeerBuildLedger.at(stateDir)).value;
  return PeerBuildLedger.at(stateDir).lastVerifiedFence();
}

/** Start keeping the record in step: a first pull 30 s after boot, then every 15 minutes. */
export function startOwnerRecordSync(w: OwnerRecordSyncWiring): OwnerRecordSync | null {
  if (!live) return null;
  const sync = new OwnerRecordSync({
    store: live.store,
    agentId: w.config.projectName ?? 'agent',
    selfMachineId: () => w.selfMachineId,
    peers: () => w.identity.getActiveMachines().map((m) => m.machineId).filter((id) => id !== w.selfMachineId),
    send: w.send,
    isLeaseHolder: () => w.leaseHolder() === w.selfMachineId,
    splitBrain: w.splitBrain,
    degrade: w.degrade,
    selfBuild: () => getInstarVersion(),
    // Identity guards this build runs live (piece 2c §3). Pieces that add one list it here, e.g. 2d's
    // 'fence-lease' and 'fence-routing'. None yet.
    // Piece 2d: this build refuses a below machine the lease and routing whenever the fence is in force.
    // Piece 3a: 'approver-record' (devices approve only through the owner record); the first-approver claim reads
    // it from each peer's signed build statement.
    selfGuards: () => ['fence-lease', 'fence-routing', 'approver-record'],
    peerKey: (machineId) => keyFingerprint(w.identity.getSigningPublicKeyPem(machineId)),
    ledger: PeerBuildLedger.at(w.config.stateDir),
    notify: w.notify,
    machineName: w.machineName,
    clearNotice: w.clearNotice,
    degradeFence: w.degradeFence,
    approverFacts: () => approverFactsFn?.() ?? { unvouched: 0 },
    onPeerMigrations: (earliest, allAnswered) => peerMigrationsFn?.(earliest, allAnswered),
    onPeerRetired: (hashes) => peerRetiredFn?.(hashes),
    peerSince: (machineId) => { const t = Date.parse(String(w.identity.loadRegistry().machines?.[machineId]?.pairedAt ?? '')); return Number.isFinite(t) ? t : null; },
  });
  live.sync = sync;
  sync.claimLive = () => claimLiveFn?.() ?? false;
  if (claimBase) claimBase = { ...claimBase, selfMachineId: w.selfMachineId, leaseHolder: w.leaseHolder, splitBrain: w.splitBrain };
  installMeshFencePolicy(sync, w.activeOwner);
  setBelowFencePredicate((machineId) => sync.isBelow(machineId));
  // @silent-fallback-ok: a failed pass is logged and retried on the next 15-minute tick; peers' state is per pass.
  const run = (): void => { sync.tick().catch((e) => console.warn(`[owner-record] sync pass failed: ${e instanceof Error ? e.message : String(e)}`)); }; // @silent-fallback-ok: retried next tick
  const first = setTimeout(run, FIRST_PULL_DELAY_MS); first.unref?.();
  const every = setInterval(run, PULL_INTERVAL_MS); every.unref?.();
  timers.push(first, every);
  return sync;
}

/** Tests and shutdown: stop the timers and forget the live store. */
export function resetOwnerRecordWiringForTests(): void {
  setMeshFencePolicy(null);
  setBelowFencePredicate(null);
  for (const t of timers) clearTimeout(t);
  timers = [];
  live = null;
  claimBase = null;
  approverFactsFn = null;
  claimLiveFn = null;
  peerMigrationsFn = null;
  peerRetiredFn = null;
}

/**
 * Piece 2d §2b: refuse work and authority to a machine below the fence, and authority from it. Conversation
 * delivery still reaches it for a session it actively owns at that epoch, so failover never doubles replies.
 */
export function installMeshFencePolicy(sync: OwnerRecordSync, activeOwner?: OwnerRecordSyncWiring['activeOwner']): void {
  setMeshFencePolicy({
    refuseTo(machineId, command) {
      if (!sync.isBelow(machineId)) return null;
      const cls = MESH_VERB_FENCE_CLASS[command.type]?.cls;
      if (cls === 'liveness' || cls === 'read') return null;
      if (cls === 'conversation') {
        if (command.type === 'a2a-topic-reply-inject') return null; // its handler acts only on its own live session
        if (command.type === 'telegram-origin') return null; // the holder asks a standby only for reads (capabilities, receipts, audit)
        if (command.type === 'deliverMessage' && activeOwner) {
          const o = activeOwner(command.session);
          if (o.status === 'active' && o.owner === machineId && o.epoch === command.ownershipEpoch) return null;
        }
      }
      return 'below-minimum-build';
    },
    refuseFrom(machineId, command) {
      if (!sync.isBelow(machineId)) return null;
      const cls = MESH_VERB_FENCE_CLASS[command.type]?.cls;
      if (cls === 'authority') return 'below-minimum-build';
      // A below standby's replies post through the holder's bot only for a topic it actively owns (§2c).
      if (command.type === 'telegram-origin' && (command as { action?: string }).action === 'submit') {
        const topic = (command as { operation?: { record?: { destination?: { topicId?: string | null } } } }).operation?.record?.destination?.topicId;
        const o = topic && activeOwner ? activeOwner(String(topic)) : null;
        return o && o.status === 'active' && o.owner === machineId ? null : 'below-minimum-build';
      }
      return null;
    },
  });
}

/** Piece 2d: is this machine below the fence in force? False before enrolment or with no sync. */
export function ownerRecordIsBelow(machineId: string | null | undefined): boolean {
  return !!machineId && !!live?.sync?.isBelow(machineId);
}

/** Piece 2d §2: below holders the lease may be taken from now (each within its daily takeover budget). */
export function belowFenceHoldersForLease(stateDir: string): ReadonlySet<string> {
  if (!live?.sync) return new Set();
  const ledger = PeerBuildLedger.at(stateDir);
  return new Set(live.sync.machinesHeld().below.filter((m) => ledger.takeoverAllowed(m)));
}

/** Piece 2d §2: count a takeover from a below holder against its budget. */
export function noteBelowFenceTakeover(stateDir: string, holder: string): void {
  PeerBuildLedger.at(stateDir).noteTakeover(holder);
}

/** Piece 3a §3: no machine joins while a first-approver claim is live. */
export function ownerRecordClaimLive(): boolean { return claimLiveFn?.() ?? false; }

/** Piece 3a §2: the genesis this machine pins, for the join answer. */
export function ownerRecordPinnedGenesis(): string | null { return live ? live.store.pinned() : null; }
