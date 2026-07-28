/**
 * PlacementExecutor — the single canonical placement component (Multi-Machine
 * Session Pool §L4). Per "Structure > Willpower", placement is NOT pluggable
 * per-agent code: ALL placement decisions route through this one component, and
 * its policy is structured DATA (JSON) validated against a fixed schema — never
 * ad-hoc logic. `decide()` is PURE over its inputs (deterministic, unit-testable);
 * the CALLER (router) performs the CAS + side effects from the returned decision.
 */

import type { MachineCapacity } from './types.js';
import { machineServesChannel } from './machineServesChannel.js';

/** Per-topic placement metadata (persisted with the topic; §L4). */
export interface TopicPlacement {
  /** A specific machine the session prefers / is pinned to (nickname-resolved → machineId). */
  preferredMachine?: string;
  /** Hard capability requirements (e.g. "gpu", "local-model:llama3"). */
  requiredCapabilities?: string[];
  /** When true + preferredMachine set → a HARD pin (queue+escalate if that machine is unavailable). */
  pinned?: boolean;
  lastTransferredAt?: number;
  queueReason?: string;
}

export interface PlacementPolicy {
  weights: { loadAvg: number; activeSessionRatio: number; memPressure: number };
  thresholds: { rebalanceThresholdPercent: number; placementHysteresisDelta: number };
  capabilityWhitelist: string[];
  ordering: Array<'hard-constraint' | 'pin' | 'sticky' | 'least-loaded'>;
}

export const DEFAULT_PLACEMENT_POLICY: PlacementPolicy = {
  weights: { loadAvg: 1.0, activeSessionRatio: 1.0, memPressure: 0.5 },
  thresholds: { rebalanceThresholdPercent: 0.85, placementHysteresisDelta: 0.15 },
  capabilityWhitelist: ['gpu', 'fast-cpu', 'sessions', 'jobs', 'telegram', 'tunnel'],
  ordering: ['hard-constraint', 'pin', 'sticky', 'least-loaded'],
};

export interface PlacementRequest {
  sessionKey: string;
  topicMetadata: TopicPlacement;
  machineRegistry: MachineCapacity[];
  currentOwner?: string;
  reason: 'new' | 'failover' | 'rebalance' | 'pin';
  /** The channel scope (platform + telegram chatId / slack workspaceId + channelId) this placement
   *  is for — threaded from the caller so placement can avoid a machine whose adapter can't reach it
   *  (spec: placement-platform-workspace-aware). Absent (legacy caller) → every machine resolves
   *  `unknown` → the platform/workspace filter no-ops (fail-open). The FAILOVER caller MUST pass it
   *  (the live-test bug was a failover placement). */
  channel?: import('./machineServesChannel.js').ChannelScope & { channelId?: string };
}

export interface PlacementDecision {
  chosenMachine: string | null;
  score: number;
  reason: string;
  outcome: 'placed' | 'queued' | 'placement-blocked';
  escalationReason?: string;
}

/**
 * Validate a PlacementPolicy against the fixed schema (§L4). Throws on a malformed
 * policy — unknown weight key, non-numeric threshold/weight, or a capability token
 * outside the whitelist vocabulary — so a router refuses to act with a bad policy
 * (never silently defaulted). Called at startup.
 */
export function validatePlacementPolicy(policy: unknown): asserts policy is PlacementPolicy {
  const p = policy as PlacementPolicy;
  if (!p || typeof p !== 'object') throw new Error('PlacementPolicy must be an object');
  const wKeys = ['loadAvg', 'activeSessionRatio', 'memPressure'];
  if (!p.weights || typeof p.weights !== 'object') throw new Error('PlacementPolicy.weights required');
  for (const k of Object.keys(p.weights)) {
    if (!wKeys.includes(k)) throw new Error(`PlacementPolicy.weights: unknown key '${k}'`);
  }
  for (const k of wKeys) {
    if (typeof (p.weights as Record<string, unknown>)[k] !== 'number') throw new Error(`PlacementPolicy.weights.${k} must be a number`);
  }
  if (!p.thresholds || typeof p.thresholds.rebalanceThresholdPercent !== 'number' || typeof p.thresholds.placementHysteresisDelta !== 'number') {
    throw new Error('PlacementPolicy.thresholds.{rebalanceThresholdPercent,placementHysteresisDelta} must be numbers');
  }
  if (!Array.isArray(p.capabilityWhitelist) || p.capabilityWhitelist.some((c) => typeof c !== 'string')) {
    throw new Error('PlacementPolicy.capabilityWhitelist must be string[]');
  }
  const validSteps = ['hard-constraint', 'pin', 'sticky', 'least-loaded'];
  if (!Array.isArray(p.ordering) || p.ordering.some((s) => !validSteps.includes(s))) {
    throw new Error(`PlacementPolicy.ordering must be a subset of ${validSteps.join(',')}`);
  }
}

/** Validate per-topic placement metadata on read (§L4) — never infer/sanitize; block+escalate on a violation. */
export function validateTopicPlacement(tp: unknown, capabilityWhitelist: string[]): { ok: true } | { ok: false; reason: string } {
  if (tp == null) return { ok: true };
  if (typeof tp !== 'object') return { ok: false, reason: 'topic-metadata-not-object' };
  const t = tp as Record<string, unknown>;
  if ('preferredMachine' in t && t.preferredMachine != null && (typeof t.preferredMachine !== 'string' || !/^[\w-]+$/.test(t.preferredMachine))) {
    return { ok: false, reason: 'preferredMachine-invalid' };
  }
  if ('pinned' in t && t.pinned != null && typeof t.pinned !== 'boolean') return { ok: false, reason: 'pinned-not-boolean' };
  // A hard pin (pinned:true) is meaningless without a target machine — reject it rather
  // than silently treating it as unpinned (which would let placement drift off the
  // machine the user explicitly pinned to). (2026-05-29 pre-merge review.)
  if (t.pinned === true && (t.preferredMachine == null || t.preferredMachine === '')) {
    return { ok: false, reason: 'pinned-without-target' };
  }
  if ('requiredCapabilities' in t && t.requiredCapabilities != null) {
    if (!Array.isArray(t.requiredCapabilities)) return { ok: false, reason: 'requiredCapabilities-not-array' };
    for (const c of t.requiredCapabilities) {
      if (typeof c !== 'string' || !capabilityWhitelist.includes(c)) return { ok: false, reason: `capability-not-whitelisted:${String(c)}` };
    }
  }
  return { ok: true };
}

const MEM_PRESSURE_NUM: Record<string, number> = { low: 0, moderate: 1, high: 2, critical: 3 };

/**
 * U4.1 §2E (R-r2-2) optional seams. `sustainedOnline`: the hard-pin fulfilment
 * hysteresis — a pinned placement proceeds only when the pinned machine has
 * been CONTINUOUSLY online for the sustained window (a flapping machine never
 * triggers ping-pong). A machine failing the gate makes the hard pin
 * `hard-pin-unavailable` → QUEUED (the shipped queued-never-rerouted contract —
 * placement never drifts to another machine because the pinned one flapped).
 * Absent ⇒ plain-online eligibility (today's exact behavior).
 */
export interface PlacementExecutorSeams {
  sustainedOnline?: (machineId: string) => boolean;
}

export class PlacementExecutor {
  private readonly policy: PlacementPolicy;
  private readonly seams: PlacementExecutorSeams;
  constructor(policy: PlacementPolicy = DEFAULT_PLACEMENT_POLICY, seams: PlacementExecutorSeams = {}) {
    validatePlacementPolicy(policy);
    this.policy = policy;
    this.seams = seams;
  }

  /** Score a candidate (lower = better): weighted load + session-ratio + mem pressure. */
  private score(m: MachineCapacity): number {
    const w = this.policy.weights;
    const load = m.loadAvg ?? 0;
    const ratio = m.maxSessions && m.maxSessions > 0 ? (m.activeSessionCount ?? 0) / m.maxSessions : 0;
    const mem = MEM_PRESSURE_NUM[m.memPressure ?? 'low'] ?? 0;
    return w.loadAvg * load + w.activeSessionRatio * ratio + w.memPressure * mem;
  }

  /** Pure placement decision (§L4). Deterministic over its inputs. */
  decide(req: PlacementRequest): PlacementDecision {
    // 0. Validate the topic metadata on read — never mis-place on corrupt metadata.
    const v = validateTopicPlacement(req.topicMetadata, this.policy.capabilityWhitelist);
    if (!v.ok) {
      return { chosenMachine: null, score: 0, reason: 'topic-metadata-invalid', outcome: 'placement-blocked', escalationReason: v.reason };
    }
    const tp = req.topicMetadata ?? {};
    // Eligible = online (clock-ok machines are already excluded upstream via the registry,
    // but we also honor an explicit offline flag here for determinism).
    let eligible = req.machineRegistry.filter((m) => m.online && m.clockSkewStatus !== 'suspect-clock-removed');

    // Quota gate (2026-06-05, quota-aware placement): a machine whose LLM
    // account is blocked (provider block in effect / 5-hour window exhausted,
    // self-reported in its capacity heartbeat) cannot do the work a NEW
    // placement needs — placing a topic there is silence the user has to
    // discover. Drop quota-blocked machines from the candidate pool UNLESS
    // every otherwise-eligible machine is blocked (placing somewhere beats
    // placing nowhere; the decision carries escalationReason so the caller can
    // surface it). A HARD PIN still wins below — the user's explicit pin is
    // honored on a blocked machine, with the reason saying so. Absent
    // quotaState (older heartbeats) = not blocked.
    const quotaOk = eligible.filter((m) => m.quotaState?.blocked !== true);
    const allQuotaBlocked = eligible.length > 0 && quotaOk.length === 0;
    let candidates = allQuotaBlocked ? eligible : quotaOk;
    const quotaNote = allQuotaBlocked ? 'all-machines-quota-blocked' : undefined;

    // Platform/workspace reachability gate (spec: placement-platform-workspace-aware).
    // A machine whose adapter is NOT connected to this channel's platform/workspace
    // STRUCTURALLY cannot serve it — placing there is a permanent black-hole (the live-test
    // Slack bug: the channel's workspace was on a machine connected to a DIFFERENT workspace).
    // Three-valued (machineServesChannel): drop only KNOWN-`no` machines; an absent/legacy
    // signal is `unknown` → fail-open. Rank `yes` ABOVE `unknown` so a missing signal can never
    // OUTRANK a known-reachable machine by load and recreate the black-hole. If EVERY candidate
    // is `no`, the channel is structurally unservable → `queued` + `no-machine-serves-channel`
    // (the existing unsatisfiable contract — same shape as no-capable-machine; the consumer raises
    // ONE deduped Attention item keyed on the channel) — NEVER a black-hole pick. Absent req.channel
    // (legacy caller) → every machine `unknown` → this gate is a no-op (fail-open).
    if (req.channel) {
      const serveOf = (m: MachineCapacity) => machineServesChannel(m.servesChannels, req.channel);
      const yes = candidates.filter((m) => serveOf(m) === 'yes');
      const unknown = candidates.filter((m) => serveOf(m) === 'unknown');
      const serveCandidates = yes.length > 0 ? yes : unknown; // yes-over-unknown ranking
      if (serveCandidates.length > 0) {
        candidates = serveCandidates;
      } else if (candidates.length > 0) {
        // every quota-ok candidate STRUCTURALLY cannot serve this channel.
        return { chosenMachine: null, score: 0, reason: 'no-machine-serves-channel', outcome: 'queued', escalationReason: 'no-machine-serves-channel' };
      }
      // Narrow `eligible` too so the hard-pin path refuses a pin to a structural-`no` machine
      // (→ hard-pin-unsatisfiable via the existing hard-pin-unavailable branch) instead of
      // honoring it onto a non-serving machine. A pin to an `unknown` machine stays honored (fail-open).
      eligible = eligible.filter((m) => serveOf(m) !== 'no');
    }

    for (const step of this.policy.ordering) {
      if (step === 'hard-constraint') {
        // Required capabilities.
        if (tp.requiredCapabilities && tp.requiredCapabilities.length > 0) {
          const capOk = (m: MachineCapacity): boolean => tp.requiredCapabilities!.every((c) => (m.capabilities ?? []).includes(c));
          candidates = candidates.filter(capOk);
          eligible = eligible.filter(capOk); // the pin path below is quota-blind but never capability-blind
          if (candidates.length === 0) {
            return { chosenMachine: null, score: 0, reason: 'no-capable-machine', outcome: 'queued', escalationReason: 'capabilities-unsatisfiable' };
          }
        }
        // Hard pin: the named machine MUST run it; queue+escalate if unavailable (never re-route).
        // Quota-blind by design — the user's explicit pin beats the quota gate;
        // the decision reason carries the quota note so the caller can surface it.
        if (tp.pinned && tp.preferredMachine) {
          const pinned = eligible.find((m) => m.machineId === tp.preferredMachine);
          // U4.1 §2E (i): fulfilment requires SUSTAINED online — a pinned machine
          // that only just flapped back on is treated as unavailable (→ QUEUED,
          // never re-routed; the same honest contract as offline). Absent seam /
          // seam fault ⇒ plain-online (today's behavior — fail toward placement).
          let sustainedOk = true;
          if (pinned && this.seams.sustainedOnline) {
            try { sustainedOk = this.seams.sustainedOnline(pinned.machineId); } catch { sustainedOk = true; /* @silent-fallback-ok — a broken hysteresis signal degrades to plain-online eligibility (today's exact behavior): fail toward PLACEMENT, never a wedged pin (U4.1 §2E) */ }
          }
          if (!pinned || !sustainedOk) {
            return { chosenMachine: null, score: 0, reason: 'hard-pin-unavailable', outcome: 'queued', escalationReason: 'hard-pin-unsatisfiable' };
          }
          return {
            chosenMachine: pinned.machineId, score: this.score(pinned),
            reason: 'hard-pin', outcome: 'placed',
            escalationReason: pinned.quotaState?.blocked === true ? 'pinned-machine-quota-blocked' : undefined,
          };
        }
      } else if (step === 'pin') {
        // Soft preference: prefer the named machine if eligible; else fall through (degrade).
        if (tp.preferredMachine) {
          const pref = candidates.find((m) => m.machineId === tp.preferredMachine);
          if (pref) return { chosenMachine: pref.machineId, score: this.score(pref), reason: 'preference', outcome: 'placed' };
        }
      } else if (step === 'sticky') {
        // Keep the current owner unless it's under pressure (hysteresis) or being rebalanced.
        if (req.currentOwner && req.reason !== 'rebalance') {
          const cur = candidates.find((m) => m.machineId === req.currentOwner);
          if (cur) {
            const best = candidates.reduce((a, b) => (this.score(b) < this.score(a) ? b : a), candidates[0]);
            // Stick unless a meaningfully-better machine exists (hysteresis margin).
            if (this.score(cur) <= this.score(best) + this.policy.thresholds.placementHysteresisDelta) {
              return { chosenMachine: cur.machineId, score: this.score(cur), reason: 'sticky', outcome: 'placed' };
            }
          }
        }
      } else if (step === 'least-loaded') {
        if (candidates.length === 0) {
          return { chosenMachine: null, score: 0, reason: 'no-online-machine', outcome: 'queued', escalationReason: 'no-capable-online-machine' };
        }
        const best = candidates.reduce((a, b) => (this.score(b) < this.score(a) ? b : a), candidates[0]);
        return { chosenMachine: best.machineId, score: this.score(best), reason: 'least-loaded', outcome: 'placed', escalationReason: quotaNote };
      }
    }
    // Ordering exhausted with no placement (e.g. no least-loaded step + no pin matched).
    if (candidates.length === 0) {
      return { chosenMachine: null, score: 0, reason: 'no-online-machine', outcome: 'queued', escalationReason: 'no-capable-online-machine' };
    }
    const best = candidates.reduce((a, b) => (this.score(b) < this.score(a) ? b : a), candidates[0]);
    return { chosenMachine: best.machineId, score: this.score(best), reason: 'fallback-least-loaded', outcome: 'placed', escalationReason: quotaNote };
  }
}
