import { readLocalCapabilityInventory } from '../core/CapabilityRegistry.js';
/** Read existing inventories for the maturation board; no file walk or state writes. */
import { validGenericMeasurement } from '../monitoring/MeasurementContractVersion.js';
import { hasMeasurementBinding, validMeasurementSubject, type MeasurementSubject, type MeasurementTargetState } from '../monitoring/MeasurementSubject.js';
import { getMigrationDefaults } from '../config/ConfigDefaults.js';
import { DEV_GATED_FEATURES } from '../core/devGatedFeatures.js';
import type { Initiative, MaturationEvaluationContract } from '../core/InitiativeTracker.js';
import { PROVENANCE_COVERAGE } from '../data/provenanceCoverage.js';
import { GUARD_MANIFEST } from '../monitoring/guardManifest.js';
import type { MaturationLadderService } from '../monitoring/MaturationLadderService.js';
import { parseMaturationOutcome } from '../monitoring/MaturationOutcome.js';
import { measurementCoverage, type CoverageDeclaration, type CoverageMember, type CoverageParent, type CoverageProof, type CoverageSource } from '../monitoring/MeasurementCoverage.js';
import type { RouteContext } from './routes.js';

export type MeasurementCoverageContext = Pick<RouteContext, 'config' | 'meshSelfId' | 'scheduler' | 'initiativeTracker' | 'blockerLifecycleService' | 'featureRegistry'>
  & { maturationLadder?: () => MaturationLadderService | null };
export const measurementOrigin = (ctx: MeasurementCoverageContext): string => ctx.meshSelfId ?? ctx.blockerLifecycleService?.measurementOrigin() ?? 'unknown-origin';
const normalize = (path: string) => path.replace(/\.(enabled|dryRun)$/, '');
const bounded = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);

function collectMeasurementInputs(ctx: MeasurementCoverageContext, now = Date.now()) {
  const members: CoverageMember[] = [];
  const sources: CoverageSource[] = [];
  const subjects = new Map<string, { contract?: MaturationEvaluationContract; error?: string; targetState?: MeasurementTargetState }>();
  const bindings: Array<{id:string;target:MeasurementSubject}> = [];
  const ownerCollisions = new Set<string>();
  const genericOwners = new Set<string>();
  const featureParents = new Map<string, CoverageParent[]>();
  const addParent = (flag: string, parent: CoverageParent) => { const key = normalize(flag); featureParents.set(key, [...(featureParents.get(key) ?? []), parent]); };
  const featureLinks = new Map<string, Set<string>>();
  const link = (flag: string, subject: string) => {
    const key = normalize(flag); const ids = featureLinks.get(key) ?? new Set(); ids.add(subject); featureLinks.set(key, ids);
  };
  const feature = (id: string, title: string, source: string) => members.push({ kind: 'feature', id: normalize(id), title: bounded(title), sources: [source], subjects: [] });
  const read = (name: string, fn: () => void) => {
    try { fn(); sources.push({ name, ok: true }); } catch { sources.push({ name, ok: false, reason: 'unavailable' }); }
  };
  const walk = (o: unknown, prefix: string, source = 'shipped-config-defaults'): void => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return;
      for (const [key, value] of Object.entries(o)) {
        const p = prefix ? `${prefix}.${key}` : key;
        if ((key === 'enabled' || key === 'dryRun') && typeof value === 'boolean') feature(p, normalize(p), source);
        else walk(value, p, source);
      }
    };
  read('shipped-config-defaults', () => { walk(getMigrationDefaults('standalone'), ''); walk(getMigrationDefaults('managed-project'), ''); });
  read('live-config-flags', () => walk(ctx.config, '', 'live-config-flags')); 
  read('guard-manifest', () => { for (const guard of GUARD_MANIFEST) feature(guard.configPath ?? guard.key, guard.description, 'guard-manifest'); });
  read('developer-gates', () => { for (const f of DEV_GATED_FEATURES) feature(f.configPath, normalize(f.configPath), 'developer-gates'); });
  read('discovery-definitions', () => {
    if (!ctx.featureRegistry) throw Error('unavailable');
    for (const f of ctx.featureRegistry.getAllDefinitions()) feature(f.configPath, f.name, 'discovery-definitions');
  });
  read('decision-census', () => {
    for (const entry of PROVENANCE_COVERAGE) members.push({ kind: 'decision', id: entry.decisionPoint, title: bounded(entry.component),
      sources: ['decision-census'], subjects: [], posture: entry.status });
  });
  read('loaded-scheduler-jobs', () => {
    if (!ctx.scheduler) throw Error('unavailable');
    for (const job of ctx.scheduler.getJobs()) members.push({ kind: 'job', id: job.slug, title: bounded(job.name),
      sources: ['loaded-scheduler-jobs'], subjects: [], posture: job.enabled ? 'enabled' : 'disabled' });
  });
  read('initiative-tracker', () => {
    if (!ctx.initiativeTracker) throw Error('unavailable');
    for (const i of ctx.initiativeTracker.list() as Initiative[]) {
      const generic = i.measurement !== undefined;
      if (generic) genericOwners.add(i.id);
      const featureContract=i.rolloutAccounting?.maturationEvaluation??i.rollout?.maturationEvaluation;
      subjects.set(i.id, generic ? { contract: !i.rollout && !i.rolloutAccounting && validGenericMeasurement(i.measurement,i.id) ? i.measurement : undefined,
        ...(!validGenericMeasurement(i.measurement,i.id) || i.rollout || i.rolloutAccounting ? {error:'invalid-measurement-contract'} : {}) }
        : { contract:featureContract,
          error:hasMeasurementBinding(featureContract)?'invalid-owner-binding':i.rolloutAccounting?.maturationContractError??i.rollout?.maturationContractError });
      if (generic && validMeasurementSubject(i.measurement?.subject)) bindings.push({id:i.id,target:{kind:i.measurement!.subject.kind,key:i.measurement!.subject.key}});
      if (i.rollout?.flagPath) {
        link(i.rollout.flagPath, i.id);
        if (i.rolloutAccounting?.ownerFeatureId) addParent(i.rollout.flagPath, { kind: 'effort', id: i.rolloutAccounting.ownerFeatureId, source: 'accounting-owner' });
      }
      members.push({ kind: 'effort', id: i.id, title: bounded(i.title), sources: ['initiative-tracker'], subjects: [],
        ...(i.parentProjectId ? { parentId: i.parentProjectId, parents: [{ kind: 'effort' as const, id: i.parentProjectId, source: 'initiative-parent' as const }] } : {}), posture: i.status });
    }
  });
  read('ladder-owner', () => {
    const ladder = ctx.maturationLadder?.();
    if (!ladder || ladder.error) throw Error('unavailable');
    const contracts = ladder.measurementContracts();
    if (!contracts) throw Error('unavailable');
    const entries = new Map(ladder.entries.map(e => [e.id, e]));
    for (const entry of ladder.entries) {
      const key = entry.flag?.path ?? entry.id;
      feature(key, entry.title, 'ladder-owner');
      link(key, entry.subject);
      if (entry.composedInto) {
        const parent = entries.get(entry.composedInto);
        addParent(key, { kind: 'feature', id: normalize(parent?.flag?.path ?? entry.composedInto), source: 'ladder-composition' });
      }
      const retained = contracts.get(entry.subject);
      if (genericOwners.has(entry.subject)) { ownerCollisions.add(entry.subject); subjects.set(entry.subject,{...subjects.get(entry.subject),error:'measurement-owner-collision'}); }
      else if (retained && (retained.overridesInitiative || !subjects.has(entry.subject))) subjects.set(entry.subject, { contract: retained.contract });
    }
  });
  read('local-model-capability-projection', () => {
    if (!ctx.meshSelfId && ctx.config.multiMachine?.enabled) throw Error('unavailable');
    const projection = readLocalCapabilityInventory(ctx.config.projectDir, ctx.config.stateDir, ctx.meshSelfId ?? 'local', now);
    for (const entry of projection.entries) members.push({ kind: 'capability', id: `${entry.capabilityId}:${entry.doorwayId}`,
      title: bounded(entry.capabilityId), sources: ['local-model-capability-projection'], subjects: [], posture: 'registered-definition' });
    // Keep the known prefix, but never certify an incomplete source as a zero.
    if (projection.truncated || projection.scanState !== 'observed') throw Error('unavailable');
  });
  const targetGroups = new Map<string,string[]>();
  for (const b of bindings) {const key=JSON.stringify([b.target.kind,b.target.key]);targetGroups.set(key,[...(targetGroups.get(key)??[]),b.id]);}
  const sourceFor = {effort:'initiative-tracker',job:'loaded-scheduler-jobs',decision:'decision-census',capability:'local-model-capability-projection'};
  const targetStates = new Map<string,MeasurementTargetState>();
  for (const b of bindings) {
    const ids=targetGroups.get(JSON.stringify([b.target.kind,b.target.key]))!;
    const retained=subjects.get(b.id)?.contract;
    const adapterPoint=validGenericMeasurement(retained)?retained.adapter?.decisionPoint:undefined;
    const state:MeasurementTargetState=ownerCollisions.has(b.id)||ids.length>1?'ambiguous'
      : !sources.some(s=>s.name===sourceFor[b.target.kind]&&s.ok) || (adapterPoint && !sources.some(s=>s.name==='decision-census'&&s.ok))?'unavailable'
      : adapterPoint && !members.some(m=>m.kind==='decision'&&m.id===adapterPoint)?'unregistered'
      : members.some(m=>m.kind===b.target.kind&&m.id===b.target.key)?'registered':'unregistered';
    targetStates.set(b.id,state); const owner=subjects.get(b.id);if(owner)owner.targetState=state;
  }
  for (const member of members) if (member.kind!=='feature') member.subjects=[...(targetGroups.get(JSON.stringify([member.kind,member.id]))??[])];
  if (!ctx.meshSelfId) sources.push({ name: 'origin-identity', ok: false, reason: 'unavailable' });
  const d7 = ctx.blockerLifecycleService;
  let evidenceAvailable = false;
  read('measurement-evidence-owner', () => { if (!d7?.available()) throw Error('unavailable'); evidenceAvailable = true; });
  for (const member of members) if (member.kind === 'feature') {
    member.subjects = [...(featureLinks.get(member.id) ?? [])];
    const parents = featureParents.get(member.id);
    if (parents) member.parents = [...new Map(parents.map(p => [`${p.kind}:${p.id}:${p.source}`, p])).values()];
  }
  return { members, sources, subjects, d7, evidenceAvailable, targetStates };
}

/** Same independent census used by the scorer, no second target registry. */
export function readMeasurementTargets(ctx:MeasurementCoverageContext,now=Date.now()):Map<string,MeasurementTargetState> {
  return collectMeasurementInputs(ctx,now).targetStates;
}

/** Exact current retained owner, using the same precedence as coverage. */
export function readMeasurementOwner(ctx: MeasurementCoverageContext, id: string, now = Date.now()) {
  const state = collectMeasurementInputs(ctx, now);
  return { owner: state.subjects.get(id) ?? null, sources: state.sources };
}

export function readMeasurementCoverage(ctx: MeasurementCoverageContext, now = Date.now()) {
  const { members, sources, subjects, d7, evidenceAvailable } = collectMeasurementInputs(ctx, now);
  let corroborationReads = 0;
  return measurementCoverage(measurementOrigin(ctx), now, members, sources, id => {
    const owner = subjects.get(id);
    let declaration: CoverageDeclaration = 'unknown';
    if (owner?.error) declaration = 'invalid';
    else if (owner) declaration = owner.contract?.outcome === undefined ? 'missing'
      : Array.isArray(owner.contract.metrics) && parseMaturationOutcome(owner.contract.outcome, owner.contract.metrics.map(m => m.id)) ? 'declared' : 'invalid';
    const withinBudget = corroborationReads < 64;
    if (declaration === 'declared' && evidenceAvailable && withinBudget) corroborationReads++;
    if (declaration === 'declared' && evidenceAvailable && !withinBudget && !sources.some(s => s.name === 'evidence-read-budget')) sources.push({ name: 'evidence-read-budget', ok: false, reason: 'bounded-read-omitted-proof' });
    const targetUsable = !owner?.targetState || owner.targetState==='registered';
    const omittedEvaluation=d7?.measurementAdmission?.(id)==='budget-omitted';
    if(omittedEvaluation&&!sources.some(s=>s.name==='evaluation-budget'))sources.push({name:'evaluation-budget',ok:false,reason:'active-subject-omitted-from-latest-pass'});
    const current = declaration === 'declared' && evidenceAvailable && withinBudget && targetUsable ? d7!.maturationOutcomeForContract(id, owner!.contract!) : null;
    return { declaration, enrollmentKnown: evidenceAvailable && withinBudget && targetUsable && !omittedEvaluation, subjectKnown: current?.subjectKnown ?? false,
      evidence: current?.evidence ?? { state: 'unavailable', metrics: [] } } as CoverageProof;
  });
}
