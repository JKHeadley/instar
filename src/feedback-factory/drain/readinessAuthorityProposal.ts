/**
 * Server-computed proposal for the feedback readiness authority record.
 *
 * The operator approves the authority from the dashboard with their PIN; they never
 * type technical fields. Every binding the runtime later compares (agent id, owner
 * machine + epoch, resolved provider/model, prompt/schema/decision-point ids) is
 * derived here from the live server, so a registration made from this proposal is
 * the one the drain tick and the arbiter will accept. Only the spend/batch envelope
 * is operator-editable. This module decides nothing: registration stays behind the
 * PIN-gated route (docs/specs/feedback-factory-operating-drain.md §2).
 */
import type { AuthorityRecord } from './FeedbackDrainStore.js';
import type { IntelligenceFramework } from '../../core/intelligenceProviderFactory.js';
import {
  FEEDBACK_READINESS_DECISION_POINT,
  FEEDBACK_READINESS_PROMPT_ID,
  FEEDBACK_READINESS_SCHEMA_ID,
} from './FeedbackReadinessArbiter.js';
import { resolveCliFlag } from '../../core/models.js';
import { resolveCliModelFlag as codexModelFlag } from '../../providers/adapters/openai-codex/models.js';
import { resolveCliModelFlag as geminiModelFlag } from '../../providers/adapters/gemini-cli/models.js';

export const READINESS_AUTHORITY_ID = 'feedback-readiness-default';
/** The attribution the arbiter sends on every call — the preview must use the same facts. */
export const READINESS_ARBITER_ROUTING = { component: 'FeedbackReadinessArbiter', category: 'gate', nature: 'B', injectionExposed: true, model: 'capable' } as const;
/** Operator-approved defaults (Justin, topic 95267, 2026-09-30): 50 per batch, $5/day. The arbiter clamps tokens to 1200. */
export const READINESS_ENVELOPE_DEFAULTS = { maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5 } as const;

export type ReadinessEnvelope = { maxBatch: number; maxTokens: number; maxDailySpendUsd: number };
export type ReadinessAuthorityFields = Omit<AuthorityRecord, 'generation' | 'revoked'>;

export interface ReadinessAuthorityProposalInput {
  agentId: string;
  /** The drain's owner binding; ownerMachineId null when no operated host is configured. */
  binding: { ownerMachineId: string | null; ownerEpoch: number };
  /** IntelligenceRouter.previewPrimary for READINESS_ARBITER_ROUTING; null = no route. */
  route: { framework: IntelligenceFramework; model: string | undefined } | null;
  /** config.sessions.frameworkDefaultModels['pi-cli'] — pi reports this pattern regardless of hints. */
  piModel?: string;
  current: AuthorityRecord | null;
  currentMode?: 'active' | 'proposal-only';
  /** The posture reason recorded when the current record was paused. */
  currentModeReason?: string;
  /**
   * store.authorityOwnerCurrent(current, binding): the current record's owner binding still
   * holds — same machine, unbroken tenure — even though a restart advanced the lease epoch.
   */
  currentOwnerValid?: boolean;
  envelope?: Partial<ReadinessEnvelope>;
}

export interface ReadinessAuthorityProposal {
  status: 'none' | 'active' | 'proposal-only' | 'revoked';
  current: (AuthorityRecord & { matchesProposal: boolean }) | null;
  proposal: ReadinessAuthorityFields | null;
  /** Plain reasons the proposal cannot be approved yet; empty when it can. */
  blockers: string[];
  /** The action an Approve tap performs in this state, or null when nothing to approve. */
  approveAction: 'create' | 'replace' | 'restore' | null;
  summary: string;
  /** Why the current record is paused, in plain words; null unless status is proposal-only. */
  pausedBecause: string | null;
}

/** The model string the provider will report via onModel for this hint (what the arbiter compares). */
export function reportedModelFor(framework: IntelligenceFramework, hint: string | undefined, piModel?: string): string | null {
  switch (framework) {
    case 'claude-code': return resolveCliFlag(hint ?? 'capable');
    case 'codex-cli': return codexModelFlag(hint);
    case 'gemini-cli': return geminiModelFlag(hint);
    case 'pi-cli': return piModel?.trim() || null;
    default: return hint?.trim() || null;
  }
}

function envelopeFrom(input?: Partial<ReadinessEnvelope>, fallback?: ReadinessEnvelope): ReadinessEnvelope {
  const base = fallback ?? READINESS_ENVELOPE_DEFAULTS;
  const pick = (value: unknown, dflt: number) => (value === undefined || value === null || value === '' ? dflt : Number(value));
  return {
    maxBatch: pick(input?.maxBatch, base.maxBatch),
    maxTokens: pick(input?.maxTokens, base.maxTokens),
    maxDailySpendUsd: pick(input?.maxDailySpendUsd, base.maxDailySpendUsd),
  };
}

export function envelopeProblems(envelope: ReadinessEnvelope): string[] {
  const out: string[] = [];
  if (!Number.isSafeInteger(envelope.maxBatch) || envelope.maxBatch < 1 || envelope.maxBatch > 50) out.push('Batch size must be a whole number from 1 to 50.');
  if (!Number.isSafeInteger(envelope.maxTokens) || envelope.maxTokens < 128 || envelope.maxTokens > 100_000) out.push('Token limit must be a whole number from 128 to 100000.');
  if (!Number.isFinite(envelope.maxDailySpendUsd) || envelope.maxDailySpendUsd <= 0 || envelope.maxDailySpendUsd > 1000) out.push('Daily spend cap must be more than $0 and at most $1000.');
  return out;
}

export function plainSummary(envelope: ReadinessEnvelope): string {
  return `Let the sorting model decide which feedback reports become work items: up to ${envelope.maxBatch} reports per batch, ` +
    `at most $${envelope.maxDailySpendUsd} per day. Anything outside that comes to you. ` +
    'An answer that fails the checks is set aside and retried; it pauses itself only at the daily cap, ' +
    'if a different model answers, or after three runs in a row with no usable answer.';
}

/** What a recorded brake reason means, in the operator's words. */
export function brakePlainWords(reason: string): string {
  switch (reason) {
    case 'readiness-spend-brake': return 'The daily spend cap was reached.';
    case 'readiness-schema-provenance-or-routing-failure':
      return 'The answer did not come from the approved model, or the deployed prompt no longer matches the approval.';
    case 'readiness-authority-repeated-invocation-failure':
      return 'Three runs in a row produced no usable answer (timeouts, provider errors, or answers that failed the checks).';
    default: return reason ? `Paused (${reason}).` : 'Paused by a safety brake.';
  }
}

const BINDING_FIELDS = ['agentId', 'ownerMachineId', 'ownerEpoch', 'provider', 'modelFamily', 'promptVersion', 'schemaVersion', 'decisionPointId'] as const;

export function buildReadinessAuthorityProposal(input: ReadinessAuthorityProposalInput): ReadinessAuthorityProposal {
  const current = input.current;
  // An existing record's envelope is the operator's last decision; keep it unless they edit it.
  const envelope = envelopeFrom(input.envelope, current && !current.revoked
    ? { maxBatch: current.maxBatch, maxTokens: current.maxTokens, maxDailySpendUsd: current.maxDailySpendUsd } : undefined);
  const blockers: string[] = [];
  if (!input.agentId.trim()) blockers.push('This agent has no name configured.');
  if (!input.binding.ownerMachineId) blockers.push('No machine is configured to run the feedback drain here, so there is nothing to bind the authority to.');
  if (!Number.isSafeInteger(input.binding.ownerEpoch) || input.binding.ownerEpoch < 1) blockers.push('The drain owner epoch is not readable right now.');
  const model = input.route ? reportedModelFor(input.route.framework, input.route.model, input.piModel) : null;
  if (!input.route || !model) blockers.push('No model is currently available to route the sorting decision to, so there is nothing to approve.');
  blockers.push(...envelopeProblems(envelope));

  const proposal: ReadinessAuthorityFields | null = input.route && model && input.binding.ownerMachineId ? {
    authorityId: READINESS_AUTHORITY_ID,
    agentId: input.agentId,
    ownerMachineId: input.binding.ownerMachineId,
    ownerEpoch: input.binding.ownerEpoch,
    provider: input.route.framework,
    modelFamily: model,
    promptVersion: FEEDBACK_READINESS_PROMPT_ID,
    schemaVersion: FEEDBACK_READINESS_SCHEMA_ID,
    decisionPointId: FEEDBACK_READINESS_DECISION_POINT,
    ...envelope,
  } : null;

  const matches = Boolean(current && proposal &&
    BINDING_FIELDS.every((field) => current[field] === proposal[field] || (field === 'ownerEpoch' && input.currentOwnerValid === true)) &&
    current.maxBatch === proposal.maxBatch && current.maxTokens === proposal.maxTokens &&
    current.maxDailySpendUsd === proposal.maxDailySpendUsd);
  const status: ReadinessAuthorityProposal['status'] = !current ? 'none'
    : current.revoked ? 'revoked'
      : input.currentMode === 'proposal-only' ? 'proposal-only' : 'active';
  // A revoked record must be restored before it can be replaced (store rule); a demoted
  // (proposal-only) record returns to active only through a new generation.
  const approveAction: ReadinessAuthorityProposal['approveAction'] = status === 'none' ? 'create'
    : status === 'revoked' ? 'restore'
      : matches && status === 'active' ? null : 'replace';
  return {
    status,
    current: current ? { ...current, matchesProposal: matches } : null,
    proposal,
    blockers,
    approveAction: blockers.length > 0 && approveAction !== 'restore' ? null : approveAction,
    summary: plainSummary(envelope),
    pausedBecause: status === 'proposal-only' ? brakePlainWords(input.currentModeReason ?? '') : null,
  };
}
