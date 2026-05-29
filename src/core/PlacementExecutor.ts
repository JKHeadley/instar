/**
 * PlacementExecutor — the single canonical placement component (Multi-Machine
 * Session Pool §L4). Per "Structure > Willpower", placement is NOT pluggable
 * per-agent code: ALL placement decisions route through this one component, and
 * its policy is structured DATA (JSON) validated against a fixed schema — never
 * ad-hoc logic. `decide()` is PURE over its inputs (deterministic, unit-testable);
 * the CALLER (router) performs the CAS + side effects from the returned decision.
 */

import type { MachineCapacity } from './types.js';

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

export class PlacementExecutor {
  private readonly policy: PlacementPolicy;
  constructor(policy: PlacementPolicy = DEFAULT_PLACEMENT_POLICY) {
    validatePlacementPolicy(policy);
    this.policy = policy;
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
    let candidates = req.machineRegistry.filter((m) => m.online && m.clockSkewStatus !== 'suspect-clock-removed');

    for (const step of this.policy.ordering) {
      if (step === 'hard-constraint') {
        // Required capabilities.
        if (tp.requiredCapabilities && tp.requiredCapabilities.length > 0) {
          candidates = candidates.filter((m) => tp.requiredCapabilities!.every((c) => (m.capabilities ?? []).includes(c)));
          if (candidates.length === 0) {
            return { chosenMachine: null, score: 0, reason: 'no-capable-machine', outcome: 'queued', escalationReason: 'capabilities-unsatisfiable' };
          }
        }
        // Hard pin: the named machine MUST run it; queue+escalate if unavailable (never re-route).
        if (tp.pinned && tp.preferredMachine) {
          const pinned = candidates.find((m) => m.machineId === tp.preferredMachine);
          if (!pinned) {
            return { chosenMachine: null, score: 0, reason: 'hard-pin-unavailable', outcome: 'queued', escalationReason: 'hard-pin-unsatisfiable' };
          }
          return { chosenMachine: pinned.machineId, score: this.score(pinned), reason: 'hard-pin', outcome: 'placed' };
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
        return { chosenMachine: best.machineId, score: this.score(best), reason: 'least-loaded', outcome: 'placed' };
      }
    }
    // Ordering exhausted with no placement (e.g. no least-loaded step + no pin matched).
    if (candidates.length === 0) {
      return { chosenMachine: null, score: 0, reason: 'no-online-machine', outcome: 'queued', escalationReason: 'no-capable-online-machine' };
    }
    const best = candidates.reduce((a, b) => (this.score(b) < this.score(a) ? b : a), candidates[0]);
    return { chosenMachine: best.machineId, score: this.score(best), reason: 'fallback-least-loaded', outcome: 'placed' };
  }
}
