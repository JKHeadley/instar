import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BETWEEN_WINDOW_ADMISSION_CONTRACT_VERSION, evaluateBetweenWindowAdmission } from './BetweenWindowAdmissionGate.js';

export const WINDOW_LEDGER_AGENT = 'echo' as const;
export const WINDOW_LEDGER_SCOPE = 'echo-window-lifecycle' as const;
export const WINDOW_LEDGER_VERSION = 1;
export const NATIVE_ADMISSION_COMPATIBILITY = `BetweenWindowAdmissionGate@${BETWEEN_WINDOW_ADMISSION_CONTRACT_VERSION}`;
export const RECURRING_DUTY_DEFAULT_GRACE_MS = 15 * 60_000;

export type LifecyclePhase = 'pre-start' | 'start' | 'continuous' | 'cadence' | 'mid' | 'close' | 'post-live';
export type ObligationStatus = 'pending' | 'satisfied' | 'failed' | 'blocked' | 'expired' | 'unknown' | 'open-unexecuted' | 'waived-for-debt' | 'waived-for-phase-transition';
export type ExecutorClass = 'pending-executable' | 'completed-one-shot' | 'future-phase';
export type EvidenceAuthority = 'native-local-store-presence' | 'content-bound-store-row' | 'live-requeried-message' | 'replicated-export' | 'verified-operator-approval' | 'runtime-registry-proof' | 'deterministic-replay';
export type LifecycleState = 'idle' | 'pre_start_gate' | 'start_blocked' | 'active_start' | 'active_mid_due' | 'active_mid_blocked' | 'active_mid_satisfied' | 'close_due' | 'close_blocked' | 'delivered_pending_post_live' | 'closed_clean' | 'closed_with_operator_waiver' | 'rolled_back';

export interface SourceSpan { source: string; hash: string; byteStart: number; byteEnd: number; lineStart: number; lineEnd: number }
export interface EvidenceRecord {
  authority: EvidenceAuthority; agentId: string; scope: string; windowId: string; obligationId: string;
  sourceHashes: string[]; producer: string; timestamp: string; nonce: string; canonicalPayloadHash: string;
  verifierPassed: boolean; verifiedPayload?: string; nativeCoordinates?: { topicId?: number; messageId?: number; storePath?: string };
}
export interface ExecutorBinding {
  class?: ExecutorClass; kind: string; executorId: string; owner: string; registryCoordinates: string;
  enabled: boolean; dryRun: boolean; running?: boolean; heartbeatAt?: string; heartbeatMaxAgeMs?: number;
  nextAttemptAt?: string; eligibilityAt?: string; triggerEnabled?: boolean; durableTriggerState?: boolean;
  deliversOutput?: boolean; sinkReachable?: boolean; suppressionActive?: boolean;
  needsClientDriver?: boolean; driverPresent?: boolean; driverMatches?: boolean;
}
export interface Obligation {
  id: string; agentId: string; scope: string; windowId: string; sourceSpans: SourceSpan[]; statement: string;
  phase: LifecyclePhase; coreDuty: boolean; waiverPolicy: 'non-waivable' | 'debt-only' | 'phase-transition';
  responsibleRole: string; deadline: { dueAt: string; graceMs: number }; predicate: { recurring?: boolean; requiredAuthority?: EvidenceAuthority; expected?: Record<string, string> };
  evidencePolicy: { requiredAuthority: EvidenceAuthority }; executorBinding: ExecutorBinding; failureAction: string;
  status: ObligationStatus; evidence: EvidenceRecord[]; eligibleAt?: string; lastEvaluatedAt: string | null;
}
export interface FailureRemediation {
  obligationId: string; action: string; blockPhase: boolean; blockNewScope: boolean; blockSend: boolean; blockCompletion: boolean;
  observerTopicId?: number; debtRequired: boolean; repostRequired: boolean; correctionRequired: boolean; scopeReviewRequired: boolean;
}
export interface SourceAstNode { kind: 'heading' | 'list-item' | 'paragraph'; text: string; span: SourceSpan; operative: boolean }
export interface CompiledSources { hashes: Record<string, string>; byteLengths: Record<string, number>; obligations: Obligation[]; operativeLines: SourceSpan[]; ast?: SourceAstNode[]; facts?: Record<string, string[]>; challenges?: Record<string, string> }
export interface LedgerDocument { version: 1; lifecycleRunId: string; agentId: 'echo'; scope: 'echo-window-lifecycle'; windowId: string; state: LifecycleState; sourceHashes: Record<string, string>; compiledObligationIds: string[]; obligations: Obligation[]; usedNonces: string[]; nativeEvaluations: NativeEvaluationRecord[]; surfacedIssues?: string[]; requiredRemediations?: FailureRemediation[]; admissionEvaluatedAt?: string; admission?: { admitted: true; evaluatedAt: string; snapshotDigest: string }; waivers?: Waiver[]; rollback?: { at: string; reason: string; operatorEvidence: EvidenceRecord; operatorPrincipalId: string; windowId: string; scope: 'echo-window-lifecycle'; enforcementDisabled: true; auditReadOnly: true; manualRitualRequired: true; reenabledAt?: string; faultFixedEvidence?: string; dryRunSuitePassed?: true } }
export interface NativeEvaluationRecord { agentId: 'echo'; scope: 'echo-window-lifecycle'; windowId: string; inputHash: string; inputBytes: string; storePath: string; storeHash: string; storeBytesLength: number; evaluatorVersion: string; output: unknown; evaluatedAt: string; nonce: string; mapping: Record<string, string> }

export interface RuntimeExecutorSnapshot {
  executorId: string; owner: string; kind: string; registryCoordinates: string; enabled: boolean; dryRun: boolean;
  running: boolean; heartbeatAt?: string; nextAttemptAt?: string; deliversOutput?: boolean; sinkReachable?: boolean;
  suppressionActive?: boolean; needsClientDriver?: boolean; driverPresent?: boolean; driverMatches?: boolean;
  triggerEnabled?: boolean; durableTriggerState?: boolean; eligibilityAt?: string;
  assignedAt?: string; completedAt?: string; completionDigest?: string; deliveryMessageId?: string; deliveryTopicId?: number;
}
export interface WindowRuntimeRegistry { resolve(executorId: string, obligationId: string): RuntimeExecutorSnapshot | null }
export interface LiveMessageRow { messageId: number; topicId: number; text: string; fromUser: boolean; timestamp: string; verifiedOperator?: boolean; senderUid?: string; sessionName?: string | null; provenance?: string; authorship?: string }
export interface WindowEvidenceAuthority { requery(record: EvidenceRecord): EvidenceRecord | null }
interface DutyDefinition { id: string; phase: LifecyclePhase; sourcePattern: RegExp; sourcePatterns?: RegExp[]; sample: string; role: string; authority: EvidenceAuthority; core: boolean; failure: string; recurring?: boolean; waiverPolicy?: Obligation['waiverPolicy'] }
export const REQUIRED_WINDOW_DUTIES: readonly DutyDefinition[] = [
  ...['pathway.full-reread.observer-1','pathway.full-reread.observer-2','observer1.full-reread.observer-1','observer1.full-reread.observer-2'].map(id => ({ id:`preground.${id}`, phase:'pre-start' as const, sourcePattern:/re-read the entire Pathway|same for the observer 1 topic/i, sample:'Both observers must re-read the entire Pathway from July 25 and the observer 1 topic.', role:id.endsWith('observer-1')?'observer-1':'observer-2', authority:'live-requeried-message' as const, core:true, failure:'block-phase' })),
  { id:'preground.visible-discussion.pathway', phase:'pre-start', sourcePattern:/coordination.*VISIBLY|discuss it with each other/i, sample:'Observer coordination must happen VISIBLY and discuss the Pathway assessment.', role:'observer-2', authority:'live-requeried-message', core:true, failure:'block-phase' },
  { id:'preground.visible-discussion.observer1', phase:'pre-start', sourcePattern:/coordination.*VISIBLY|again discuss/i, sample:'Observer coordination must happen VISIBLY for the observer 1 assessment.', role:'observer-2', authority:'live-requeried-message', core:true, failure:'block-phase' },
  { id:'preground.independent-assessments', phase:'pre-start', sourcePattern:/independently scores|each observer must actually/i, sample:'Each observer must create an independent assessment before reconciliation.', role:'observer-2', authority:'live-requeried-message', core:true, failure:'block-phase' },
  { id:'preground.unresolved-disagreement-shown', phase:'pre-start', sourcePattern:/unresolved disagreement.*shown/i, sample:'Every unresolved disagreement must be shown to the operator.', role:'observer-2', authority:'live-requeried-message', core:true, failure:'block-phase' },
  { id:'preground.combined-recommendation', phase:'pre-start', sourcePattern:/combine the assessments/i, sample:'Observers must combine assessments into the next-window recommendation.', role:'observer-2', authority:'live-requeried-message', core:true, failure:'block-phase' },
  { id:'preground.native-structural-preflight', phase:'pre-start', sourcePattern:/admission[- ]gate|opening cannot complete|run must appear in the LIVE run listing before the opening is declared complete/i, sample:'The native admission-gate structural preflight is required.', role:'observer-2', authority:'native-local-store-presence', core:true, failure:'block-phase' },
  { id:'start.source-ingestion.tenets', phase:'start', sourcePattern:/tenets.*compiled|tenets in force|The Tenets|reaffirm the tenets WORD FOR WORD/i, sample:'Current tenets must be ingested with source spans.', role:'echo', authority:'content-bound-store-row', core:true, failure:'block-phase' },
  { id:'start.source-ingestion.charter', phase:'start', sourcePattern:/charter|WINDOW LIFECYCLE/i, sample:'Current charter must be ingested with source spans.', role:'echo', authority:'content-bound-store-row', core:true, failure:'block-phase' },
  { id:'start.compilation-proof', phase:'start', sourcePattern:/obligation ledger compiled|negative tests per omitted duty|approved charter compiles AS APPROVED|recompile .*duties from THIS approved charter directly/i, sample:'Compilation coverage and source-derived challenges are required.', role:'echo', authority:'deterministic-replay', core:true, failure:'block-phase' },
  { id:'start.reaffirmation', phase:'start', sourcePattern:/beginning, middle, and end|opening cannot complete.*reaffirmation/i, sample:'Byte-exact beginning reaffirmation is required.', role:'observer-1', authority:'live-requeried-message', core:true, failure:'block-phase' },
  { id:'start.plan-input', phase:'start', sourcePattern:/mandatory INPUT|Plan-tree placement/i, sample:'Canonical plan input, current node, and leaf-to-root placement are required.', role:'observer-1', authority:'live-requeried-message', core:true, failure:'block-phase' },
  { id:'start.named-worker-lanes', phase:'start', sourcePattern:/named lanes|Lane A/i, sample:'Named worker lanes with artifacts and blockers are required.', role:'orchestrator', authority:'runtime-registry-proof', core:true, failure:'block-phase' },
  { id:'start.delegation-majority-boundary', phase:'start', sourcePattern:/majority of development MUST be offloaded/i, sample:'The orchestrator must not perform the majority of development.', role:'orchestrator', authority:'runtime-registry-proof', core:true, failure:'block-new-scope-and-escalate' },
  { id:'start.machine-model-distribution', phase:'start', sourcePattern:/BOTH machines|MULTIPLE.*Codey/i, sample:'Both-machine and multiple-Codey distribution or a named blocker is required.', role:'orchestrator', authority:'runtime-registry-proof', core:false, failure:'register-debt' },
  { id:'start.cadence-commitment', phase:'start', sourcePattern:/every 3 hours|3-hour cadence/i, sample:'A durable 3-hour reporting cadence is required.', role:'observer-1', authority:'runtime-registry-proof', core:true, failure:'block-phase' },
  { id:'start.stall-cadence', phase:'start', sourcePattern:/30 minute checks/i, sample:'A durable 30-minute all-session stall cadence is required.', role:'observer-1', authority:'runtime-registry-proof', core:true, failure:'block-phase' },
  { id:'start.window-expiry-recorded', phase:'start', sourcePattern:/24 hours|24h end/i, sample:'Charter expiry and server backstop precedence must be recorded.', role:'observer-1', authority:'content-bound-store-row', core:true, failure:'block-phase' },
  { id:'continuous.telegram.send-path-classified', phase:'continuous', sourcePattern:/Telegram-through-my-account channel|Leveraging Telegram, logged into my account/i, sample:'Every Telegram operator-account send path must be classified.', role:'echo', authority:'live-requeried-message', core:true, failure:'block-send' },
  { id:'continuous.telegram.profile-resolved', phase:'continuous', sourcePattern:/justin-telegram/i, sample:'The justin-telegram profile must be resolved.', role:'echo', authority:'runtime-registry-proof', core:true, failure:'block-send' },
  { id:'continuous.telegram.signature-verified', phase:'continuous', sourcePattern:/agent-signature protocol/i, sample:'Echo signature provenance must be verified.', role:'echo', authority:'live-requeried-message', core:true, failure:'block-send' },
  { id:'continuous.telegram.act-as-principal-guard', phase:'continuous', sourcePattern:/never authorisation to act as Justin|nothing can be construed as coming from me/i, sample:'Echo must never act as Justin.', role:'echo', authority:'live-requeried-message', core:true, failure:'block-send' },
  { id:'cadence.stall-check.30m', phase:'cadence', sourcePattern:/30 minute checks/i, sample:'Every 30 minutes all active window sessions must be checked.', role:'observer-1', authority:'runtime-registry-proof', core:true, failure:'block-new-scope-and-escalate', recurring:true },
  { id:'cadence.report.3h', phase:'cadence', sourcePattern:/every 3 hours|3-hour cadence/i, sample:'Every 3 hours a synthesis report must be delivered.', role:'observer-1', authority:'live-requeried-message', core:true, failure:'block-new-scope-and-escalate', recurring:true },
  { id:'continuous.high-level-observer', phase:'continuous', sourcePattern:/high level, simple communication|high-level and out of the weeds/i, sample:'Observer communication must stay high-level and goal-tied.', role:'observer-1', authority:'live-requeried-message', core:false, failure:'correct-next-synthesis', waiverPolicy:'phase-transition' },
  { id:'continuous.visible-observer-coordination', phase:'continuous', sourcePattern:/coordination.*VISIBLY|reconciled visibly|visible reconciliation/i, sample:'Evidence-bearing observer coordination must remain visible.', role:'observer-2', authority:'live-requeried-message', core:true, failure:'repost-visibly' },
  { id:'continuous.derive-counts', phase:'continuous', sourcePattern:/derive every count|engine-accepted count leading|NUMERIC exit bar/i, sample:'Every count must be derived from evidence.', role:'echo', authority:'deterministic-replay', core:false, failure:'correct-before-report' },
  { id:'continuous.save-before-words', phase:'continuous', sourcePattern:/save before words|receipt-backed lifecycle evidence|no prose translation|receipt-gated/i, sample:'Artifacts must be saved before completion words.', role:'echo', authority:'content-bound-store-row', core:true, failure:'block-completion-claim' },
  { id:'continuous.80-20', phase:'continuous', sourcePattern:/80\/20|Pareto|work-plus-soak is done/i, sample:'The 80/20 boundary must be reviewed.', role:'observer-1', authority:'live-requeried-message', core:false, failure:'scope-timebox-review', waiverPolicy:'phase-transition' },
  { id:'continuous.scope-drift', phase:'continuous', sourcePattern:/scope change|remains inside charter|Standing rules/i, sample:'Work must remain inside the charter.', role:'observer-1', authority:'live-requeried-message', core:false, failure:'block-new-scope-and-register-debt', waiverPolicy:'phase-transition' },
  { id:'mid.reaffirmation', phase:'mid', sourcePattern:/middle[^.\n]{0,120}reaffirm|reaffirm[^.\n]{0,120}middle|beginning, middle, and end/i, sample:'Mid-window reaffirmation must be verified.', role:'observer-1', authority:'live-requeried-message', core:true, failure:'block-new-scope-and-escalate' },
  { id:'mid.plan-position-check', phase:'mid', sourcePattern:/Plan-tree placement|Canonical plan/i, sample:'Mid-window plan-position-check must be verified.', role:'observer-1', authority:'live-requeried-message', core:false, failure:'block-new-scope-and-escalate' },
  { id:'mid.worker-lane-status', phase:'mid', sourcePattern:/named lanes|Delegation .* lanes named/i, sample:'Mid-window worker-lane-status must be verified.', role:'observer-1', authority:'live-requeried-message', core:false, failure:'block-new-scope-and-escalate' },
  { id:'mid.cadence-health', phase:'mid', sourcePattern:/3-hour cadence|30 minute checks|Reporting & duty executors/i, sample:'Mid-window cadence-health must be verified.', role:'observer-1', authority:'live-requeried-message', core:false, failure:'block-new-scope-and-escalate' },
  { id:'mid.source-challenge-refresh', phase:'mid', sourcePattern:/tenets[^.\n]{0,100}compiled|compiled[^.\n]{0,100}tenets|source discipline|source contract/i, sample:'Mid-window source-challenge-refresh must be verified.', role:'observer-1', authority:'live-requeried-message', core:false, failure:'block-new-scope-and-escalate' },
  { id:'mid.executor-inventory', phase:'mid', sourcePattern:/NO running executor|executor|run must appear in the LIVE run listing/i, sample:'Mid-window executor-inventory must be verified.', role:'observer-1', authority:'runtime-registry-proof', core:false, failure:'block-new-scope-and-escalate' },
  ...[
    ['expiry-status',/24 hours|actual close time|ceiling 2026-/i,'content-bound-store-row'], ['end-reaffirmation',/beginning, middle, and end|end reaffirmation/i,'live-requeried-message'],
    ['plan-outcome.semantic-diff',/mandatory OUTPUT|plan outcome|window's honest result written onto the goal tree/i,'live-requeried-message'], ['plan-staleness-guard',/cannot claim closure.*stale|outcome remain stale/i,'deterministic-replay'],
    ['consumer-proof',/consumer proof|engine consumes/i,'deterministic-replay'], ['debt-register',/named debt|gap is Lane C|Standing debt carried with owners/i,'content-bound-store-row'],
    ['no-done-without-effect',/no "done" without the effect|effect confirmed|strong-form induced omission/i,'content-bound-store-row'], ['terminal-census',/closing cannot complete|negative tests per omitted duty|ENGINE must refuse the close/i,'deterministic-replay'],
  ].map(([id, sourcePattern, authority]) => ({ id:`close.${id}`, phase:'close' as const, sourcePattern:sourcePattern as RegExp, sample:`Close ${id} must pass.`, role:'observer-1', authority:authority as EvidenceAuthority, core:true, failure:'fail-close' })),
  { id:'postlive.verdict.pass-required', phase:'post-live', sourcePattern:/post-live verdict|post-live review|post-repair observation|Declared soak/i, sample:'A real or deterministic post-live pass is required.', role:'observer-2', authority:'deterministic-replay', core:true, failure:'fail-close' },
] as const;
export function minimumWindowDutyFixture(): string { return `${REQUIRED_WINDOW_DUTIES.map(d => d.sample).join('\n')}
Each observer independently scores and each observer must actually perform the read.
The observers combine the assessments; every unresolved disagreement is shown.
The admission-gate and opening cannot complete without evidence.
The tenets are compiled and tenets in force; the charter defines WINDOW LIFECYCLE.
The obligation ledger compiled with negative tests per omitted duty.
The start/mid/close lifecycle governs every phase.
Reaffirm at the beginning, middle, and end.
Canonical plan mandatory INPUT and mandatory OUTPUT with Plan-tree placement and plan outcome.
Named lanes include Lane A. The majority of development MUST be offloaded.
Use BOTH machines and MULTIPLE Codey workers.
Every 3 hours use a 3-hour cadence; 30 minute checks are required; the window is 24 hours.
The Telegram-through-my-account channel uses justin-telegram and the agent-signature protocol, never authorisation to act as Justin.
Communication stays high level, simple communication and high-level and out of the weeds.
Observer coordination occurs VISIBLY. Always derive every count, save before words, apply 80/20 Pareto, and remains inside charter with no scope change.
At middle and mid-window verify Plan-tree placement, named lanes, cadence, source, and executor.
Record actual close time after 24 hours, perform end reaffirmation, and cannot claim closure while stale.
Consumer proof and a post-live verdict are required; named debt includes owner; no "done" without the effect confirmed; closing cannot complete with an omitted duty.
`; }

const OPERATIVE = /\b(must|required|cannot|may not|never|shall|should|will not|before|after|by\s+\d|every\s+\d+|within\s+\d+|no later than|deadline|cadence|expires?|reaffirm|prohibit(?:ed|s)?)\b/i;
// Deliberately broader than the compiler vocabulary. This is the independent
// source-side tripwire: a newly authored normative form is discovered even
// when no compiler rule knows how to lower it yet.
const NORMATIVE_DISCOVERY = /\b(must|required|cannot|may not|never|shall|should|will not|before|after|by\s+\d|every\s+\d+|within\s+\d+|no later than|deadline|cadence|expires?|reaffirm|prohibit(?:ed|s)?|is obligated to|is forbidden from)\b/i;
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const canonicalize = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)])) : value;
const canonical = (value: unknown): string => JSON.stringify(canonicalize(value));

export function assertEchoScope(agentId: string, scope: string): void {
  if (agentId !== WINDOW_LEDGER_AGENT || scope !== WINDOW_LEDGER_SCOPE) throw new Error('echo-scope-required');
}

export function compileWindowSources(input: { agentId: string; scope: string; windowId: string; tenetsPath: string; charterPath: string; now?: string; requireMinimumCatalog?: boolean }): CompiledSources {
  assertEchoScope(input.agentId, input.scope);
  const now = input.now ?? new Date().toISOString();
  const sources = [input.tenetsPath, input.charterPath];
  const obligations: Obligation[] = [];
  const operativeLines: SourceSpan[] = [];
  const ast: SourceAstNode[] = [];
  const hashes: Record<string, string> = {};
  const byteLengths: Record<string, number> = {};
  for (const source of sources) {
    const bytes = fs.readFileSync(source);
    const text = bytes.toString('utf8');
    hashes[source] = hash(bytes); byteLengths[source] = bytes.length;
    let byteOffset = 0;
    text.split(/\n/).forEach((line, index) => {
      const lineBytes = Buffer.byteLength(line);
      const span = { source, hash: hashes[source], byteStart: byteOffset, byteEnd: byteOffset + lineBytes, lineStart: index + 1, lineEnd: index + 1 };
      const trimmed = line.trim();
      if (trimmed) ast.push({ kind: /^#{1,6}\s/.test(trimmed) ? 'heading' : /^[-*+]\s/.test(trimmed) ? 'list-item' : 'paragraph', text: trimmed, span, operative: NORMATIVE_DISCOVERY.test(trimmed) });
      if (OPERATIVE.test(line)) {
        operativeLines.push(span);
        obligations.push({
          id: `source.${hash(`${path.basename(source)}:${hashes[source]}:${byteOffset}:${line}`).slice(0, 20)}`, agentId: input.agentId, scope: input.scope, windowId: input.windowId,
          sourceSpans: [span], statement: line.trim(), phase: inferPhase(line), coreDuty: /tenet|never|must|required|cannot|shall|may not/i.test(line),
          waiverPolicy: /tenet|never|must|required|cannot|shall|may not/i.test(line) ? 'non-waivable' : 'debt-only', responsibleRole: inferRole(line),
          deadline: { dueAt: inferDueAt(line, now), graceMs: /every|cadence/i.test(line) ? RECURRING_DUTY_DEFAULT_GRACE_MS : 0 }, predicate: { recurring: /every|cadence/i.test(line), requiredAuthority: 'content-bound-store-row' },
          evidencePolicy: { requiredAuthority: 'content-bound-store-row' }, executorBinding: emptyBinding(), failureAction: 'block-and-surface', status: 'pending', evidence: [], lastEvaluatedAt: null,
        });
      }
      byteOffset += lineBytes + 1;
    });
  }
  const facts = {
    profiles: ast.flatMap(n => n.text.match(/`?[a-z]+-telegram`?/gi) ?? []),
    fingerprints: ast.flatMap(n => n.text.match(/\b[a-f0-9]{16,64}\b/gi) ?? []),
    dates: ast.flatMap(n => n.text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []),
    cadences: ast.flatMap(n => n.text.match(/\b(?:(?:every|within)\s+)?\d+[- ](?:minutes?|hours?|hour)\b/gi) ?? []),
  };
  const allText = ast.map(n => n.text).join('\n');
  const challenges = {
    telegramProfile: facts.profiles[0]?.replace(/`/g, '') ?? '', telegramFingerprint: facts.fingerprints[0] ?? '',
    pathwayStart: allText.match(/starting from ([A-Z][a-z]+ \d{1,2})/i)?.[1] ?? '',
    canonicalPlanId: allText.match(/\b[0-9a-f]{8}-[0-9a-f-]{27,36}\b/i)?.[0] ?? '',
    reportCadence: facts.cadences.find(v => /3[- ]hours?/i.test(v)) ?? '', stallCadence: facts.cadences.find(v => /30[- ]minutes?/i.test(v)) ?? '',
    charterExpiry: allText.match(/\bending\s+(\d{4}-\d{2}-\d{2}\s+~?\d{1,2}:\d{2}\s+[A-Z]{2,5})/i)?.[1]?.trim() ?? (allText.match(/24 hours/i)?.[0] ?? ''),
  };
  const charterDurationMs = ast.some(n => /24 hours|24h/i.test(n.text)) ? 24 * 3_600_000 : 24 * 3_600_000;
  for (const definition of input.requireMinimumCatalog === false ? [] : REQUIRED_WINDOW_DUTIES) {
    const matchedSpans = (definition.sourcePatterns ?? [definition.sourcePattern]).map(pattern => { const node = ast.find(candidate => pattern.test(candidate.text)); if (!node) throw new Error(`uncompiled-operative-duty:${definition.id}`); pattern.lastIndex = 0; const matched = pattern.exec(node.text); if (!matched) throw new Error(`uncompiled-operative-duty:${definition.id}`); const prefixBytes = Buffer.byteLength(node.text.slice(0, matched.index)); const matchBytes = Buffer.byteLength(matched[0]); return { ...node.span, byteStart: node.span.byteStart + prefixBytes, byteEnd: node.span.byteStart + prefixBytes + matchBytes }; });
    const futurePhase = definition.phase === 'mid' || definition.phase === 'close' || definition.phase === 'post-live';
    const sourceText = ast.find(candidate => definition.sourcePattern.test(candidate.text))?.text ?? definition.sample; definition.sourcePattern.lastIndex = 0; const dueAt = definition.phase === 'mid' ? new Date(Date.parse(now) + charterDurationMs / 2).toISOString() : (definition.phase === 'close' || definition.phase === 'post-live') ? new Date(Date.parse(now) + charterDurationMs).toISOString() : inferDueAt(sourceText, now);
    obligations.push({ id: definition.id, agentId: input.agentId, scope: input.scope, windowId: input.windowId, sourceSpans: matchedSpans, statement: definition.sample,
      phase: definition.phase, coreDuty: definition.core, waiverPolicy: definition.waiverPolicy ?? (definition.core ? 'non-waivable' : 'debt-only'), responsibleRole: definition.role,
      deadline: { dueAt, graceMs: definition.recurring ? RECURRING_DUTY_DEFAULT_GRACE_MS : 0 }, predicate: { recurring: definition.recurring, requiredAuthority: definition.authority, expected: expectedFactsForDuty(definition.id, challenges) }, evidencePolicy: { requiredAuthority: definition.authority },
      executorBinding: emptyBinding(), failureAction: definition.failure, status: 'pending', evidence: [], eligibleAt: futurePhase ? dueAt : undefined, lastEvaluatedAt: null });
  }
  const compiled = { hashes, byteLengths, obligations, operativeLines, ast, facts, challenges };
  const coverage = verifyCompilationCoverage(compiled); if (!coverage.ok) throw new Error(coverage.issues.join(',')); return compiled;
}

function inferPhase(line: string): LifecyclePhase {
  if (/post[- ]live/i.test(line)) return 'post-live'; if (/close|end reaffirm/i.test(line)) return 'close';
  if (/middle|mid[- ]window/i.test(line)) return 'mid'; if (/every|cadence|interval|hour/i.test(line)) return 'cadence';
  if (/before|pre[- ]start|reread/i.test(line)) return 'pre-start'; if (/start|beginning/i.test(line)) return 'start'; return 'continuous';
}
function inferRole(line: string): string { const found = line.match(/observer[- ]?[12]|codey|operator/i); return found?.[0].toLowerCase().replace(' ', '-') ?? 'echo'; }
function inferDueAt(line: string, now: string): string { const match = line.match(/(?:within|every)\s+(\d+)\s*(minute|hour)/i); if (!match) return now; const ms = Number(match[1]) * (match[2].toLowerCase() === 'hour' ? 3_600_000 : 60_000); return new Date(Date.parse(now) + ms).toISOString(); }
function emptyBinding(): ExecutorBinding { return { kind: 'unassigned', executorId: '', owner: '', registryCoordinates: '', enabled: false, dryRun: true }; }
function expectedFactsForDuty(id: string, challenges: Record<string, string>): Record<string, string> {
  if (id.includes('profile-resolved')) return { profile: challenges.telegramProfile };
  if (id.includes('signature-verified')) return { fingerprint: challenges.telegramFingerprint };
  if (id.includes('pathway')) return { pathwayStart: challenges.pathwayStart };
  if (id.includes('plan')) return { canonicalPlanId: challenges.canonicalPlanId };
  if (id.includes('report') && id.includes('cadence')) return { cadence: challenges.reportCadence };
  if (id.includes('stall') && id.includes('cadence')) return { cadence: challenges.stallCadence };
  if (id.includes('expiry')) return { charterExpiry: challenges.charterExpiry };
  return {};
}

function validTime(value: string | undefined): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

export function verifyCompilationCoverage(compiled: CompiledSources): { ok: boolean; issues: string[] } {
  const covered = new Set(compiled.obligations.flatMap(o => o.sourceSpans.map(s => `${s.source}:${s.hash}:${s.byteStart}:${s.byteEnd}`)));
  const independentlyDiscovered = compiled.ast?.filter(n => n.operative).map(n => n.span) ?? compiled.operativeLines;
  const issues = independentlyDiscovered.filter(s => !covered.has(`${s.source}:${s.hash}:${s.byteStart}:${s.byteEnd}`)).map(s => `uncompiled-operative-duty:${s.source}:${s.lineStart}`);
  return { ok: issues.length === 0, issues };
}

export function classifyExecutor(obligation: Obligation, now = new Date().toISOString()): ExecutorClass {
  if (obligation.status === 'satisfied' && !obligation.predicate.recurring) return 'completed-one-shot';
  if (obligation.eligibleAt && Date.parse(obligation.eligibleAt) > Date.parse(now)) return 'future-phase';
  return 'pending-executable';
}

export function evaluateExecutor(obligation: Obligation, now = new Date().toISOString()): { ok: boolean; class: ExecutorClass; issues: string[] } {
  if (!validTime(now) || !validTime(obligation.deadline.dueAt)) return { ok: false, class: classifyExecutor(obligation, now), issues: ['invalid-timestamp'] };
  const cls = classifyExecutor(obligation, now); const b = obligation.executorBinding; const issues: string[] = [];
  if (b.class && b.class !== cls) issues.push('executor-class-mismatch');
  if (cls === 'completed-one-shot') {
    const required = obligation.evidencePolicy.requiredAuthority;
    if (!obligation.evidence.some(e => evidenceApplies(e, obligation) && authoritySatisfies(e.authority, required))) issues.push('durable-completion-evidence-missing');
  } else if (cls === 'future-phase') {
    if (!b.owner) issues.push('owner-missing'); if (!b.enabled || b.dryRun) issues.push('trigger-disabled');
    if (!b.triggerEnabled || !b.durableTriggerState) issues.push('trigger-state-missing');
    if (!b.eligibilityAt || Date.parse(b.eligibilityAt) > Date.parse(obligation.deadline.dueAt) + obligation.deadline.graceMs) issues.push('eligibility-after-deadline');
  } else {
    if (!b.owner || !b.executorId || !b.registryCoordinates) issues.push('runtime-assignment-missing');
    if (!b.enabled || b.dryRun || !b.running) issues.push('executor-not-running');
    const heartbeatAge = validTime(b.heartbeatAt) ? Date.parse(now) - Date.parse(b.heartbeatAt) : Infinity;
    if (!validTime(b.heartbeatAt) || heartbeatAge < 0 || heartbeatAge > (b.heartbeatMaxAgeMs ?? 60_000)) issues.push('heartbeat-stale');
    if (!validTime(b.nextAttemptAt) || Date.parse(b.nextAttemptAt) > Date.parse(obligation.deadline.dueAt) + obligation.deadline.graceMs) issues.push('attempt-not-timely');
    if (b.deliversOutput && (!b.sinkReachable || b.suppressionActive)) issues.push('delivery-path-unavailable');
    if (b.needsClientDriver && (!b.driverPresent || !b.driverMatches)) issues.push('client-driver-unavailable');
  }
  return { ok: issues.length === 0, class: cls, issues };
}

function evidenceApplies(e: EvidenceRecord, o: Obligation): boolean {
  return e.verifierPassed && e.agentId === o.agentId && e.scope === o.scope && e.windowId === o.windowId && e.obligationId === o.id && e.sourceHashes.length > 0 && e.sourceHashes.every(h => o.sourceSpans.some(s => s.hash === h)) && predicateSatisfied(o, e);
}

/** A verified transport proves provenance, not meaning. Semantic duties require
 * a canonical, instance-bound proof envelope emitted by their named authority. */
export function predicateSatisfied(obligation: Obligation, evidence: EvidenceRecord): boolean {
  if (obligation.id === 'preground.native-structural-preflight') return evidence.authority === 'native-local-store-presence';
  if (!evidence.verifiedPayload) return false;
  if (/reaffirmation/.test(obligation.id)) return evidence.authority === 'live-requeried-message' && obligation.sourceSpans.some(span => hash(evidence.verifiedPayload!) === span.hash);
  let proof: Record<string, unknown>; try { proof = JSON.parse(evidence.verifiedPayload) as Record<string, unknown>; } catch { /* @silent-fallback-ok — malformed authority evidence fails closed */ return false; }
  if (proof.obligationId !== obligation.id || proof.verdict !== 'pass') return false;
  const proofHashes = proof.sourceHashes; if (!Array.isArray(proofHashes) || proofHashes.length === 0 || !proofHashes.every(v => typeof v === 'string' && obligation.sourceSpans.some(s => s.hash === v))) return false;
  if (/plan-(?:input|position|outcome|staleness)/.test(obligation.id) && (typeof proof.planNodeId !== 'string' || proof.charterIncluded !== true)) return false;
  if (obligation.id === 'start.named-worker-lanes' && (!Array.isArray(proof.laneIds) || proof.laneIds.length < 2 || typeof proof.laneSourceHash !== 'string' || !proof.laneSourceHash)) return false;
  if (obligation.id === 'start.delegation-majority-boundary') { const assignments = proof.workerAssignments as Array<{ laneId?: unknown; transcriptHash?: unknown }> | undefined; if (!Array.isArray(assignments) || assignments.length < 2 || !assignments.every(item => typeof item.laneId === 'string' && typeof item.transcriptHash === 'string' && /^[a-f0-9]{64}$/.test(item.transcriptHash)) || typeof proof.offloadedLaneShare !== 'number' || proof.offloadedLaneShare < 0.5) return false; }
  if (obligation.id === 'start.machine-model-distribution') { const assignments = proof.workerAssignments as Array<{ machineId?: unknown; laneId?: unknown }> | undefined; const distinctMachines = Array.isArray(assignments) ? new Set(assignments.map(item => item.machineId).filter(value => typeof value === 'string')) : new Set(); if ((distinctMachines.size < 2 || !assignments?.every(item => typeof item.laneId === 'string')) && proof.machineBlockerVerified !== true) return false; }
  if (/visible|discussion|disagreement|combined-recommendation/.test(obligation.id) && proof.visibleTopicId !== 43003) return false;
  for (const [key, expected] of Object.entries(obligation.predicate.expected ?? {})) if (proof[key] !== expected) return false;
  if (/profile-resolved/.test(obligation.id) && (proof.profile !== 'justin-telegram' || proof.profileAuthority !== 'playwright-profile-registry')) return false;
  if (/send-path-classified/.test(obligation.id) && proof.signedAgentId !== 'echo') return false;
  if (/signature-verified/.test(obligation.id) && (proof.signatureVerified !== true || proof.signedAgentId !== 'echo' || proof.fingerprint !== obligation.predicate.expected?.fingerprint)) return false;
  if (/act-as-principal/.test(obligation.id) && (proof.principalRiskCleared !== true || proof.signedAgentId !== 'echo')) return false;
  if (/derive-counts/.test(obligation.id)) { const counts = proof.counts; if (!Array.isArray(counts) || counts.length === 0 || !counts.every(item => { const row = item as { value?: unknown; items?: unknown }; return Number.isInteger(row.value) && Array.isArray(row.items) && row.value === row.items.length; })) return false; }
  if (/save-before-words/.test(obligation.id)) { if (typeof proof.artifactPath !== 'string' || typeof proof.artifactHash !== 'string') return false; try { if (hash(fs.readFileSync(proof.artifactPath)) !== proof.artifactHash) return false; } catch { /* @silent-fallback-ok — unreadable artifact cannot satisfy the duty */ return false; } }
  if (/80-20/.test(obligation.id) && (proof.reviewed !== true || proof.visibleTopicId !== 36966)) return false;
  if (/scope-drift/.test(obligation.id)) { const debt = proof.debt as { owner?: unknown; status?: unknown } | undefined; if (proof.reviewed !== true || proof.visibleTopicId !== 36966 || typeof debt?.owner !== 'string' || debt.status !== 'open') return false; }
  if (/^cadence\.report\.3h@/.test(obligation.id) && (proof.deliveredTopicId !== 36966 || typeof proof.reportBodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(proof.reportBodyHash) || proof.synthesisSectionsVerified !== true)) return false;
  if (/^cadence\.stall-check\.30m@/.test(obligation.id)) { if (typeof proof.watchdogAuthorityEpoch !== 'string' || proof.watchdogAuthorityEpoch.length < 8 || typeof proof.watchdogAuthorityProof !== 'string' || !/^[a-f0-9]{64}$/.test(proof.watchdogAuthorityProof)) return false; const inspected = proof.inspectedSessionIds; const active = proof.activeSessionIds; const results = proof.sessionResults as Array<{ name?: unknown; outputObserved?: unknown; escalationActive?: unknown; decisionEvaluated?: unknown; decisionEvaluatedAt?: unknown }> | undefined; if (proof.watchdogEnabled !== true || !Number.isSafeInteger(proof.watchdogPollRevision) || Number(proof.watchdogPollRevision) < 1 || !Array.isArray(inspected) || !Array.isArray(active) || canonical(inspected) !== canonical(active) || !Array.isArray(results) || results.length !== active.length || !results.every(result => typeof result.name === 'string' && typeof result.outputObserved === 'boolean' && typeof result.escalationActive === 'boolean' && result.decisionEvaluated === true && typeof result.decisionEvaluatedAt === 'string' && validTime(result.decisionEvaluatedAt)) || typeof proof.inspectionHash !== 'string' || !/^[a-f0-9]{64}$/.test(proof.inspectionHash)) return false; }
  if (/expiry-status/.test(obligation.id) && proof.expiryVerified !== true) return false;
  if (/consumer-proof/.test(obligation.id) && proof.consumerObserved !== true) return false;
  if (/postlive/.test(obligation.id) && proof.postLivePassed !== true) return false;
  return true;
}

function authoritySatisfies(actual: EvidenceAuthority, required: EvidenceAuthority): boolean {
  const compatible: Record<EvidenceAuthority, EvidenceAuthority[]> = {
    'native-local-store-presence': ['native-local-store-presence'],
    'content-bound-store-row': ['content-bound-store-row', 'live-requeried-message', 'replicated-export', 'verified-operator-approval'],
    'live-requeried-message': ['live-requeried-message', 'verified-operator-approval'],
    'replicated-export': ['replicated-export'], 'verified-operator-approval': ['verified-operator-approval'],
    'runtime-registry-proof': ['runtime-registry-proof'], 'deterministic-replay': ['deterministic-replay'],
  };
  return compatible[required].includes(actual);
}

/** Re-queries the production registry and replaces every caller-supplied runtime
 * fact. The request may name an executor id; it cannot assert its liveness. */
export function bindRuntimeAuthority(obligation: Obligation, registry: WindowRuntimeRegistry): Obligation {
  const copy = structuredClone(obligation);
  const real = registry.resolve(copy.executorBinding.executorId, copy.id);
  copy.executorBinding = real ? { ...real, class: copy.executorBinding.class, heartbeatMaxAgeMs: copy.executorBinding.heartbeatMaxAgeMs } : emptyBinding();
  return copy;
}

/** Re-queries evidence and drops vanished/unbound records. Authority labels in
 * ledger JSON never survive unless the verifier independently earns them. */
export function bindEvidenceAuthority(obligation: Obligation, authority: WindowEvidenceAuthority): Obligation {
  const copy = structuredClone(obligation);
  copy.evidence = copy.evidence.flatMap(record => { const verified = authority.requery(record); return verified ? [verified] : []; });
  return copy;
}

export function evaluateFromAuthorities(obligations: Obligation[], runtime: WindowRuntimeRegistry, evidence: WindowEvidenceAuthority, now = new Date().toISOString()) {
  return evaluateObligations(obligations.map(o => bindEvidenceAuthority(bindRuntimeAuthority(o, runtime), evidence)), now);
}

/** Production local-store verifier. Local rows earn only content-bound-store-row;
 * live authority requires the supplied live re-query seam and verified actor. */
export class ProductionMessageEvidenceAuthority implements WindowEvidenceAuthority {
  constructor(private readonly storePath: string, private readonly liveRequery?: (topicId: number, messageId: number) => LiveMessageRow | null) {}
  requery(record: EvidenceRecord): EvidenceRecord | null {
    const c = record.nativeCoordinates; if (!c || !Number.isInteger(c.topicId) || !Number.isInteger(c.messageId)) return null;
    let row: LiveMessageRow | undefined;
    try {
      row = fs.readFileSync(this.storePath, 'utf8').split(/\n/).filter(Boolean).map(line => JSON.parse(line) as LiveMessageRow).find(item => item.topicId === c.topicId && item.messageId === c.messageId);
    } catch { /* @silent-fallback-ok — unreadable evidence store earns no authority */ return null; }
    if (!row || hash(row.text) !== record.canonicalPayloadHash) return null;
    if (record.authority === 'content-bound-store-row') return { ...record, authority: 'content-bound-store-row', verifierPassed: true, verifiedPayload: row.text };
    const live = this.liveRequery?.(c.topicId!, c.messageId!);
    if (!live || live.text !== row.text || live.topicId !== row.topicId || live.messageId !== row.messageId) return null;
    if (record.authority === 'verified-operator-approval' && !live.verifiedOperator) return null;
    return { ...record, authority: record.authority === 'verified-operator-approval' ? 'verified-operator-approval' : 'live-requeried-message', verifierPassed: true, verifiedPayload: live.text };
  }
}

export class ProductionRuntimeRegistry implements WindowRuntimeRegistry {
  constructor(private readonly snapshot: () => RuntimeExecutorSnapshot[]) {}
  resolve(executorId: string, obligationId: string): RuntimeExecutorSnapshot | null {
    const rows = this.snapshot();
    const matches = rows.filter(row => (!executorId || row.executorId === executorId) && row.registryCoordinates === `obligation:${obligationId}`);
    return matches.length === 1 ? structuredClone(matches[0]) : null;
  }
}

export function evaluateObligations(obligations: Obligation[], now = new Date().toISOString()): { admitted: boolean; obligations: Obligation[]; issues: string[] } {
  const issues: string[] = [];
  const evaluated = obligations.map(original => {
    const obligation = structuredClone(original);
    const hasProof = obligation.evidence.some(e => evidenceApplies(e, obligation) && authoritySatisfies(e.authority, obligation.evidencePolicy.requiredAuthority));
    if (hasProof && ['pending', 'unknown', 'open-unexecuted', 'blocked', 'failed'].includes(obligation.status)) obligation.status = 'satisfied';
    if (!hasProof && obligation.status === 'satisfied') obligation.status = 'unknown';
    const result = evaluateExecutor(obligation, now); obligation.lastEvaluatedAt = now;
    if (!hasProof && (obligation.phase === 'pre-start' || obligation.phase === 'start')) result.issues.push('predicate-unsatisfied');
    if (!result.ok && obligation.status === 'pending') obligation.status = 'open-unexecuted';
    result.issues.forEach(issue => issues.push(`${obligation.id}:${issue}`)); return obligation;
  });
  return { admitted: issues.length === 0 && evaluated.every(o => !['pending', 'unknown', 'open-unexecuted', 'failed', 'blocked', 'expired'].includes(o.status) || !['pre-start', 'start'].includes(o.phase)), obligations: evaluated, issues };
}

export function transitionFuturePhase(obligation: Obligation, now: string): Obligation {
  const copy = structuredClone(obligation);
  if (classifyExecutor(copy, now) === 'future-phase') return copy;
  if (copy.status !== 'pending') return copy;
  const result = evaluateExecutor(copy, now); copy.status = result.ok ? 'pending' : 'open-unexecuted'; return copy;
}

export function materializeCadenceInstances(ledger: LedgerDocument, through: string): LedgerDocument {
  if (!validTime(through)) throw new Error('invalid-timestamp'); const copy = structuredClone(ledger);
  for (const template of copy.obligations.filter(o => o.predicate.recurring && !o.id.includes('@'))) {
    const interval = template.id.includes('30m') ? 30 * 60_000 : template.id.includes('3h') ? 3 * 3_600_000 : 0; if (!interval) continue;
    const start = Date.parse(template.deadline.dueAt); if (Date.parse(through) < start) continue;
    for (let due = start; due <= Date.parse(through); due += interval) {
      const id = `${template.id}@${new Date(due).toISOString()}`; if (copy.compiledObligationIds.includes(id)) continue;
      const instance = structuredClone(template); instance.id = id; instance.deadline.dueAt = new Date(due).toISOString(); instance.eligibleAt = instance.deadline.dueAt; instance.predicate.recurring = true; instance.status = 'pending'; instance.evidence = []; instance.lastEvaluatedAt = null;
      copy.obligations.push(instance); copy.compiledObligationIds.push(id);
    }
  }
  return copy;
}

export function evaluateLifecycleTick(ledger: LedgerDocument, runtime: WindowRuntimeRegistry, evidence: WindowEvidenceAuthority, now = new Date().toISOString()): { ledger: LedgerDocument; issues: string[] } {
  let next = materializeCadenceInstances(ledger, now); next.obligations = next.obligations.map(o => transitionFuturePhase(o, now));
  const result = evaluateFromAuthorities(next.obligations, runtime, evidence, now); next.obligations = result.obligations;
  if (result.issues.length && next.state === 'active_mid_due') next.state = 'active_mid_blocked';
  if (result.issues.length && ['close_due', 'delivered_pending_post_live'].includes(next.state)) next.state = 'close_blocked';
  next.requiredRemediations = next.obligations
    .filter(o => ['pending', 'unknown', 'open-unexecuted', 'failed', 'blocked', 'expired'].includes(o.status))
    .map(deriveFailureRemediation);
  return { ledger: next, issues: result.issues };
}

export interface ClosureAuthority { now?: string; requeryWaiverApproval?: (waiver: Waiver) => boolean }
export function evaluateClosure(ledger: LedgerDocument, _callerExpectedIds?: string[], authority: ClosureAuthority = {}): { state: LifecycleState; issues: string[] } {
  assertEchoScope(ledger.agentId, ledger.scope); const issues: string[] = [];
  const ids = new Set(ledger.obligations.map(o => o.id)); if (ids.size !== ledger.obligations.length) issues.push('census-duplicate'); ledger.compiledObligationIds.filter(id => !ids.has(id)).forEach(id => issues.push(`census-missing:${id}`));
  if ((ledger.nativeEvaluations.at(-1)?.output as { admitted?: boolean } | undefined)?.admitted !== true) issues.push('native-structural-preflight-missing-or-refused');
  ids.forEach(id => { if (!ledger.compiledObligationIds.includes(id)) issues.push(`census-uncompiled:${id}`); });
  for (const o of ledger.obligations) {
    if (['pending', 'unknown', 'open-unexecuted', 'failed', 'blocked', 'expired'].includes(o.status)) issues.push(`nonterminal:${o.id}:${o.status}`);
    if (o.status === 'waived-for-debt') issues.push(`debt-waiver-does-not-close:${o.id}`);
    if (o.status === 'waived-for-phase-transition') {
      const waiver = ledger.waivers?.find(w => w.obligationIds.includes(o.id)); const now = authority.now ?? new Date().toISOString();
      if (!waiver || !validTime(waiver.expiresAt) || Date.parse(waiver.expiresAt) <= Date.parse(now) || waiver.approvedDigest !== waiver.digest || !waiver.operatorPrincipalId || !waiver.approvalCoordinates || !authority.requeryWaiverApproval?.(waiver)) issues.push(`waiver-invalid-at-close:${o.id}`);
      else { const { digest: _d, operatorPrincipalId: _o, approvedDigest: _a, approvedAt: _t, approvalCoordinates: _c, ...payload } = waiver; if (waiver.digest !== waiverDigest(payload)) issues.push(`waiver-invalid-at-close:${o.id}`); }
    }
    if (o.coreDuty && o.status.startsWith('waived')) issues.push(`core-duty-waived:${o.id}`);
    if (o.status === 'satisfied' && !o.evidence.some(e => evidenceApplies(e, o) && authoritySatisfies(e.authority, o.evidencePolicy.requiredAuthority))) issues.push(`completion-evidence-invalid:${o.id}`);
  }
  if (issues.length) return { state: 'close_blocked', issues };
  return { state: ledger.obligations.some(o => o.status === 'waived-for-phase-transition') ? 'closed_with_operator_waiver' : 'closed_clean', issues };
}

export interface Waiver { id: string; obligationIds: string[]; reason: string; agentId: string; scope: string; windowId: string; phase: LifecyclePhase; permit: 'debt-only' | 'phase-transition'; expiresAt: string; nonce: string; nonTransferable: true; createdAt: string; digest: string; operatorPrincipalId?: string; approvedDigest?: string; approvedAt?: string; approvalCoordinates?: { topicId: number; messageId: number } }
export function waiverDigest(waiver: Omit<Waiver, 'digest' | 'operatorPrincipalId' | 'approvedDigest' | 'approvedAt' | 'approvalCoordinates'>): string { return hash(canonical(waiver)); }
export interface RollbackRequest { agentId: 'echo'; scope: 'echo-window-lifecycle'; windowId: string; reason: string; nonce: string; createdAt: string; digest: string; approvalCoordinates: { topicId: number; messageId: number } }
export interface WindowDryRunResult { passed: boolean; command: string; completedAt: string; outputHash: string; testInventory: string[] }
export const WINDOW_DRY_RUN_INVENTORY = ['tests/unit/window-lifecycle-obligation-ledger.test.ts', 'tests/integration/window-lifecycle-ledger-store.test.ts', 'tests/integration/window-lifecycle-native-adapter.test.ts', 'tests/e2e/window-lifecycle-executor-incident.test.ts', 'tests/e2e/window-lifecycle-production-wiring.test.ts'] as const;
export function rollbackDigest(request: Omit<RollbackRequest, 'digest' | 'approvalCoordinates'>): string { return hash(canonical(request)); }
export function validateWaiver(waiver: Waiver, ledger: LedgerDocument, locallyBoundOperatorId: string, now = new Date().toISOString()): string[] {
  assertEchoScope(waiver.agentId, waiver.scope); const issues: string[] = [];
  if (waiver.windowId !== ledger.windowId) issues.push('wrong-window'); if (!waiver.obligationIds.length || waiver.obligationIds.some(id => /[*]/.test(id))) issues.push('wildcard-or-empty');
  if (ledger.usedNonces.includes(waiver.nonce)) issues.push('nonce-replay'); if (!validTime(now) || !validTime(waiver.expiresAt) || !validTime(waiver.createdAt) || Date.parse(waiver.expiresAt) <= Date.parse(now)) issues.push('waiver-expired');
  if (waiver.nonTransferable !== true) issues.push('waiver-transferable');
  const { digest: _d, operatorPrincipalId: _o, approvedDigest: _a, approvedAt: _t, approvalCoordinates: _c, ...payload } = waiver;
  if (waiver.digest !== waiverDigest(payload)) issues.push('digest-altered'); if (waiver.operatorPrincipalId !== locallyBoundOperatorId) issues.push('wrong-principal');
  if (waiver.approvedDigest !== waiver.digest || !waiver.approvedAt || !validTime(waiver.approvedAt) || Date.parse(waiver.approvedAt) <= Date.parse(waiver.createdAt) || !waiver.approvalCoordinates) issues.push('approval-unbound-or-precreated');
  for (const id of waiver.obligationIds) { const o = ledger.obligations.find(item => item.id === id); if (!o) issues.push(`unknown-obligation:${id}`); else if (o.phase !== waiver.phase) issues.push(`wrong-phase:${id}`); else if (o.coreDuty || o.waiverPolicy === 'non-waivable') issues.push(`core-duty-non-waivable:${id}`); else if (waiver.permit === 'phase-transition' && o.waiverPolicy !== 'phase-transition') issues.push(`phase-transition-not-permitted:${id}`); }
  return issues;
}

export function createLedger(input: { agentId: string; scope: string; windowId: string; compiled: CompiledSources }): LedgerDocument {
  assertEchoScope(input.agentId, input.scope); const ledger: LedgerDocument = { version: 1, lifecycleRunId: crypto.randomUUID(), agentId: 'echo', scope: 'echo-window-lifecycle', windowId: input.windowId, state: 'pre_start_gate', sourceHashes: input.compiled.hashes, compiledObligationIds: input.compiled.obligations.map(o => o.id), obligations: input.compiled.obligations, usedNonces: [], nativeEvaluations: [], waivers: [] };
  const closeAt = ledger.obligations.filter(o => o.phase === 'close' || o.phase === 'post-live').map(o => Date.parse(o.deadline.dueAt)).filter(Number.isFinite);
  return closeAt.length ? materializeCadenceInstances(ledger, new Date(Math.max(...closeAt)).toISOString()) : ledger;
}

const TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  idle: ['pre_start_gate'], pre_start_gate: ['start_blocked', 'active_start', 'rolled_back'], start_blocked: ['pre_start_gate', 'rolled_back'],
  active_start: ['active_mid_due', 'rolled_back'], active_mid_due: ['active_mid_blocked', 'active_mid_satisfied', 'rolled_back'],
  active_mid_blocked: ['active_mid_due', 'rolled_back'], active_mid_satisfied: ['close_due', 'rolled_back'], close_due: ['close_blocked', 'delivered_pending_post_live', 'rolled_back'],
  close_blocked: ['close_due', 'rolled_back'], delivered_pending_post_live: ['close_blocked', 'closed_clean', 'closed_with_operator_waiver', 'rolled_back'],
  closed_clean: [], closed_with_operator_waiver: [], rolled_back: [],
};
export function transitionLedger(ledger: LedgerDocument, target: LifecycleState, closureAuthority?: ClosureAuthority): LedgerDocument {
  assertEchoScope(ledger.agentId, ledger.scope);
  if (!TRANSITIONS[ledger.state].includes(target)) throw new Error(`invalid-lifecycle-transition:${ledger.state}->${target}`);
  if (target === 'active_start' && (!ledger.admission || ledger.admission.snapshotDigest !== admissionSnapshotDigest(ledger) || (ledger.nativeEvaluations.at(-1)?.output as { admitted?: boolean } | undefined)?.admitted !== true)) throw new Error('admission-not-proven');
  const phaseReady = (phases: LifecyclePhase[]) => ledger.obligations.filter(o => phases.includes(o.phase)).every(o => o.status === 'waived-for-phase-transition' || (o.status === 'satisfied' && o.evidence.some(e => evidenceApplies(e, o) && authoritySatisfies(e.authority, o.evidencePolicy.requiredAuthority))));
  if (target === 'active_mid_due') { const eligible = ledger.obligations.filter(o => o.phase === 'mid').map(o => Date.parse(o.eligibleAt ?? o.deadline.dueAt)); if (eligible.length && Date.parse(closureAuthority?.now ?? new Date().toISOString()) < Math.min(...eligible)) throw new Error('mid-not-due'); }
  if (target === 'active_mid_satisfied' && !phaseReady(['mid'])) throw new Error('mid-phase-not-satisfied');
  if (target === 'close_due' && !phaseReady(['mid'])) throw new Error('mid-phase-not-satisfied');
  if (target === 'delivered_pending_post_live' && !phaseReady(['close'])) throw new Error('close-phase-not-satisfied');
  if (target === 'closed_clean' || target === 'closed_with_operator_waiver') { const closure = evaluateClosure(ledger, undefined, closureAuthority); if (closure.state !== target) throw new Error(`closure-refused:${closure.issues.join(',')}`); }
  const copy = structuredClone(ledger); copy.state = target; return copy;
}

export function applyWaiver(ledger: LedgerDocument, waiver: Waiver, locallyBoundOperatorId: string, now = new Date().toISOString()): LedgerDocument {
  const issues = validateWaiver(waiver, ledger, locallyBoundOperatorId, now); if (issues.length) throw new Error(`waiver-refused:${issues.join(',')}`);
  const copy = structuredClone(ledger); copy.usedNonces.push(waiver.nonce); copy.waivers ??= []; copy.waivers.push(waiver);
  for (const id of waiver.obligationIds) { const o = copy.obligations.find(item => item.id === id)!; o.status = waiver.permit === 'phase-transition' ? 'waived-for-phase-transition' : 'waived-for-debt'; }
  return copy;
}

export class EchoWindowLedgerStore {
  private readonly file: string;
  constructor(agentHome: string) { this.file = path.join(agentHome, 'window-lifecycle', 'ledger.json'); }
  load(agentId: string, scope: string): LedgerDocument | null { assertEchoScope(agentId, scope); if (!fs.existsSync(this.file)) return null; const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as LedgerDocument; this.validate(parsed); return parsed; }
  backupExisting(reason = 'manual', at = new Date().toISOString()): string | null { if (!fs.existsSync(this.file)) return null; const bytes = fs.readFileSync(this.file); const stamp = at.replace(/[:.]/g, '-'); const digest = hash(bytes).slice(0, 16); const backup = path.join(path.dirname(this.file), 'backups', `ledger.${stamp}.${reason}.${digest}.json`); fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 }); fs.writeFileSync(backup, bytes, { mode: 0o600 }); return backup; }
  save(ledger: LedgerDocument): void { this.validate(ledger); fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); const tmp = `${this.file}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, this.file); }
  appendNativeEvaluation(agentId: string, scope: string, record: NativeEvaluationRecord): LedgerDocument { const ledger = this.load(agentId, scope); if (!ledger) throw new Error('ledger-not-found'); if (record.agentId !== ledger.agentId || record.scope !== ledger.scope || record.windowId !== ledger.windowId) throw new Error('foreign-native-evaluation'); if (ledger.usedNonces.includes(record.nonce)) throw new Error('nonce-replay'); ledger.usedNonces.push(record.nonce); ledger.nativeEvaluations.push(record); ledger.admission = undefined; this.save(ledger); return ledger; }
  rollback(agentId: string, scope: string, request: RollbackRequest, operatorEvidence: EvidenceRecord, authority: WindowEvidenceAuthority, at = new Date().toISOString()): LedgerDocument { assertEchoScope(agentId, scope); const ledger = this.load(agentId, scope); if (!ledger) throw new Error('ledger-not-found'); const { digest: _digest, approvalCoordinates: _coords, ...payload } = request; if (request.windowId !== ledger.windowId || request.digest !== rollbackDigest(payload) || ledger.usedNonces.includes(request.nonce) || !validTime(request.createdAt) || Date.parse(request.createdAt) >= Date.parse(at)) throw new Error('invalid-rollback-payload'); const verified = authority.requery(operatorEvidence); if (!verified || verified.authority !== 'verified-operator-approval' || !verified.producer || verified.agentId !== ledger.agentId || verified.scope !== ledger.scope || verified.windowId !== ledger.windowId || verified.nativeCoordinates?.topicId !== request.approvalCoordinates.topicId || verified.nativeCoordinates?.messageId !== request.approvalCoordinates.messageId || verified.verifiedPayload?.trim() !== `approve rollback ${request.digest}`) throw new Error('verified-operator-rollback-required'); ledger.usedNonces.push(request.nonce); ledger.state = 'rolled_back'; ledger.rollback = { at, reason: request.reason, operatorEvidence: verified, operatorPrincipalId: verified.producer, windowId: ledger.windowId, scope: ledger.scope, enforcementDisabled: true, auditReadOnly: true, manualRitualRequired: true }; ledger.admission = undefined; this.save(ledger); return ledger; }
  reenable(agentId: string, scope: string, faultFixedEvidencePath: string, dryRunRunner?: () => WindowDryRunResult, at = new Date().toISOString()): LedgerDocument { assertEchoScope(agentId, scope); const ledger = this.load(agentId, scope); if (!ledger || ledger.state !== 'rolled_back' || !ledger.rollback) throw new Error('rollback-not-active'); let fixedHash: string; try { fixedHash = hash(fs.readFileSync(faultFixedEvidencePath)); } catch { throw new Error('fault-fixed-evidence-required'); } if (!dryRunRunner) throw new Error('dry-run-runner-required'); let suite: WindowDryRunResult; try { suite = dryRunRunner(); } catch { throw new Error('dry-run-suite-required'); } if (suite.passed !== true || !validTime(suite.completedAt) || Date.parse(suite.completedAt) < Date.parse(ledger.rollback.at) || !/^[a-f0-9]{64}$/.test(suite.outputHash) || !WINDOW_DRY_RUN_INVENTORY.every(file => suite.testInventory.includes(file))) throw new Error('dry-run-suite-required'); const suitePath = path.join(path.dirname(this.file), 'dry-run-suite.json'); fs.writeFileSync(suitePath, `${JSON.stringify({ ...suite, sourceHashes: ledger.sourceHashes }, null, 2)}\n`, { mode: 0o600 }); ledger.rollback.reenabledAt = at; ledger.rollback.faultFixedEvidence = `${faultFixedEvidencePath}#sha256:${fixedHash}`; ledger.rollback.dryRunSuitePassed = true; ledger.state = 'pre_start_gate'; this.save(ledger); return ledger; }
  private validate(ledger: LedgerDocument): void { assertEchoScope(ledger.agentId, ledger.scope); if (!/^[0-9a-f-]{36}$/.test(ledger.lifecycleRunId)) throw new Error('lifecycle-run-id-missing'); if (!Array.isArray(ledger.compiledObligationIds)) throw new Error('compiled-census-missing'); for (const n of ledger.nativeEvaluations) if (n.agentId !== ledger.agentId || n.scope !== ledger.scope || n.windowId !== ledger.windowId) throw new Error('foreign-native-evaluation'); for (const o of ledger.obligations) { assertEchoScope(o.agentId, o.scope); if (o.windowId !== ledger.windowId) throw new Error('cross-window-obligation'); for (const e of o.evidence) { assertEchoScope(e.agentId, e.scope); if (e.windowId !== ledger.windowId || e.obligationId !== o.id) throw new Error('foreign-evidence-binding'); } } }
}

export function runNativeAdmissionAdapter(input: { agentId: string; scope: string; windowId: string; stateDir: string; package: unknown; storePath?: string; nonce: string; installedContractVersion?: string; evaluatedAt?: string }): NativeEvaluationRecord {
  assertEchoScope(input.agentId, input.scope); if ((input.installedContractVersion ?? BETWEEN_WINDOW_ADMISSION_CONTRACT_VERSION) !== BETWEEN_WINDOW_ADMISSION_CONTRACT_VERSION) throw new Error('native-evaluator-incompatible'); if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.nonce)) throw new Error('invalid-native-evaluation-nonce'); const inputBytes = JSON.stringify(input.package); const selectedStore = input.storePath ?? path.join(input.stateDir, 'telegram-messages.jsonl');
  const output = evaluateBetweenWindowAdmission({ stateDir: input.stateDir, package: input.package, storePath: input.storePath } as Parameters<typeof evaluateBetweenWindowAdmission>[0]);
  const storeBytes = fs.readFileSync(selectedStore);
  return { agentId: 'echo', scope: 'echo-window-lifecycle', windowId: input.windowId, inputHash: hash(inputBytes), inputBytes, storePath: selectedStore, storeHash: hash(storeBytes), storeBytesLength: storeBytes.length, evaluatorVersion: NATIVE_ADMISSION_COMPATIBILITY, output, evaluatedAt: input.evaluatedAt ?? new Date().toISOString(), nonce: input.nonce, mapping: { admitted: 'preground.native-structural-preflight' } };
}

export function admissionSnapshotDigest(ledger: LedgerDocument): string {
  return hash(JSON.stringify({ sourceHashes: ledger.sourceHashes, ids: ledger.compiledObligationIds, obligations: ledger.obligations.map(o => ({ id: o.id, status: o.status, binding: o.executorBinding, evidence: o.evidence.map(e => ({ authority: e.authority, nonce: e.nonce, hash: e.canonicalPayloadHash, verifierPassed: e.verifierPassed })) })), native: ledger.nativeEvaluations.at(-1) ?? null }));
}

export function sourceFreshnessIssues(ledger: LedgerDocument): string[] {
  const issues: string[] = [];
  for (const [source, expected] of Object.entries(ledger.sourceHashes)) {
    try { if (hash(fs.readFileSync(source)) !== expected) issues.push(`stale-source:${source}`); }
    catch { issues.push(`source-unavailable:${source}`); }
  }
  return issues;
}

export type LifecycleGuardAction = 'new-scope' | 'telegram-send' | 'completion-claim';
export function deriveFailureRemediation(obligation: Obligation): FailureRemediation {
  const action = obligation.failureAction;
  const escalation = action === 'block-new-scope-and-escalate';
  const scopeReview = action === 'scope-timebox-review';
  return {
    obligationId: obligation.id, action,
    blockPhase: action === 'block-phase' || action === 'fail-close' || action === 'block-and-surface',
    blockNewScope: action.includes('block-new-scope') || scopeReview,
    blockSend: action === 'block-send',
    blockCompletion: action === 'block-completion-claim' || action === 'fail-close',
    observerTopicId: action === 'repost-visibly' || action === 'block-and-surface' ? 43003 : escalation || scopeReview || action.includes('register-debt') || action.startsWith('correct-') ? 36966 : undefined,
    debtRequired: action.includes('register-debt'), repostRequired: action === 'repost-visibly',
    correctionRequired: action.startsWith('correct-'), scopeReviewRequired: scopeReview,
  };
}
export function evaluateLifecycleGuard(ledger: LedgerDocument, action: LifecycleGuardAction): { allowed: boolean; reasons: string[] } {
  if (ledger.state === 'rolled_back') return action === 'telegram-send' ? { allowed: false, reasons: ['rollback:operator-account-send-disabled'] } : { allowed: true, reasons: [] };
  if (ledger.state === 'closed_clean' || ledger.state === 'closed_with_operator_waiver') return { allowed: true, reasons: [] };
  const unresolved = ledger.obligations.filter(o => ['pending', 'unknown', 'open-unexecuted', 'failed', 'blocked', 'expired'].includes(o.status));
  const selected = unresolved.filter(o => {
    const remediation = deriveFailureRemediation(o);
    return action === 'new-scope' ? remediation.blockNewScope
      : action === 'telegram-send' ? remediation.blockSend
        : remediation.blockCompletion || o.id.includes('no-done-without-effect') || o.id.includes('terminal-census');
  });
  return { allowed: selected.length === 0, reasons: selected.map(o => `${o.id}:${o.status}:${o.failureAction}`) };
}

export function runWindowLifecyclePostLiveCheck(ledger: LedgerDocument): { passed: boolean; inputHash: string; outputHash: string; reasons: string[] } {
  const probe = structuredClone(ledger); const target = probe.obligations.find(o => o.id === 'close.no-done-without-effect') ?? probe.obligations.find(o => o.failureAction.includes('block-completion'));
  if (!target) return { passed: false, inputHash: hash(canonical({ ids: probe.compiledObligationIds })), outputHash: hash('missing-probe-duty'), reasons: ['missing-completion-probe-duty'] };
  // Normalize unrelated lifecycle state so this replay is stable as later
  // evidence lands. The consumer under test is the real guard/closure pair,
  // and the single controlled fault is the compiled completion-blocking duty.
  // A persisted closed ledger is a valid input to this replay, but closed
  // states intentionally short-circuit the live guard. Re-enter the exact
  // pre-closure consumer state so the controlled omission exercises the
  // production completion guard instead of inheriting that terminal bypass.
  probe.state = 'delivered_pending_post_live';
  for (const obligation of probe.obligations) { obligation.status = 'satisfied'; obligation.evidence = []; }
  target.status = 'open-unexecuted'; target.evidence = []; const guard = evaluateLifecycleGuard(probe, 'completion-claim'); const closure = evaluateClosure(probe);
  const result = { guard, closureState: closure.state, closureIssues: closure.issues };
  return { passed: !guard.allowed && closure.state === 'close_blocked' && closure.issues.some(issue => issue.includes(target.id)), inputHash: hash(canonical({ ids: probe.compiledObligationIds, target: target.id })), outputHash: hash(canonical(result)), reasons: [...guard.reasons, ...closure.issues] };
}
