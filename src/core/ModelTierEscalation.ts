/**
 * ModelTierEscalation — §5.1 of docs/specs/FABLE-MODEL-ESCALATION-SPEC.md.
 *
 * The per-framework (framework, tier) → concrete-model-id resolver plus the
 * closed model-id enumerations and per-adapter swap-capability declarations.
 *
 * Core contracts (all spec-cited, all fail-closed):
 *  - Reads ONLY trusted config (`models.tierEscalation`) — never the
 *    mode-state file. The mode-state can request a TIER; it can never
 *    supply a model ID (spec Sec-F3).
 *  - `escalated: null` (or an absent framework entry) resolves to the
 *    default ⇒ no swap ever — the backwards-compat contract for
 *    codex/gemini/pi until they ship an ultra model (spec §5.1).
 *  - Every id is validated by regex AND membership in the framework's
 *    closed `knownModelIds` enumeration before it can reach a launch arg
 *    or tmux send-keys (spec Sec-F1/F2 — keystroke-injection guard).
 *  - Worst-case failure of every path = `null` = the session stays on its
 *    default model (spec §3.5: a routing decision, never a block).
 *
 * Pure logic, no I/O. The governor (§7/§8) and swap service (§5.3) live in
 * EscalationGovernor.ts / ModelSwapService.ts.
 */

/** The frameworks the escalation policy knows. Closed enum — anything else
 *  resolves to null (spec §5.1 line 1). Kept as a literal union to avoid an
 *  import cycle with core/types.ts (matches the inline pattern used there). */
export type EscalationFramework = 'claude-code' | 'codex-cli' | 'gemini-cli' | 'pi-cli';

export const ESCALATION_FRAMEWORKS: readonly EscalationFramework[] = [
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'pi-cli',
];

export type EscalationTier = 'default' | 'escalated';

/** §5.6 — machine-checkable per-adapter swap capability, not prose. */
export type SwapCapability = 'mid-session' | 'launch-time-only';

export interface TierEscalationFrameworkEntry {
  /** `null` ⇒ use the account default (today's behavior). */
  default: string | null;
  /** `null` ⇒ no ultra model ⇒ escalation is a strict no-op (back-compat). */
  escalated: string | null;
}

export interface TierEscalationTriggers {
  /** Skill names whose entry signals an escalation work-mode (§4). */
  skills: string[];
  /** Trigger #1 also fires on project-initiative design state (§4). */
  projectDesign: boolean;
  /** Optional LLM intent check for ambiguous phrasing (§5.4). Default OFF. */
  llmIntentCheck: boolean;
}

export interface TierEscalationCostGuards {
  /** Map of model id → last free-window UTC date (inclusive). §8. */
  respectFreeWindows: Record<string, string>;
  /** Refuse escalation without a cached quota snapshot showing headroom (§7).
   *  Quota unavailable/errored ⇒ fail CLOSED to default. */
  requireQuotaHeadroom: boolean;
  /** §7 lease cap — admission control for concurrent escalated sessions. */
  maxConcurrentEscalatedPerAccount: number;
  /** §8 — load-bearing for Trigger #1 (short in-conversation swaps). */
  maxEscalationsPerHour: number;
  /** §8 — load-bearing for Trigger #2 (long spawned runs). null = disabled. */
  dailyUltraTokenCap: number | null;
  /** §5.5 — mode-state self-expiry. Expiry INVALIDATES (fresh trigger needed). */
  maxEscalationTtlMs: number;
  /** §5.5 asymmetric hysteresis — never swap twice within this window. */
  minTierDwellMs: number;
  /** §5.5 — de-escalate only after the condition is clear this many turns. */
  minTierDwellTurns: number;
}

export interface TierEscalationConfig {
  /** Fleet default OFF; dev agents (Echo/Codey) ship ENABLED (§10). */
  enabled: boolean;
  /** Log intended swaps without performing them. `enabled:false` wins. */
  dryRun: boolean;
  triggers: TierEscalationTriggers;
  frameworks: Partial<Record<EscalationFramework, TierEscalationFrameworkEntry>>;
  costGuards: TierEscalationCostGuards;
}

/** §9 schema defaults — exactly the converged spec's config block. */
export const DEFAULT_TIER_ESCALATION_CONFIG: TierEscalationConfig = {
  enabled: false,
  dryRun: true,
  triggers: {
    skills: ['build', 'autonomous', 'instar-dev', 'spec-converge'],
    projectDesign: true,
    llmIntentCheck: false,
  },
  frameworks: {
    'claude-code': { default: 'claude-opus-4-8', escalated: 'claude-fable-5' },
    'codex-cli': { default: null, escalated: null },
    'gemini-cli': { default: null, escalated: null },
    'pi-cli': { default: null, escalated: null },
  },
  costGuards: {
    respectFreeWindows: { 'claude-fable-5': '2026-06-22' },
    requireQuotaHeadroom: true,
    maxConcurrentEscalatedPerAccount: 2,
    maxEscalationsPerHour: 8,
    dailyUltraTokenCap: null,
    maxEscalationTtlMs: 21_600_000, // 6h
    minTierDwellMs: 300_000, // 5min
    minTierDwellTurns: 1,
  },
};

/**
 * Closed model-id enumerations per launch adapter (§5.2(c), net-new).
 * A config value outside its framework's list NEVER reaches a launch arg or
 * send-keys — resolveTierModel fails closed to null instead.
 *
 * claude-code: concrete ids the Claude CLI accepts via `--model`, plus the
 * CLI tier aliases it documents (haiku/sonnet/opus). Includes the ultra
 * model `claude-fable-5` — the first populated escalation target.
 * codex-cli: mirror of CODEX_MODELS_SUBSCRIPTION (routes.ts spawn allowlist).
 * gemini-cli: re-exported from the adapter's own closed list.
 * pi-cli: CLOSED-EMPTY by design — pi model ids are `provider/id` patterns
 * whose provider half is per-agent config; there is no universal closed
 * enumeration, so the escalation policy refuses ALL pi ids (strict no-op,
 * §5.6) until a real enumeration is populated. The `/` also fails the id
 * regex — two independent fail-closed layers.
 */
import { KNOWN_GEMINI_MODELS } from '../providers/adapters/gemini-cli/models.js';

export const KNOWN_CLAUDE_MODEL_IDS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'opus',
  'sonnet',
  'haiku',
] as const;

export const KNOWN_CODEX_MODEL_IDS = [
  'gpt-5.2',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
] as const;

export const KNOWN_MODEL_IDS: Record<EscalationFramework, readonly string[]> = {
  'claude-code': KNOWN_CLAUDE_MODEL_IDS,
  'codex-cli': KNOWN_CODEX_MODEL_IDS,
  'gemini-cli': KNOWN_GEMINI_MODELS,
  'pi-cli': [],
};

/**
 * §5.6 — per-adapter swap capability. `claude-code` declares 'mid-session'
 * but the §5.3 contract still verifies EVERY swap with the independent-oracle
 * canary at runtime; the pre-enable proof is the gated live E2E
 * (tests/e2e/model-swap-live-canary.test.ts). The other three are
 * launch-time-only today (and strict no-ops until an escalated model is
 * populated), so "documented, not silently dropped" is enforced by code.
 */
export const SWAP_CAPABILITY: Record<EscalationFramework, SwapCapability> = {
  'claude-code': 'mid-session',
  'codex-cli': 'launch-time-only',
  'gemini-cli': 'launch-time-only',
  'pi-cli': 'launch-time-only',
};

/** §5.1 injection-safe id shape. Anything else is audit+reject. */
export const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Reason codes for fail-closed resolutions — structured, audit-friendly. */
export type ResolveRejectReason =
  | 'unknown-framework'
  | 'no-framework-entry'
  | 'null-id'
  | 'invalid-id-shape'
  | 'id-not-in-closed-enum';

export interface ResolveAuditEvent {
  framework: string;
  tier: EscalationTier;
  reason: ResolveRejectReason;
  /** Escaped + truncated — never the raw value verbatim past 80 chars (Sec-F7). */
  rejectedId?: string;
}

/** Escape + truncate an untrusted id for audit records (spec Sec-F7). */
export function escapeIdForAudit(id: string): string {
  const escaped = JSON.stringify(id).slice(1, -1); // escape control chars/quotes
  return escaped.length > 80 ? `${escaped.slice(0, 80)}…(truncated)` : escaped;
}

/**
 * §5.1 resolver — maps (framework, tier) → concrete model id | null,
 * reading ONLY the trusted config. Every rejection fails closed to null
 * (session stays on default) and reports a structured audit event.
 */
export function resolveTierModel(
  framework: string,
  tier: EscalationTier,
  config: TierEscalationConfig | undefined,
  audit?: (event: ResolveAuditEvent) => void,
): string | null {
  if (!(ESCALATION_FRAMEWORKS as readonly string[]).includes(framework)) {
    audit?.({ framework, tier, reason: 'unknown-framework' });
    return null;
  }
  const fw = framework as EscalationFramework;
  const frameworks = config?.frameworks ?? {};
  // Own-property lookup only — a polluted Object.prototype key can never
  // smuggle an entry in (§5.1 "Object.create(null) / hasOwnProperty lookup").
  const entry = Object.prototype.hasOwnProperty.call(frameworks, fw)
    ? frameworks[fw]
    : undefined;
  if (!entry) {
    audit?.({ framework, tier, reason: 'no-framework-entry' });
    return null;
  }
  const id = tier === 'escalated' ? (entry.escalated ?? entry.default) : entry.default;
  if (id == null) {
    // Not an anomaly: `default: null` means "use the account default"
    // (today's behavior) and `escalated: null` means strict no-op.
    return null;
  }
  if (typeof id !== 'string' || !MODEL_ID_RE.test(id)) {
    audit?.({ framework, tier, reason: 'invalid-id-shape', rejectedId: escapeIdForAudit(String(id)) });
    return null;
  }
  if (!KNOWN_MODEL_IDS[fw].includes(id)) {
    audit?.({ framework, tier, reason: 'id-not-in-closed-enum', rejectedId: escapeIdForAudit(id) });
    return null;
  }
  return id;
}

/**
 * True when escalation could ever change behavior for this framework:
 * an escalated id is configured AND resolves through the closed enum.
 * Used by callers to keep the no-escalated-model case a true no-op.
 */
export function hasEscalatedModel(
  framework: string,
  config: TierEscalationConfig | undefined,
): boolean {
  const escalated = resolveTierModel(framework, 'escalated', config);
  const dflt = resolveTierModel(framework, 'default', config);
  return escalated != null && escalated !== dflt;
}

/** The set of configured escalated ids across all frameworks — used by the
 *  §11 router-exclusion guard and the §8 ultra-cap monitor. */
export function escalatedModelIds(config: TierEscalationConfig | undefined): Set<string> {
  const ids = new Set<string>();
  for (const fw of ESCALATION_FRAMEWORKS) {
    const id = resolveTierModel(fw, 'escalated', config);
    const dflt = resolveTierModel(fw, 'default', config);
    if (id != null && id !== dflt) ids.add(id);
  }
  return ids;
}

/**
 * §8 free-window semantics: compared as a UTC date, inclusive through the
 * named day. Returns true while the window is open. After expiry the
 * quota/budget guards apply unchanged — the window relaxes nothing
 * structural (informational + drives the dev-agent dogfood window).
 */
export function isWithinFreeWindow(
  modelId: string,
  guards: TierEscalationCostGuards,
  nowMs: number,
): boolean {
  const windows = guards.respectFreeWindows ?? {};
  if (!Object.prototype.hasOwnProperty.call(windows, modelId)) return false;
  const dateStr = windows[modelId];
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  // Inclusive through the named UTC day: open until the start of the next day.
  const endExclusive = Date.parse(`${dateStr}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
  return Number.isFinite(endExclusive) && nowMs < endExclusive;
}

/**
 * Merge an operator's (possibly partial / absent) config block over the §9
 * defaults. Add-missing-only semantics live in PostUpdateMigrator; this is
 * the READ-side normalizer so every consumer sees a complete shape.
 */
export function normalizeTierEscalationConfig(
  raw: unknown,
): TierEscalationConfig {
  const d = DEFAULT_TIER_ESCALATION_CONFIG;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ...d,
      triggers: { ...d.triggers, skills: [...d.triggers.skills] },
      frameworks: { ...d.frameworks },
      costGuards: { ...d.costGuards, respectFreeWindows: { ...d.costGuards.respectFreeWindows } },
    };
  }
  const r = raw as Partial<TierEscalationConfig>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    dryRun: typeof r.dryRun === 'boolean' ? r.dryRun : d.dryRun,
    triggers: {
      skills: Array.isArray(r.triggers?.skills)
        ? r.triggers.skills.filter((s): s is string => typeof s === 'string')
        : [...d.triggers.skills],
      projectDesign: typeof r.triggers?.projectDesign === 'boolean' ? r.triggers.projectDesign : d.triggers.projectDesign,
      llmIntentCheck: typeof r.triggers?.llmIntentCheck === 'boolean' ? r.triggers.llmIntentCheck : d.triggers.llmIntentCheck,
    },
    frameworks: { ...d.frameworks, ...(r.frameworks && typeof r.frameworks === 'object' ? r.frameworks : {}) },
    costGuards: {
      ...d.costGuards,
      ...(r.costGuards && typeof r.costGuards === 'object' ? r.costGuards : {}),
      respectFreeWindows: {
        ...(r.costGuards?.respectFreeWindows && typeof r.costGuards.respectFreeWindows === 'object'
          ? r.costGuards.respectFreeWindows
          : d.costGuards.respectFreeWindows),
      },
    },
  };
}
