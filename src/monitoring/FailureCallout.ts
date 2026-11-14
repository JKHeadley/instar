/** Failure-callout evidence and closure discipline; stored in CorrectionLedger.
 * Context is local, bounded and scrubbed. It is evidence, never authority.
 */
import { scrubSecrets } from './scrubSecrets.js';

export type CorrectionSeverity = 'correction' | 'failure-callout';
export interface FailureContext {
  turns: Array<{ text: string; fromUser: boolean; at: number }>;
  instructions: string[];
  decisions: string[];
  sourceRefs: string[];
  missing: string[];
}
export interface FailureInvestigation {
  classification: 'constitution-gap' | 'enforcement-gap';
  standardRefs: string[];
  rootCause: string;
  classFix: string;
  fixRefs: string[];
}
export interface FailureVerification {
  /** A failing baseline and passing replay of the same scenario, plus an allowed case. */
  scenario: string;
  baselineRef: string;
  replayRef: string;
  allowedCaseRef: string;
  replayPassed: boolean;
  allowedCasePassed: boolean;
}
export interface FailureEpisode {
  state: FailureCase['state'];
  context: FailureContext;
  investigation?: FailureInvestigation;
  verification?: FailureVerification;
  updatedAt: string;
}
export interface FailureCase {
  state: 'captured' | 'investigated' | 'verified' | 'reopened';
  history?: FailureEpisode[];
  context: FailureContext;
  investigation?: FailureInvestigation;
  verification?: FailureVerification;
  updatedAt: string;
}
const clean = (s: unknown, onLoss?: () => void): string => {
  if (typeof s !== 'string') return '';
  const scrubbed = scrubSecrets(s);
  if (scrubbed.length > 4000) onLoss?.();
  return scrubbed.slice(0, 4000).trim();
};
const strings = (v: unknown, onLoss?: () => void): string[] => {
  if (!Array.isArray(v)) return [];
  if (v.length > 20) onLoss?.();
  return v.slice(0, 20).map(item => clean(item, onLoss)).filter(Boolean);
};
const lossMarker = (field: string): string => `Evidence truncated in ${field}; resolve the omitted material from its full source and retain an exact source reference before verification.`;
const LOSS_FIELDS = ['context.turns', 'context.turns.text', 'context.instructions', 'context.decisions', 'context.sourceRefs', 'context.missing', 'investigation.standardRefs', 'investigation.rootCause', 'investigation.classFix', 'investigation.fixRefs'];
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function validateStringArray(value: unknown, field: string): void {
  if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
    throw new Error(`${field} must be an array of strings`);
  }
}
function validateContext(value: unknown): void {
  if (!isObject(value)) throw new Error('context must be an object');
  for (const field of ['instructions', 'decisions', 'sourceRefs', 'missing']) validateStringArray(value[field], `context.${field}`);
  if (value.turns !== undefined && (!Array.isArray(value.turns) || value.turns.some(turn =>
    !isObject(turn) || typeof turn.text !== 'string' || typeof turn.fromUser !== 'boolean'
      || (turn.at !== undefined && (typeof turn.at !== 'number' || !Number.isFinite(turn.at)))))) {
    throw new Error('context.turns must contain text, boolean fromUser and finite timestamps');
  }
}
export function scrubFailureContext(value: unknown): FailureContext {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<FailureContext>;
  const losses = new Set<string>();
  const noteLoss = (field: string) => () => losses.add(lossMarker(field));
  // Previously generated markers may sit beyond the caller's first 20 entries.
  // Preserve this finite vocabulary independently of ordinary missing prose.
  if (Array.isArray(v.missing)) {
    for (const field of LOSS_FIELDS) if (v.missing.includes(lossMarker(field))) noteLoss(field)();
  }
  if (Array.isArray(v.turns) && v.turns.length > 12) noteLoss('context.turns')();
  const turns = Array.isArray(v.turns) ? v.turns.slice(-12).map(t => ({
    text: clean(t?.text, noteLoss('context.turns.text')),
    fromUser: t?.fromUser === true, at: Number.isFinite(t?.at) ? t.at : 0,
  })) : [];
  const instructions = strings(v.instructions, noteLoss('context.instructions'));
  const decisions = strings(v.decisions, noteLoss('context.decisions'));
  const sourceRefs = strings(v.sourceRefs, noteLoss('context.sourceRefs'));
  const missing = strings(v.missing, noteLoss('context.missing'));
  return {
    turns, instructions, decisions, sourceRefs,
    // Loss markers are appended after the caller-controlled bound so they can
    // never themselves be dropped by a full or malformed missing-evidence list.
    missing: [...new Set([...missing, ...losses])],
  };
}
export function newFailureCase(context: unknown): FailureCase {
  return { state: 'captured', context: scrubFailureContext(context), updatedAt: new Date().toISOString() };
}
/** Validation is shared by HTTP and local callers; omitted evidence never means success. */
export function advanceFailureCase(current: FailureCase, input: unknown): FailureCase {
  if (!isObject(input)) throw new Error('failure-case update required');
  const v = input as Record<string, unknown>;
  const next = structuredClone(current);
  if (v.context !== undefined || v.investigation !== undefined) next.history = archiveFailureEpisode(current);
  if (v.context !== undefined) {
    validateContext(v.context);
    next.context = scrubFailureContext(v.context);
    next.state = 'captured';
    delete next.investigation; delete next.verification;
  }
  if (v.investigation !== undefined) {
    const i = v.investigation as Partial<FailureInvestigation> | null;
    if (!isObject(i) || !['constitution-gap', 'enforcement-gap'].includes(i.classification ?? '')) throw new Error('classification must be constitution-gap or enforcement-gap');
    validateStringArray(i.standardRefs, 'investigation.standardRefs');
    validateStringArray(i.fixRefs, 'investigation.fixRefs');
    const noteLoss = (field: string) => () => {
      const marker = lossMarker(field);
      if (!next.context.missing.includes(marker)) next.context.missing.push(marker);
    };
    const investigation: FailureInvestigation = {
      classification: i.classification!, standardRefs: strings(i.standardRefs, noteLoss('investigation.standardRefs')),
      rootCause: clean(i.rootCause, noteLoss('investigation.rootCause')),
      classFix: clean(i.classFix, noteLoss('investigation.classFix')),
      fixRefs: strings(i.fixRefs, noteLoss('investigation.fixRefs')),
    };
    // Preserve a diagnosis while evidence is still being collected or a proposed
    // class fix awaits implementation/ratification. Only verification closes it.
    if (!investigation.standardRefs.length || !investigation.rootCause || !investigation.classFix) throw new Error('investigation requires standards, root cause and class fix');
    next.investigation = investigation; next.state = 'investigated'; delete next.verification;
  }
  if (v.verification !== undefined) {
    if (!next.investigation || next.state !== 'investigated') throw new Error('investigation required before verification');
    if (!next.context.turns.some(t => t.fromUser && t.text.trim())
      || !next.context.turns.some(t => !t.fromUser && t.text.trim())
      || !next.context.sourceRefs.length || !next.context.instructions.length
      || !next.context.decisions.length || next.context.missing.length) {
      throw new Error('complete the context with the failing reply and user callout and resolve missing evidence before verification');
    }
    if (!next.investigation.fixRefs.length) throw new Error('implemented class fix references required before verification');
    const r = v.verification as Partial<FailureVerification> | null;
    if (!isObject(r)) throw new Error('verification evidence required');
    const refuseLoss = () => { throw new Error('verification evidence exceeds bounds; use exact references to complete evidence'); };
    const verification: FailureVerification = { scenario: clean(r.scenario, refuseLoss), baselineRef: clean(r.baselineRef, refuseLoss), replayRef: clean(r.replayRef, refuseLoss), allowedCaseRef: clean(r.allowedCaseRef, refuseLoss), replayPassed: r.replayPassed === true, allowedCasePassed: r.allowedCasePassed === true };
    if (!verification.scenario || !verification.baselineRef || !verification.replayRef || !verification.allowedCaseRef || !verification.replayPassed || !verification.allowedCasePassed) throw new Error('verification requires failing baseline, passing repeat replay and passing allowed case');
    next.verification = verification; next.state = 'verified';
  }
  if (!['context', 'investigation', 'verification'].some(k => k in v)) throw new Error('context, investigation or verification required');
  next.updatedAt = new Date().toISOString();
  return next;
}

/** Bounded display only; CorrectionLedger archives every revision separately. */
export function archiveFailureEpisode(current: FailureCase): FailureEpisode[] {
  const { history, ...episode } = structuredClone(current);
  return [...(history ?? []), episode].slice(-5);
}
