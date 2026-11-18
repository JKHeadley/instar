/**
 * Boot wiring for the owner record (identity-security piece 2b). Kept out of server.ts, whose startup
 * function is at the compiler's flow-analysis limit: server.ts calls three functions here and nothing more.
 *
 * Ships on: the record grants nothing by itself (later pieces read it through `OwnerRecordStore.gate()`).
 * `security.ownerRecord.enabled: false` turns it off; the route then answers 503 and no mesh traffic runs.
 */
import { OwnerRecordStore, type OwnerRecordSelf } from './ownerRecordStore.js';
import { OwnerRecordSync, type OwnerRecordPullCmd, type OwnerRecordPushCmd } from './ownerRecordSync.js';
import { sign as machineSign } from './MachineIdentity.js';
import type { MachineIdentityManager } from './MachineIdentity.js';
import type { OwnerRecordRouteDeps } from '../server/ownerRecordRoutes.js';
import { PeerBuildLedger, fenceInForce, keyFingerprint } from './identityBuildFence.js';
import { MESH_VERB_FENCE_CLASS, setBelowFencePredicate, setMeshFencePolicy } from './meshVerbFenceClass.js';
import { getInstarVersion } from './Config.js';
import type { GateVerdict } from './ownerRecordStore.js';

const PULL_INTERVAL_MS = 15 * 60 * 1000;
const FIRST_PULL_DELAY_MS = 30 * 1000;

let live: { store: OwnerRecordStore; sync: OwnerRecordSync | null } | null = null;
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
    if (!identity.hasIdentity()) return null;
    const machineId = identity.loadIdentity().machineId;
    const publicKeyPem = identity.getSigningPublicKeyPem(machineId);
    if (!publicKeyPem) return null;
    return { machineId, publicKeyPem, sign: (text) => machineSign(text, identity.loadSigningKey()) };
  };
  const store = new OwnerRecordStore({
    instarDir: config.stateDir,
    agentId: config.projectName ?? 'agent',
    self,
    registeredKey: (machineId) => (identity.isMachineActive(machineId) || self()?.machineId === machineId ? identity.getSigningPublicKeyPem(machineId) : null),
  });
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
    selfGuards: () => ['fence-lease', 'fence-routing'],
    peerKey: (machineId) => keyFingerprint(w.identity.getSigningPublicKeyPem(machineId)),
    ledger: PeerBuildLedger.at(w.config.stateDir),
    notify: w.notify,
    machineName: w.machineName,
    clearNotice: w.clearNotice,
    degradeFence: w.degradeFence,
    peerSince: (machineId) => { const t = Date.parse(String(w.identity.loadRegistry().machines?.[machineId]?.pairedAt ?? '')); return Number.isFinite(t) ? t : null; },
  });
  live.sync = sync;
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
