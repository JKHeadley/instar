/**
 * poolReadiness — a read-only report of whether this agent's machines could serve
 * conversations across each other (docs/specs/session-pool-default-on.md, step 1).
 *
 * Every line is a signal. Nothing reads this report to allow or block anything: it
 * writes no signed result, no config and no stage, so it cannot affect routing or
 * promotion. `ready` says the known prerequisites look met; it does not prove a real
 * placement works, which only a real test can.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isLoadReportFresh } from './machineLoadReport.js';
import { machineServesChannel, type ChannelScope, type ServesChannels } from './machineServesChannel.js';
import type { MachineCapacity } from './types.js';

export type ReadinessState = 'ok' | 'failing' | 'unknown';

export interface ReadinessLine {
  state: ReadinessState;
  reason: string;
}

export interface PeerReadiness {
  machineId: string;
  nickname?: string;
  ready: boolean;
  lines: Record<string, ReadinessLine>;
}

export interface PoolReadinessReport {
  machines: number;
  ready: boolean;
  note: string;
  thisMachine: Record<string, ReadinessLine>;
  peers: PeerReadiness[];
}

export interface PoolReadinessDeps {
  /** Non-revoked registered machines other than this one, read live. */
  peerIds: () => string[];
  capacity: (machineId: string) => MachineCapacity | null;
  ownChannels: () => ServesChannels | undefined;
  durableOwnership: () => boolean;
  duplicateCheck: () => { enabled: boolean; substrate: { ready: boolean; reason?: string } } | null;
  /** Boot-cached: 'failing' when the lease store is git with no remote. */
  takeover: () => ReadinessLine;
  now?: () => number;
}

/** Direct contact this recent counts as reachable; the same bar overload shed uses. */
export const READINESS_CONTACT_MAX_AGE_MS = 2 * 60_000;
export const READINESS_LOG_INTERVAL_MS = 60 * 60_000;

const NOTE = 'These are signals. Ready means the known prerequisites look met, not that a real conversation has been placed.';

function line(state: ReadinessState, reason: string): ReadinessLine {
  return { state, reason };
}

function contactLine(c: MachineCapacity | null): ReadinessLine {
  const l = c?.liveness;
  if (!l) return line('unknown', 'no contact evidence yet');
  if (l.source === 'direct' && l.state === 'live' && typeof l.evidenceAgeMs === 'number' && l.evidenceAgeMs <= READINESS_CONTACT_MAX_AGE_MS) {
    return line('ok', 'direct contact within 2 minutes');
  }
  return line('failing', `last evidence is ${l.state} via ${l.source}`);
}

/** The registry defaults some fields for a peer it has never reached, so only direct contact counts. */
function heardDirectly(c: MachineCapacity | null): boolean {
  return c?.liveness?.source === 'direct';
}

function clockLine(c: MachineCapacity | null): ReadinessLine {
  if (!heardDirectly(c) || !c?.clockSkewStatus) return line('unknown', 'no clock reading yet');
  return c.clockSkewStatus === 'ok' ? line('ok', 'clocks agree') : line('failing', `clock status is ${c.clockSkewStatus}`);
}

function capacityLine(c: MachineCapacity | null, nowMs: number): ReadinessLine {
  const received = c?.loadReportReceivedAt ? Date.parse(c.loadReportReceivedAt) : NaN;
  if (!c?.loadReport || !Number.isFinite(received) || !isLoadReportFresh(c.loadReport, received, nowMs)) {
    return line('unknown', 'no fresh load report');
  }
  const max = c.loadReport.sessionsMax;
  if (!(typeof max === 'number' && max > 0)) return line('failing', 'reports no session limit');
  if (c.loadVerdict === 'saturated' || c.loadVerdict === 'impaired') return line('failing', `machine is ${c.loadVerdict}`);
  if (c.loadReport.acceptingWork === false) return line('failing', 'machine is refusing new work');
  if (c.loadVerdict !== 'ok' && c.loadVerdict !== 'elevated') return line('unknown', 'load verdict not known yet');
  return line('ok', `room for sessions, load is ${c.loadVerdict}`);
}

function startLine(c: MachineCapacity | null): ReadinessLine {
  const q = c?.quotaState;
  if (!q) return line('unknown', 'no session-start signal; this cannot prove a login');
  return q.blocked ? line('failing', q.reason ?? 'sessions are blocked') : line('ok', 'no start failure seen; this cannot prove a login');
}

function channelScopes(own: ServesChannels | undefined, caps: Array<MachineCapacity | null>): ChannelScope[] {
  const chats = new Set<string>(own?.telegram?.chatIds ?? []);
  const workspaces = new Set<string>(own?.slack?.workspaceIds ?? []);
  for (const c of caps) {
    for (const id of c?.servesChannels?.telegram?.chatIds ?? []) chats.add(id);
    for (const id of c?.servesChannels?.slack?.workspaceIds ?? []) workspaces.add(id);
  }
  return [
    ...[...chats].map((chatId): ChannelScope => ({ platform: 'telegram', chatId })),
    ...[...workspaces].map((workspaceId): ChannelScope => ({ platform: 'slack', workspaceId })),
  ];
}

function channelLine(c: MachineCapacity | null, scopes: ChannelScope[]): ReadinessLine {
  if (scopes.length === 0) return line('unknown', 'no machine reports a channel');
  if (!heardDirectly(c)) return line('unknown', 'peer not reached yet');
  // A peer that is reachable and reports no channels cannot answer: absent is `no` here,
  // unlike placement, which stays open for older peers during a rolling update.
  const missing = scopes.filter((s) => machineServesChannel(c?.servesChannels ?? {}, s) !== 'yes');
  if (missing.length === 0) return line('ok', 'serves every channel this agent uses');
  // Name the platform: "1 of 2" read as "this machine cannot answer" when it was only Slack.
  const platforms = [...new Set(missing.map((s) => s.platform))].join(', ');
  return line('failing', `cannot serve ${missing.length} of ${scopes.length} channels (${platforms})`);
}

function followUpLine(c: MachineCapacity | null): ReadinessLine {
  const flag = c?.seamlessnessFlags?.ws11DeliverReceive;
  if (flag === undefined) return line('unknown', 'peer has not reported this');
  return flag ? line('ok', 'can receive follow-up messages') : line('failing', 'follow-up messages cannot reach it');
}

export const SINGLE_MACHINE_READINESS = { machines: 1, ready: false, reason: 'single-machine' } as const;

export function computePoolReadiness(d: PoolReadinessDeps): PoolReadinessReport | typeof SINGLE_MACHINE_READINESS {
  const nowMs = d.now?.() ?? Date.now();
  const ids = d.peerIds();
  if (ids.length === 0) return SINGLE_MACHINE_READINESS;
  const caps = ids.map((id) => d.capacity(id));
  const dup = d.duplicateCheck();
  const thisMachine = {
    takeover: d.takeover(),
    ownership: d.durableOwnership() ? line('ok', 'ownership survives a restart') : line('failing', 'ownership is held in memory'),
    duplicateCheck: !dup
      ? line('unknown', 'duplicate detector not built')
      : dup.enabled && dup.substrate.ready
        ? line('ok', 'duplicate detector can run')
        : line('failing', dup.enabled ? `not ready: ${dup.substrate.reason ?? 'unknown'}` : 'duplicate detector is off'),
  };
  const scopes = channelScopes(d.ownChannels(), caps);
  const peers = ids.map((machineId, i): PeerReadiness => {
    const c = caps[i];
    const lines = {
      contact: contactLine(c),
      clock: clockLine(c),
      capacity: capacityLine(c, nowMs),
      noStartFailure: startLine(c),
      channels: channelLine(c, scopes),
      followUps: followUpLine(c),
    };
    return { machineId, ...(c?.nickname ? { nickname: c.nickname } : {}), ready: Object.values(lines).every((l) => l.state === 'ok'), lines };
  });
  // Takeover belongs to a later step, so it is reported but does not count toward ready.
  const localOk = thisMachine.ownership.state === 'ok' && thisMachine.duplicateCheck.state === 'ok';
  return { machines: ids.length + 1, ready: localOk && peers.some((p) => p.ready), note: NOTE, thisMachine, peers };
}

/** Appends one row an hour while the agent has peers. Writes nothing else. */
export class PoolReadinessLog {
  private lastAt = 0;
  constructor(private readonly d: PoolReadinessDeps, private readonly filePath: string) {}

  /** Called on the 30-second pool beat. Never throws into that beat. */
  tick(): void {
    const nowMs = this.d.now?.() ?? Date.now();
    if (nowMs - this.lastAt < READINESS_LOG_INTERVAL_MS) return;
    try {
      if (this.d.peerIds().length === 0) return;
      const report = computePoolReadiness(this.d);
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify({ at: new Date(nowMs).toISOString(), ...report, note: undefined })}\n`);
      this.lastAt = nowMs;
    } catch (err) {
      // @silent-fallback-ok: a history row is a signal, and the pool beat must keep running.
      console.warn(`[pool-readiness] log row failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

let active: PoolReadinessDeps | null = null;
export function setActivePoolReadiness(d: PoolReadinessDeps | null): void { active = d; }
export function getActivePoolReadiness(): PoolReadinessDeps | null { return active; }
