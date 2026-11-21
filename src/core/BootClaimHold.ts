/**
 * BootClaimHold — the boot claim safety rules (docs/specs/takeover-ready-pool.md R1,
 * fb-2bf6ccd0-705). Pure: no I/O, no clock, so every boundary is unit-testable.
 *
 * From process start until the hold ends, a machine does not claim the lease:
 *   1. If its own record says it held last, it pulls before any claim (LeaseCoordinator).
 *   2. A machine that is not the named preferred machine and has reached no peer defers.
 *   3. While the named preferred machine answers at all, the deferring machine never claims.
 *      An unsigned answer (Instar's own response marker on a Tailscale or named-tunnel
 *      endpoint) counts only for a bounded window; after it only a signed reply counts.
 *   4. The hold ends when a peer's view names a live holder or a strictly newer epoch than
 *      this machine's own record, or when the preferred machine (every known peer, when none
 *      is named or this machine is the preferred one) has been silent on at least
 *      `silentProbes` probes spanning at least `silentSpanMs`. With no preferred machine
 *      named, a peer that gave a signed answer whose view names no live holder is a peer
 *      that is not holding, so it is settled too.
 *
 * After the hold the normal acquisition rules still require the holder's lease to have
 * lapsed: ending the hold is never by itself permission to claim.
 */

import { resolveDevAgentGate } from './devAgentGate.js';

/** What one probe of one peer produced. */
export type ProbeAnswer = 'signed' | 'unsigned' | 'silent';

export interface PeerProbe {
  atMs: number;
  answer: ProbeAnswer;
}

/** The compact per-peer probe record the transport keeps. */
export interface PeerProbeRecord {
  /** Most recent probes, oldest first (bounded tail). */
  probes: PeerProbe[];
  /** Start of the current run of unsigned answers since the last signed one (null = none). */
  unsignedSinceMs: number | null;
  /**
   * First signed answer since boot (null = none yet). Never reset, so a peer that keeps
   * answering without ever claiming cannot hold others back for ever.
   */
  firstSignedAtMs?: number | null;
}

export interface BootHoldSettings {
  /** Silent probes needed to end the hold. Default 3. */
  silentProbes: number;
  /** Minimum first-to-last span of those silent probes. Default 45 s. */
  silentSpanMs: number;
}

export const DEFAULT_BOOT_HOLD_SETTINGS: BootHoldSettings = { silentProbes: 3, silentSpanMs: 45_000 };

/** Interim unsigned-answer window until the preferred machine publishes its restart time (R5). */
export const INTERIM_UNSIGNED_ANSWER_WINDOW_MS = 45_000 + 3 * 60_000;
const UNSIGNED_WINDOW_FLOOR_MS = 45_000;
const UNSIGNED_WINDOW_CEILING_MS = 10 * 60_000;
const UNSIGNED_WINDOW_SLACK_MS = 60_000;

/**
 * How long an unsigned answer from a peer keeps counting as an answer: its published restart
 * time (p95) plus 60 s, floored at 45 s and capped at 10 minutes; the interim value when the
 * peer has published none.
 */
export function unsignedAnswerWindowMs(restartBudgetMs: number | null | undefined): number {
  if (typeof restartBudgetMs !== 'number' || !Number.isFinite(restartBudgetMs) || restartBudgetMs < 0) {
    return INTERIM_UNSIGNED_ANSWER_WINDOW_MS;
  }
  return Math.min(UNSIGNED_WINDOW_CEILING_MS, Math.max(UNSIGNED_WINDOW_FLOOR_MS, restartBudgetMs + UNSIGNED_WINDOW_SLACK_MS));
}

/** A probe's answer once the unsigned window is applied: an unsigned answer past it is silence. */
export function effectiveAnswer(probe: PeerProbe, unsignedSinceMs: number | null, windowMs: number): ProbeAnswer {
  if (probe.answer !== 'unsigned') return probe.answer;
  if (unsignedSinceMs !== null && probe.atMs - unsignedSinceMs > windowMs) return 'silent';
  return 'unsigned';
}

export type PeerState =
  /** Never probed since boot. */
  | 'unprobed'
  /** The last probe was a signed answer. */
  | 'answered-signed'
  /** The last probe was an unsigned answer still inside its window. */
  | 'answering-unsigned'
  /** Silent, but not yet long enough. */
  | 'silent-pending'
  /** Silent on enough probes over a long enough span. */
  | 'silent-enough';

export function classifyPeer(record: PeerProbeRecord | undefined, windowMs: number, settings: BootHoldSettings): PeerState {
  const probes = record?.probes ?? [];
  if (probes.length === 0) return 'unprobed';
  const unsignedSince = record?.unsignedSinceMs ?? null;
  const last = probes[probes.length - 1];
  const lastAnswer = effectiveAnswer(last, unsignedSince, windowMs);
  if (lastAnswer === 'signed') return 'answered-signed';
  if (lastAnswer === 'unsigned') return 'answering-unsigned';
  // Tail run of silent probes (an unsigned answer past its window is silence).
  let count = 0;
  let firstAt = last.atMs;
  for (let i = probes.length - 1; i >= 0; i--) {
    if (effectiveAnswer(probes[i], unsignedSince, windowMs) !== 'silent') break;
    count++;
    firstAt = probes[i].atMs;
  }
  return count >= settings.silentProbes && last.atMs - firstAt >= settings.silentSpanMs ? 'silent-enough' : 'silent-pending';
}

export interface BootHoldInput {
  /** Same clock as the probe timestamps. */
  nowMs: number;
  selfMachineId: string;
  /** The named preferred machine, or null when none is named. */
  preferredMachineId: string | null;
  /** Peers this machine can probe (dialable, not revoked, not self). */
  knownPeers: string[];
  /** Per-peer probe records since boot. */
  probes: ReadonlyMap<string, PeerProbeRecord>;
  /** A peer's view (or a fetched shared store) named a live holder or a strictly newer epoch. */
  newerViewSeen: boolean;
  /** The unsigned-answer window for one peer. */
  windowMsFor: (peerId: string) => number;
  settings?: BootHoldSettings;
}

export interface BootHoldVerdict {
  hold: boolean;
  /** The rule that decided: rule-2, rule-3, rule-4, or the reason the hold ended. */
  rule: string;
  reason: string;
}

export function evaluateBootHold(input: BootHoldInput): BootHoldVerdict {
  const settings = input.settings ?? DEFAULT_BOOT_HOLD_SETTINGS;
  if (input.newerViewSeen) {
    return { hold: false, rule: 'rule-4', reason: 'a peer view names a live holder or a newer epoch' };
  }
  const peers = input.knownPeers.filter((p) => p !== input.selfMachineId);
  if (peers.length === 0) return { hold: false, rule: 'rule-4', reason: 'no known peer to ask' };

  const pref = input.preferredMachineId;
  const selfIsPreferred = !!pref && pref === input.selfMachineId;
  const deferToPreferred = !!pref && !selfIsPreferred && peers.includes(pref);
  const states = new Map(peers.map((p) => [p, classifyPeer(input.probes.get(p), input.windowMsFor(p), settings)]));
  /**
   * An awaited peer is one this machine lets claim first: the preferred machine, or (with none
   * named and reachable) an answering peer with a lower machine id, the pool's usual tie-break,
   * so two machines restarting together do not claim the same epoch. The preferred machine
   * itself awaits no one. A signed answer from an awaited peer that names no live holder (a
   * live holder would already have ended the hold) holds only for that peer's own restart
   * window plus the silence span, counted from its first signed answer: a peer that answers
   * but cannot claim (observe-only, held back, ineligible) never keeps the pool without a holder.
   */
  const awaited = (p: string): boolean => (selfIsPreferred ? false : deferToPreferred ? p === pref : p < input.selfMachineId);
  const signedHoldExpired = (p: string): boolean => {
    const first = input.probes.get(p)?.firstSignedAtMs;
    return typeof first === 'number' && input.nowMs - first > input.windowMsFor(p) + settings.silentSpanMs;
  };
  const settled = (p: string): boolean => {
    const s = states.get(p)!;
    if (s === 'silent-enough') return true;
    if (s === 'answered-signed') return !awaited(p) || signedHoldExpired(p);
    return false;
  };

  if (deferToPreferred) {
    const s = states.get(pref!)!;
    if (settled(pref!)) {
      return {
        hold: false,
        rule: 'rule-4',
        reason: s === 'silent-enough'
          ? `preferred machine ${pref} silent on ${settings.silentProbes}+ probes over ${settings.silentSpanMs} ms`
          : `preferred machine ${pref} answers but has not claimed within its restart window`,
      };
    }
    if (s === 'answered-signed' || s === 'answering-unsigned') {
      return { hold: true, rule: 'rule-3', reason: `preferred machine ${pref} answers (${s})` };
    }
    const reachedAny = [...states.values()].some((v) => v === 'answered-signed' || v === 'answering-unsigned');
    if (!reachedAny) return { hold: true, rule: 'rule-2', reason: `no peer reached yet; preferred machine ${pref} ${s}` };
    return { hold: true, rule: 'rule-4', reason: `waiting for preferred machine ${pref} (${s})` };
  }

  const unsettled = peers.filter((p) => !settled(p));
  if (unsettled.length === 0) {
    return { hold: false, rule: 'rule-4', reason: 'every known peer answered without a live holder or stayed silent long enough' };
  }
  const reachedAny = [...states.values()].some((v) => v === 'answered-signed' || v === 'answering-unsigned');
  if (!reachedAny && !selfIsPreferred) {
    return { hold: true, rule: 'rule-2', reason: `no peer reached yet (${unsettled.map((p) => `${p}:${states.get(p)}`).join(', ')})` };
  }
  return { hold: true, rule: 'rule-4', reason: `waiting for ${unsettled.map((p) => `${p}:${states.get(p)}`).join(', ')}` };
}

/** Instar's response marker: a peer-bound fingerprint, not the machine id itself. */
export const INSTAR_MACHINE_HEADER = 'x-instar-machine';

/** True for a tunnel edge speaking for a dead origin (Cloudflare 52x and 530). */
export function isTunnelEdgeStatus(status: number): boolean {
  return (status >= 520 && status <= 529) || status === 530;
}

/** Only machine-bound transports can carry an unsigned answer: Tailscale or a named tunnel. */
export function endpointCarriesUnsignedAnswer(kind: string | undefined, url: string): boolean {
  if (kind === 'tailscale') return true;
  if (kind === 'cloudflare') {
    try {
      return !new URL(url).hostname.toLowerCase().endsWith('trycloudflare.com');
    } catch {
      return false; // @silent-fallback-ok: an unparseable URL is not a named tunnel, so its answers do not count
    }
  }
  return false;
}

/**
 * Resolve the boot claim safety switch from the agent config, read live. `takeoverReadyPool.enabled:
 * false` is the rollback for the whole project; otherwise the switch rides the development-agent
 * gate (live on a development agent, dark on the fleet) unless set explicitly.
 */
export function resolveBootClaimSafety(config: {
  developmentAgent?: boolean;
  multiMachine?: {
    takeoverReadyPool?: { enabled?: boolean; bootClaimSafety?: { enabled?: boolean; silentProbes?: number; silentSpanMs?: number } };
    leaseSelfHeal?: { preferredAwakeMachineId?: string | null };
  };
} | undefined): { enabled: boolean; preferredMachineId: string | null; silentProbes?: number; silentSpanMs?: number } {
  const pool = config?.multiMachine?.takeoverReadyPool;
  const part = pool?.bootClaimSafety;
  const enabled = pool?.enabled === false ? false : resolveDevAgentGate(part?.enabled ?? pool?.enabled, config);
  const pref = config?.multiMachine?.leaseSelfHeal?.preferredAwakeMachineId;
  return {
    enabled,
    preferredMachineId: typeof pref === 'string' && pref.length > 0 ? pref : null,
    ...(typeof part?.silentProbes === 'number' && part.silentProbes >= 1 ? { silentProbes: Math.floor(part.silentProbes) } : {}),
    ...(typeof part?.silentSpanMs === 'number' && part.silentSpanMs >= 0 ? { silentSpanMs: part.silentSpanMs } : {}),
  };
}
