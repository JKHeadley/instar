/**
 * Server-computed proposal for the feedback TRIAGE authority record — the second authority
 * in authority_records (docs/specs/feedback-triage-and-execution.md §1, Frontloaded Decision 6).
 *
 * Mirrors readinessAuthorityProposal: every binding the runtime later compares (agent,
 * owner machine + epoch, resolved provider/model, prompt/schema/decision-point ids) is
 * derived from the live server, so the operator approves one plain sentence with the PIN and
 * never types a technical field. This module decides nothing.
 */
import type { AuthorityRecord } from '../drain/FeedbackDrainStore.js';
import type { IntelligenceFramework } from '../../core/intelligenceProviderFactory.js';
import { brakePlainWords as readinessBrakeWords, reportedModelFor } from '../drain/readinessAuthorityProposal.js';
import { FEEDBACK_TRIAGE_DECISION_POINT, FEEDBACK_TRIAGE_PROMPT_ID, FEEDBACK_TRIAGE_SCHEMA_ID } from './FeedbackTriageArbiter.js';

export const TRIAGE_AUTHORITY_ID = 'feedback-triage-default';
/** The attribution the triage arbiter sends on every call — the preview uses the same facts. */
export const TRIAGE_ARBITER_ROUTING = { component: 'FeedbackTriageArbiter', category: 'gate', nature: 'B', injectionExposed: true, model: 'capable' } as const;
/** Items per call is bounded by maxBatchChars; maxBatch is the hard item ceiling. maxDailySpendUsd is the store's required envelope; the call cap (feedbackFactory.triage.maxCallsPerDay) binds first. */
export const TRIAGE_ENVELOPE_DEFAULTS = { maxBatch: 20, maxTokens: 8000, maxDailySpendUsd: 5 } as const;

export type TriageEnvelope = { maxBatch: number; maxTokens: number; maxDailySpendUsd: number };

export interface TriageAuthorityProposal {
  status: 'none' | 'active' | 'proposal-only' | 'revoked';
  current: (AuthorityRecord & { matchesProposal: boolean }) | null;
  proposal: Omit<AuthorityRecord, 'generation' | 'revoked'> | null;
  blockers: string[];
  approveAction: 'create' | 'replace' | 'restore' | null;
  summary: string;
  pausedBecause: string | null;
}

export function triagePlainSummary(envelope: TriageEnvelope, maxCallsPerDay: number): string {
  return `Let the sorting model read each feedback work item's reports and decide work, hold or ignore, with a severity and a priority: ` +
    `up to ${envelope.maxBatch} items per batch, at most ${maxCallsPerDay} model calls per day. ` +
    'Ignores stay in a safe "would ignore" practice mode until you turn them on separately. ' +
    'An answer that fails the checks leaves the items untouched; three unusable runs in a row start a self-check, and a different model answering pauses it for your approval.';
}

export function triageBrakePlainWords(reason: string): string {
  switch (reason) {
    case 'triage-authority-mismatch': return 'A different model, prompt or answer format replied than the one you approved.';
    case 'triage-self-heal-exhausted': return 'The sorting model gave no usable answer through every automatic retry.';
    default: return readinessBrakeWords(reason);
  }
}

const BINDING_FIELDS = ['agentId', 'ownerMachineId', 'ownerEpoch', 'provider', 'modelFamily', 'promptVersion', 'schemaVersion', 'decisionPointId'] as const;

export function buildTriageAuthorityProposal(input: {
  agentId: string;
  binding: { ownerMachineId: string | null; ownerEpoch: number };
  route: { framework: IntelligenceFramework; model: string | undefined } | null;
  piModel?: string;
  current: AuthorityRecord | null;
  currentMode?: 'active' | 'proposal-only';
  currentModeReason?: string;
  currentOwnerValid?: boolean;
  envelope?: Partial<TriageEnvelope>;
  maxCallsPerDay: number;
}): TriageAuthorityProposal {
  const current = input.current;
  const base = current && !current.revoked ? { maxBatch: current.maxBatch, maxTokens: current.maxTokens, maxDailySpendUsd: current.maxDailySpendUsd } : TRIAGE_ENVELOPE_DEFAULTS;
  const pick = (value: unknown, dflt: number) => (value === undefined || value === null || value === '' ? dflt : Number(value));
  const envelope: TriageEnvelope = {
    maxBatch: pick(input.envelope?.maxBatch, base.maxBatch),
    maxTokens: pick(input.envelope?.maxTokens, base.maxTokens),
    maxDailySpendUsd: pick(input.envelope?.maxDailySpendUsd, base.maxDailySpendUsd),
  };
  const blockers: string[] = [];
  if (!input.agentId.trim()) blockers.push('This agent has no name configured.');
  if (!input.binding.ownerMachineId) blockers.push('No machine is configured to run the feedback drain here, so there is nothing to bind the authority to.');
  if (!Number.isSafeInteger(input.binding.ownerEpoch) || input.binding.ownerEpoch < 1) blockers.push('The drain owner epoch is not readable right now.');
  const model = input.route ? reportedModelFor(input.route.framework, input.route.model, input.piModel) : null;
  if (!input.route || !model) blockers.push('No model is currently available to route the triage decision to, so there is nothing to approve.');
  if (!Number.isSafeInteger(envelope.maxBatch) || envelope.maxBatch < 1 || envelope.maxBatch > 50) blockers.push('Batch size must be a whole number from 1 to 50.');
  if (!Number.isSafeInteger(envelope.maxTokens) || envelope.maxTokens < 512 || envelope.maxTokens > 16_000) blockers.push('Token limit must be a whole number from 512 to 16000.');
  if (!Number.isFinite(envelope.maxDailySpendUsd) || envelope.maxDailySpendUsd <= 0 || envelope.maxDailySpendUsd > 1000) blockers.push('Daily spend cap must be more than $0 and at most $1000.');
  const proposal = input.route && model && input.binding.ownerMachineId ? {
    authorityId: TRIAGE_AUTHORITY_ID,
    agentId: input.agentId,
    ownerMachineId: input.binding.ownerMachineId,
    ownerEpoch: input.binding.ownerEpoch,
    provider: input.route.framework,
    modelFamily: model,
    promptVersion: FEEDBACK_TRIAGE_PROMPT_ID,
    schemaVersion: FEEDBACK_TRIAGE_SCHEMA_ID,
    decisionPointId: FEEDBACK_TRIAGE_DECISION_POINT,
    ...envelope,
  } : null;
  const matches = Boolean(current && proposal &&
    BINDING_FIELDS.every((field) => current[field] === proposal[field] || (field === 'ownerEpoch' && input.currentOwnerValid === true)) &&
    current.maxBatch === proposal.maxBatch && current.maxTokens === proposal.maxTokens && current.maxDailySpendUsd === proposal.maxDailySpendUsd);
  const status: TriageAuthorityProposal['status'] = !current ? 'none' : current.revoked ? 'revoked' : input.currentMode === 'proposal-only' ? 'proposal-only' : 'active';
  const approveAction: TriageAuthorityProposal['approveAction'] = status === 'none' ? 'create' : status === 'revoked' ? 'restore' : matches && status === 'active' ? null : 'replace';
  return {
    status,
    current: current ? { ...current, matchesProposal: matches } : null,
    proposal,
    blockers,
    approveAction: blockers.length > 0 && approveAction !== 'restore' ? null : approveAction,
    summary: triagePlainSummary(envelope, input.maxCallsPerDay),
    pausedBecause: status === 'proposal-only' ? triageBrakePlainWords(input.currentModeReason ?? '') : null,
  };
}
