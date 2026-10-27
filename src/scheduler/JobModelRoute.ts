/**
 * A job model pin is an optimization, never an execution prerequisite.
 * The caller supplies cached, machine-local evidence at dispatch. Unknown evidence
 * keeps the job on its existing default route.
 */
import type { IntelligenceFramework } from '../core/intelligenceProviderFactory.js';
import { hashBody } from './AgentMdLockFile.js';

export interface JobModelPin {
  slug?: string;
  framework?: IntelligenceFramework;
  frameworkModel?: string;
  toolAllowlist?: string[] | '*' | null;
}

export interface JobRouteEvidence {
  /** Code-owned rollout gate and current machine's enabled frameworks. */
  enabled: boolean;
  /** Benchmark, per-attempt records, outcome grading and bulk export are wired. */
  auditReady: boolean;
  enabledFrameworks: ReadonlySet<IntelligenceFramework>;
  /** A missing value means the cached snapshot is unknown. */
  binaryAvailable?: boolean;
  doorwayReachable?: boolean;
  poolUsable?: boolean;
  routeBreakerClosed?: boolean;
  /** A current benchmark for this exact job body and model. */
  benchmarkCurrent?: boolean;
  /** Codex only: all installed hooks are trusted at their current hashes. */
  codexHooksArmed?: boolean;
  /** Codex only: current runtime, guard config, hooks and slot passed the deny canary. */
  codexDenyCanaryCurrent?: boolean;
}

export type JobRouteDecision =
  | { routeBasis: 'default'; reason: 'no-pin' }
  | { routeBasis: 'fallback'; reason: string }
  | { routeBasis: 'bench'; framework: IntelligenceFramework; model: string };

export interface JobBenchmarkMirror {
  tasks?: Record<string, {
    benchedPromptHash?: string;
    perModel?: Record<string, unknown>;
  }>;
}

/** A pin is tied to the exact current body and model, never a task name alone. */
export function isJobPinBenchmarkCurrent(
  slug: string,
  body: string,
  model: string,
  mirror: JobBenchmarkMirror | null | undefined,
): boolean {
  const task = mirror?.tasks?.[`job:${slug}`];
  if (!task || !task.perModel || !Object.hasOwn(task.perModel, model)) return false;
  const expected = hashBody(body).slice('sha256:'.length);
  return task.benchedPromptHash === expected;
}

/** Pure decision seam: callers never skip a run because a pin is unusable. */
export function decideJobModelRoute(pin: JobModelPin, evidence: JobRouteEvidence): JobRouteDecision {
  if (pin.framework === undefined && pin.frameworkModel === undefined) {
    return { routeBasis: 'default', reason: 'no-pin' };
  }
  if (!pin.framework || !pin.frameworkModel ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(pin.frameworkModel)) {
    return { routeBasis: 'fallback', reason: 'incomplete-pin' };
  }
  if (!evidence.enabled) return { routeBasis: 'fallback', reason: 'routing-disabled' };
  if (!evidence.auditReady) return { routeBasis: 'fallback', reason: 'audit-not-ready' };
  if (pin.slug === 'bench-refresh') return { routeBasis: 'fallback', reason: 'benchmark-job-cannot-self-pin' };
  if (!evidence.benchmarkCurrent) return { routeBasis: 'fallback', reason: 'benchmark-missing-or-stale' };
  if (!evidence.enabledFrameworks.has(pin.framework)) return { routeBasis: 'fallback', reason: 'framework-disabled' };
  if (!evidence.binaryAvailable) return { routeBasis: 'fallback', reason: 'binary-unavailable-or-unknown' };
  if (!evidence.doorwayReachable) return { routeBasis: 'fallback', reason: 'doorway-unreachable-or-unknown' };
  if (!evidence.poolUsable) return { routeBasis: 'fallback', reason: 'pool-unusable-or-unknown' };
  if (!evidence.routeBreakerClosed) return { routeBasis: 'fallback', reason: 'route-breaker-open-or-unknown' };
  if (pin.framework === 'codex-cli') {
    if (pin.toolAllowlist !== '*') return { routeBasis: 'fallback', reason: 'codex-tool-allowlist' };
    if (!evidence.codexHooksArmed) return { routeBasis: 'fallback', reason: 'codex-hooks-unarmed-or-unknown' };
    if (!evidence.codexDenyCanaryCurrent) return { routeBasis: 'fallback', reason: 'codex-deny-canary-missing-or-stale' };
  } else if (pin.framework !== 'claude-code') {
    return { routeBasis: 'fallback', reason: 'framework-not-supported-for-job-pins' };
  }
  return { routeBasis: 'bench', framework: pin.framework, model: pin.frameworkModel };
}
