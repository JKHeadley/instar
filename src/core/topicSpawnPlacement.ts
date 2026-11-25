/**
 * topicSpawnPlacement — placement Step 2: a topic-bound agent spawn (POST /sessions/spawn with
 * `placement: "auto"` and a `topicId`) starts where there is room, through the same fenced
 * path a person's first message uses (docs/specs/topic-spawns-placed-by-load.md).
 *
 * Pure decision helpers only; the route and server.ts own the I/O. Step 1's helpers
 * (agentSessionPlacement.ts) supply the self reading, the peer filter and the executor.
 */

import type { MachineCapacity } from './types.js';
import type { PlacementExecutor } from './PlacementExecutor.js';
import {
  agentSessionExecutor, agentSessionReservations, NON_TRAVELLING_FIELDS, peerRoom, selfLoadState,
  type AgentPlacementDecision, type AgentSessionPlacementService,
} from './agentSessionPlacement.js';
import type { StartTopicOnMachineResult } from './dashboardMachineChoice.js';
import type { BriefEmitOutcome } from './TopicSpawnBriefReplicatedStore.js';

/** The capability flag a receiving build advertises in its heartbeat `seamlessnessFlags`. */
export const AGENT_BRIEF_FLAG = 'agent-brief@1' as const;

/** The messageId prefix of an agent topic spawn: `agent-spawn:<topicId>:<nonce>`. */
export const AGENT_SPAWN_MESSAGE_PREFIX = 'agent-spawn:';

/**
 * The live switch: `multiMachine.placement.agentSessions.topicBound`, an omitted boolean
 * resolved by the dev-agent gate, AND Step 1's `agentSessions.enabled`.
 */
export function topicBoundPlacementEnabled(
  config: { developmentAgent?: boolean; multiMachine?: { placement?: { agentSessions?: { enabled?: boolean; topicBound?: boolean } } } } | undefined,
  resolve: (explicit: boolean | undefined, cfg: { developmentAgent?: boolean } | undefined) => boolean,
): boolean {
  const a = config?.multiMachine?.placement?.agentSessions;
  return resolve(a?.enabled, config) && resolve(a?.topicBound, config);
}

/** The topic's ownership state, as recorded in every topic-bound shadow row. */
export type TopicOwnershipState = 'none' | 'released' | 'self' | 'peer';

export function topicOwnershipState(
  rec: { status: string; ownerMachineId?: string | null } | null | undefined,
  selfMachineId: string | null | undefined,
): TopicOwnershipState {
  if (!rec) return 'none';
  if (rec.status === 'released') return 'released';
  if (rec.ownerMachineId && selfMachineId && rec.ownerMachineId === selfMachineId) return 'self';
  if (!rec.ownerMachineId) return 'none';
  return 'peer';
}

/** The 409 for a topic-bound spawn into a topic a peer owns. */
export function topicOwnedElsewhereBody(owner: { machineId: string; nickname: string | null }, ownerReachable: boolean): Record<string, unknown> {
  return {
    error: 'topic-owned-elsewhere',
    code: 'topic-owned-elsewhere',
    placementOutcome: 'topic-owned-elsewhere',
    owner,
    ownerReachable,
    next: ownerReachable
      ? `This conversation is already served by ${owner.nickname ?? owner.machineId}. Message the conversation instead of starting a second session in it.`
      : `This conversation is owned by ${owner.nickname ?? owner.machineId}, which cannot be reached right now. Do not wait on it; failover moves the conversation if that machine is gone.`,
  };
}

/** Why a topic-bound request must stay local, or null when it can travel. */
export function topicTravelBlocker(body: Record<string, unknown>, headers: Record<string, unknown>): string | null {
  for (const f of NON_TRAVELLING_FIELDS) {
    if (body[f] !== undefined && body[f] !== false) return 'options-do-not-travel';
  }
  if (headers['x-instar-bind-token'] !== undefined) return 'options-do-not-travel';
  if (body.workWeight === 'heavy') return 'options-do-not-travel';
  // A placed spawn starts with the topic's own profile on the target; a caller override would be lost.
  if (body.model !== undefined || body.framework !== undefined) return 'options-do-not-travel';
  return null;
}

export function peerAdvertisesAgentBrief(m: MachineCapacity): boolean {
  return (m.seamlessnessFlags as Record<string, unknown> | undefined)?.[AGENT_BRIEF_FLAG] === true;
}

/**
 * Where a topic-bound spawn would go. Floor: a fresh saturated/impaired verdict or own memory
 * pressure is busy; a missing or stale verdict stays local. Above the floor, the executor judges
 * this machine against the eligible peers with this machine as the sticky owner, so a peer wins
 * only when it is less loaded by the executor's hysteresis margin. Peers must pass Step 1's
 * room filter AND advertise `agent-brief@1`.
 */
export function decideTopicSpawnPlacement(o: {
  capacities: MachineCapacity[];
  selfMachineId: string | null;
  nowMs?: number;
  executor?: PlacementExecutor;
}): AgentPlacementDecision {
  const nowMs = o.nowMs ?? Date.now();
  const selfRow = o.selfMachineId ? o.capacities.find((c) => c.machineId === o.selfMachineId) : undefined;
  const self = selfLoadState(selfRow, nowMs);
  const others = o.capacities.filter((c) => c.machineId !== o.selfMachineId);
  const peers = others.map((m) => {
    const room = peerRoom(m, 'standard', nowMs);
    if (room.eligible && !peerAdvertisesAgentBrief(m)) return { machineId: m.machineId, nickname: m.nickname ?? null, eligible: false, reason: 'no-agent-brief' };
    return { machineId: m.machineId, nickname: m.nickname ?? null, ...room };
  });
  const base = { self, peers, target: null, targetNickname: null };
  if (!o.selfMachineId || others.length === 0) return { ...base, reason: 'no-pool' };
  if (!selfRow) return { ...base, reason: 'self-load-unknown' };
  const floorBusy = self.busyBy === 'verdict' || self.busyBy === 'memory';
  if (!floorBusy && self.verdict === null) return { ...base, reason: 'self-load-unknown' };
  const eligible = others.filter((m) => peers.find((p) => p.machineId === m.machineId)?.eligible);
  if (eligible.length === 0) return { ...base, reason: 'no-eligible-peer' };
  const exec = o.executor ?? agentSessionExecutor();
  if (floorBusy) {
    const d = exec.decide({ sessionKey: 'topic-spawn-placement', topicMetadata: {}, machineRegistry: eligible, reason: 'new', workWeight: 'standard' });
    if (d.outcome !== 'placed' || !d.chosenMachine) return { ...base, reason: `placement-${d.reason}` };
    const chosen = eligible.find((m) => m.machineId === d.chosenMachine);
    return { ...base, target: d.chosenMachine, targetNickname: chosen?.nickname ?? null, reason: `placement-${d.reason}` };
  }
  // Judgment above the floor: this machine is the sticky owner; a peer must be meaningfully less loaded.
  const d = exec.decide({ sessionKey: 'topic-spawn-placement', topicMetadata: {}, machineRegistry: [selfRow, ...eligible], currentOwner: o.selfMachineId, reason: 'new', workWeight: 'standard' });
  if (d.outcome !== 'placed' || !d.chosenMachine || d.chosenMachine === o.selfMachineId) return { ...base, reason: 'not-busy' };
  const chosen = eligible.find((m) => m.machineId === d.chosenMachine);
  if (!chosen) return { ...base, reason: 'not-busy' };
  return { ...base, target: chosen.machineId, targetNickname: chosen.nickname ?? null, reason: `placement-${d.reason}` };
}

export function agentSpawnMessageId(topicId: number | string, nonce: string): string {
  return `${AGENT_SPAWN_MESSAGE_PREFIX}${topicId}:${nonce}`;
}

export function isAgentSpawnMessageId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(AGENT_SPAWN_MESSAGE_PREFIX);
}

/** The forwarded payload's text: a reader-only header, then the brief. The header grants nothing. */
export function buildAgentTaskText(prompt: string, session: string, originNickname: string): string {
  return `[Agent task started by ${session} on ${originNickname}]\n${prompt}`;
}

export interface AgentAuthorship { kind: 'agent'; originMachineId: string; session: string }

export type ForwardedAgentTask =
  | { kind: 'none' }
  | { kind: 'agent-task'; text: string; authorship: AgentAuthorship }
  | { kind: 'refused'; reason: string };

/**
 * Classify a forwarded deliverMessage on the target. An agent task needs ALL of: an
 * `agent-spawn:` messageId, `authorship.kind: "agent"`, and `originMachineId` equal to the
 * signed envelope's sender. A message that claims agent authorship (by either sign) without
 * the rest is refused and never injected; anything else is an ordinary forwarded message.
 */
export function classifyForwardedAgentTask(messageId: unknown, payload: unknown, signedSender: string | null | undefined): ForwardedAgentTask {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  const a = p?.authorship && typeof p.authorship === 'object' && !Array.isArray(p.authorship) ? p.authorship as Record<string, unknown> : null;
  const claimsAgent = a?.kind === 'agent';
  const agentId = isAgentSpawnMessageId(messageId);
  if (!claimsAgent && !agentId) return { kind: 'none' };
  if (!agentId) return { kind: 'refused', reason: 'agent-authorship-without-agent-spawn-id' };
  if (!claimsAgent) return { kind: 'refused', reason: 'agent-spawn-id-without-agent-authorship' };
  if (typeof a!.originMachineId !== 'string' || !signedSender || a!.originMachineId !== signedSender) return { kind: 'refused', reason: 'agent-origin-mismatch' };
  if (typeof p!.text !== 'string' || p!.text.length === 0) return { kind: 'refused', reason: 'agent-task-empty' };
  const session = typeof a!.session === 'string' ? a!.session.slice(0, 200) : '';
  return { kind: 'agent-task', text: p!.text, authorship: { kind: 'agent', originMachineId: a!.originMachineId, session } };
}

// ── The origin side: one placement attempt, and the checked local fallback ──────────────────


export type TopicPlaceResult =
  | { kind: 'respond'; status: number; body: Record<string, unknown> }
  /** Start through today's local route, unchanged. */
  | { kind: 'local'; reason: string }
  /** The protocol refused before the claim, or the deliver was rejected: checked local claim + spawn. */
  | { kind: 'local-fallback'; reason: string };

export interface TopicPlaceDeps {
  svc: AgentSessionPlacementService;
  selfMachineId: string;
  nickname: (machineId: string) => string | null;
  readOwnership: (topicKey: string) => { status: string; ownerMachineId?: string | null } | null;
  ownerReachable: (machineId: string) => boolean;
  holdsLease: () => boolean;
  seamWired: () => boolean;
  decision: () => AgentPlacementDecision;
  /** Emit the replicated brief; null = no replication here. */
  emitBrief: ((rec: { topicId: number; name: string; prompt: string; placedOn: string; originMachineId: string }) => BriefEmitOutcome) | null;
  /** Record the origin's local copy (TopicSpawnBriefStore) with `placedOn`. */
  recordLocalBrief: (placedOn: string) => void;
  start: (topicKey: string, target: string, payload: { text: string; authorship: AgentAuthorship }) => Promise<StartTopicOnMachineResult>;
  /** Called just before anything is sent to a peer. */
  onSend?: () => void;
  reconcileReads?: number;
  reconcileGapMs?: number;
}

/** The 409 for the topic's current owner, when the record names another machine. */
export function ownedElsewhereAnswer(
  rec: { status: string; ownerMachineId?: string | null } | null,
  selfMachineId: string,
  nickname: (id: string) => string | null,
  ownerReachable: (id: string) => boolean,
): { status: number; body: Record<string, unknown> } | null {
  if (topicOwnershipState(rec, selfMachineId) !== 'peer' || !rec?.ownerMachineId) return null;
  const owner = rec.ownerMachineId;
  return { status: 409, body: topicOwnedElsewhereBody({ machineId: owner, nickname: nickname(owner) }, ownerReachable(owner)) };
}

/**
 * One topic-bound spawn with `placement: "auto"` (Step 2). The caller holds the name lock.
 * Order: what cannot travel → ownership → router (lease) → seam → decision → brief replicated
 * → origin brief + pending entry → place/deliver/settle. Never starts anything itself.
 */
export async function placeTopicSpawn(o: {
  name: string;
  topicId: number;
  prompt: string;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
  runningHere: boolean;
  deps: TopicPlaceDeps;
}): Promise<TopicPlaceResult> {
  const { name, topicId, deps } = o;
  const key = String(topicId);
  const store = deps.svc.deps.store;
  const own = deps.readOwnership(key);
  const ownState = topicOwnershipState(own, deps.selfMachineId);
  const row = (extra: Record<string, unknown>) => deps.svc.log({ name, topicBound: true, topicId, topicOwnership: ownState, weight: 'standard', mode: 'live', ...extra });
  const local = (reason: string): TopicPlaceResult => { row({ outcome: 'local', why: reason }); return { kind: 'local', reason }; };
  const blocker = topicTravelBlocker(o.body, o.headers);
  if (blocker) return local(blocker);
  if (o.runningHere) return local('name-running-here');
  const owned = ownedElsewhereAnswer(own, deps.selfMachineId, deps.nickname, deps.ownerReachable);
  if (owned) { row({ outcome: 'topic-owned-elsewhere' }); return { kind: 'respond', ...owned }; }
  if (ownState === 'self') return local('topic-owned-here');
  // deliverMessage is router-only (MeshRpc checkCommandRBAC): only the lease holder may send it.
  if (!deps.holdsLease()) return local('not-router');
  if (!deps.seamWired()) return local('router-not-wired');
  const d = deps.decision();
  const rowBase = { self: d.self, wouldPlaceOn: d.target, wouldPlaceOnNickname: d.targetNickname, why: d.reason };
  if (!d.target) { row({ ...rowBase, outcome: 'local' }); return { kind: 'local', reason: d.reason }; }
  if (store.isFull()) { deps.svc.reportFull(); return local('placement-store-full'); }
  const target = d.target;
  // The brief must be on the pool before the hand-off; a refused emit keeps the spawn here.
  const emitted: BriefEmitOutcome = deps.emitBrief
    ? deps.emitBrief({ topicId, name, prompt: o.prompt, placedOn: target, originMachineId: deps.selfMachineId })
    : 'brief-not-replicated';
  if (emitted !== 'emitted') { row({ ...rowBase, outcome: 'local', why: emitted }); return { kind: 'local', reason: emitted }; }
  try { deps.recordLocalBrief(target); } catch { /* @silent-fallback-ok — the replicated copy holds the brief; the local copy only feeds a later respawn */ }
  store.setPending(name, target, { topicId });
  const burst = agentSessionReservations.record(target);
  const forget = () => { store.remove(name); agentSessionReservations.release(burst); };
  const placedOn = { machineId: target, nickname: deps.nickname(target) };
  const selfNick = deps.nickname(deps.selfMachineId) ?? deps.selfMachineId;
  deps.onSend?.();
  const r = await deps.start(key, target, {
    text: buildAgentTaskText(o.prompt, name, selfNick),
    authorship: { kind: 'agent', originMachineId: deps.selfMachineId, session: name },
  });
  if (r.ok) {
    row({ ...rowBase, outcome: 'peer-accepted' });
    return {
      kind: 'respond', status: 202,
      body: {
        name, topicId, tmuxSession: null, placedOn, placementOutcome: 'peer-accepted',
        next: `The task was handed to ${placedOn.nickname ?? target}, which accepted it; the session there is named by that machine and is not confirmed started yet. Later messages in this topic go to that machine.`,
      },
    };
  }
  if (r.code === 'start-unknown') {
    // The claim is kept: a delayed delivery could still land. Nothing starts here.
    const found = await deps.svc.reconcileNow(name, target, deps.reconcileReads ?? 3, deps.reconcileGapMs ?? 5_000);
    const learned = store.get(name)?.tmuxSession ?? null;
    if (found) {
      row({ ...rowBase, outcome: 'peer-accepted-after-reconcile' });
      return { kind: 'respond', status: 202, body: { name, topicId, tmuxSession: learned, placedOn, placementOutcome: 'peer-accepted' } };
    }
    row({ ...rowBase, outcome: 'unconfirmed' });
    return {
      kind: 'respond', status: 202,
      body: {
        name, topicId, tmuxSession: null, placedOn, placementOutcome: 'unconfirmed', detail: r.error,
        next: `The hand-off to ${placedOn.nickname ?? target} did not answer clearly and the task may have started there. The topic stays claimed for that machine; do not start the same work again. This machine keeps checking and raises one attention item if it cannot confirm.`,
      },
    };
  }
  if (r.code === 'start-superseded' && r.delivered !== 'rejected') {
    // The deliver may have landed (accepted or unknown) even though the record moved
    // on. Starting locally could duplicate a session the target already started, so
    // this is handled like an unknown outcome: nothing starts here, tracking stays.
    const owned = ownedElsewhereAnswer(deps.readOwnership(key), deps.selfMachineId, deps.nickname, deps.ownerReachable);
    if (owned) { row({ ...rowBase, outcome: 'topic-owned-elsewhere' }); return { kind: 'respond', ...owned }; }
    row({ ...rowBase, outcome: 'unconfirmed' });
    return {
      kind: 'respond', status: 202,
      body: {
        name, topicId, tmuxSession: null, placedOn, placementOutcome: 'unconfirmed', detail: `start-superseded (delivered: ${r.delivered})`,
        next: `The hand-off to ${placedOn.nickname ?? target} may have started the task there, but the topic's record changed before it was confirmed. Do not start the same work again. This machine keeps checking and raises one attention item if it cannot confirm.`,
      },
    };
  }
  forget();
  if (r.code === 'topic-owned-elsewhere' || r.code === 'start-superseded') {
    const nowOwned = ownedElsewhereAnswer(deps.readOwnership(key), deps.selfMachineId, deps.nickname, deps.ownerReachable);
    if (nowOwned) { row({ ...rowBase, outcome: 'topic-owned-elsewhere' }); return { kind: 'respond', ...nowOwned }; }
    const reason = `protocol-refused:${r.code === 'topic-owned-elsewhere' ? r.reason : r.code}`;
    row({ ...rowBase, outcome: `local-fallback:${reason}` });
    return { kind: 'local-fallback', reason };
  }
  const reason = `peer-refused:${r.error}`.slice(0, 200);
  row({ ...rowBase, outcome: `local-fallback:${reason}` });
  return { kind: 'local-fallback', reason };
}

export interface LocalFallbackDeps {
  /** The dashboard's local claim (createDashboardPoolClaimOps) when this machine may claim; null otherwise. */
  claim: () => { place(sk: string): { ok: boolean; reason?: string }; confirm(sk: string): boolean; release(sk: string): boolean } | null;
  spawnForTopic: (topicId: number, name: string, task: string) => Promise<{ ok: true; session: string; registered: boolean } | { ok: false; code: string }>;
  isRunning: (tmuxSession: string) => boolean;
  readOwnership: (topicKey: string) => { status: string; ownerMachineId?: string | null } | null;
  selfMachineId: string;
  nickname: (machineId: string) => string | null;
  ownerReachable: (machineId: string) => boolean;
  /** Today's route answer for a spawn that threw. */
  answerSpawnError: (err: unknown) => { status: number; body: Record<string, unknown> };
  /** Record the brief here (placedOn = this machine). */
  recordLocalBrief: (tmuxSession: string) => void;
  log: (row: Record<string, unknown>) => void;
}

/**
 * The checked local fallback: claim the topic for THIS machine first (never the local route's
 * blind spawn), then spawn with the agent-task framing. 201 only for a running session; a lost
 * claim is 409 topic-owned-elsewhere and nothing starts.
 */
export async function runCheckedLocalFallback(o: { name: string; topicId: number; prompt: string; reason: string; deps: LocalFallbackDeps }): Promise<{ status: number; body: Record<string, unknown> }> {
  const { deps } = o;
  const key = String(o.topicId);
  const ops = deps.claim();
  if (!ops) {
    deps.log({ outcome: 'local-fallback:claim-unavailable' });
    return { status: 503, body: { error: 'local-claim-unavailable', placementOutcome: 'local-fallback', placementReason: o.reason, next: 'This machine could not claim the topic to start the task here; nothing was started. Try again shortly.' } };
  }
  const placed = ops.place(key);
  if (!placed.ok) {
    deps.log({ outcome: 'local-fallback:claim-lost' });
    const owned = ownedElsewhereAnswer(deps.readOwnership(key), deps.selfMachineId, deps.nickname, deps.ownerReachable);
    return owned ?? { status: 409, body: { ...topicOwnedElsewhereBody({ machineId: 'unknown', nickname: null }, false), claimRefused: placed.reason ?? 'place-refused' } };
  }
  let r: Awaited<ReturnType<LocalFallbackDeps['spawnForTopic']>>;
  try {
    r = await deps.spawnForTopic(o.topicId, o.name, o.prompt);
  } catch (err) {
    ops.release(key);
    deps.log({ outcome: 'local-fallback:spawn-failed' });
    return deps.answerSpawnError(err);
  }
  if (!r.ok) {
    ops.release(key);
    deps.log({ outcome: `local-fallback:${r.code}` });
    return { status: 409, body: { error: r.code, code: r.code, placementOutcome: 'local-fallback', placementReason: o.reason } };
  }
  if (!deps.isRunning(r.session)) {
    ops.release(key);
    deps.log({ outcome: 'local-fallback:not-running' });
    return { status: 500, body: { error: 'spawned-session-not-running', placementOutcome: 'local-fallback', placementReason: o.reason } };
  }
  ops.confirm(key);
  try { deps.recordLocalBrief(r.session); } catch { /* @silent-fallback-ok — the brief only feeds a later respawn */ }
  deps.log({ outcome: 'local-fallback' });
  return { status: 201, body: { name: o.name, tmuxSession: r.session, topicId: o.topicId, topicBound: true, ownership: 'claimed', placementOutcome: 'local-fallback', placementReason: o.reason } };
}
