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
  live?.sync?.heardFrom(peer);
}

/** The two mesh handlers. Registered always, so a peer gets a clean "disabled" answer, never no-handler. */
export function ownerRecordMeshHandlers(): Record<'owner-record-push' | 'owner-record-pull', (cmd: unknown, sender: string) => unknown> {
  return {
    'owner-record-push': (cmd, sender) => {
      if (!live?.sync) return { ok: false, reason: 'owner-record disabled' };
      return live.sync.handlePush(sender, cmd as OwnerRecordPushCmd);
    },
    'owner-record-pull': (cmd, sender) => {
      if (!live?.sync) return { ok: false, reason: 'owner-record disabled' };
      return live.sync.handlePull(sender, cmd as OwnerRecordPullCmd);
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
  });
  live.sync = sync;
  // @silent-fallback-ok: a failed pass is logged and retried on the next 15-minute tick; peers' state is per pass.
  const run = (): void => { sync.tick().catch((e) => console.warn(`[owner-record] sync pass failed: ${e instanceof Error ? e.message : String(e)}`)); }; // @silent-fallback-ok: retried next tick
  const first = setTimeout(run, FIRST_PULL_DELAY_MS); first.unref?.();
  const every = setInterval(run, PULL_INTERVAL_MS); every.unref?.();
  timers.push(first, every);
  return sync;
}

/** Tests and shutdown: stop the timers and forget the live store. */
export function resetOwnerRecordWiringForTests(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
  live = null;
}
