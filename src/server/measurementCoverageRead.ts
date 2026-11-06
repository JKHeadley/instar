/** Read existing inventories for the maturation board; no file walk or state writes. */
import { getMigrationDefaults } from '../config/ConfigDefaults.js';
import { DEV_GATED_FEATURES } from '../core/devGatedFeatures.js';
import type { Initiative, MaturationEvaluationContract } from '../core/InitiativeTracker.js';
import { PROVENANCE_COVERAGE } from '../data/provenanceCoverage.js';
import { GUARD_MANIFEST } from '../monitoring/guardManifest.js';
import { contractForRung } from '../monitoring/MaturationLadder.js';
import type { MaturationLadderService } from '../monitoring/MaturationLadderService.js';
import { parseMaturationOutcome } from '../monitoring/MaturationOutcome.js';
import { measurementCoverage, type CoverageDeclaration, type CoverageMember, type CoverageParent, type CoverageProof, type CoverageSource } from '../monitoring/MeasurementCoverage.js';
import type { RouteContext } from './routes.js';

export type MeasurementCoverageContext = Pick<RouteContext, 'config' | 'meshSelfId' | 'scheduler' | 'initiativeTracker' | 'blockerLifecycleService' | 'featureRegistry' | 'capabilityRegistry'>
  & { maturationLadder?: () => MaturationLadderService | null };
const normalize = (path: string) => path.replace(/\.(enabled|dryRun)$/, '');
const bounded = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);

export function readMeasurementCoverage(ctx: MeasurementCoverageContext, now = Date.now()) {
  const members: CoverageMember[] = [];
  const sources: CoverageSource[] = [];
  const subjects = new Map<string, { contract?: MaturationEvaluationContract; error?: string }>();
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
      subjects.set(i.id, { contract: i.rolloutAccounting?.maturationEvaluation ?? i.rollout?.maturationEvaluation,
        error: i.rolloutAccounting?.maturationContractError ?? i.rollout?.maturationContractError });
      if (i.rollout?.flagPath) {
        link(i.rollout.flagPath, i.id);
        if (i.rolloutAccounting?.ownerFeatureId) addParent(i.rollout.flagPath, { kind: 'effort', id: i.rolloutAccounting.ownerFeatureId, source: 'accounting-owner' });
      }
      members.push({ kind: 'effort', id: i.id, title: bounded(i.title), sources: ['initiative-tracker'], subjects: [i.id],
        ...(i.parentProjectId ? { parentId: i.parentProjectId, parents: [{ kind: 'effort' as const, id: i.parentProjectId, source: 'initiative-parent' as const }] } : {}), posture: i.status });
    }
  });
  read('ladder-owner', () => {
    const ladder = ctx.maturationLadder?.();
    if (!ladder || ladder.error) throw Error('unavailable');
    const views = new Map(ladder.features().map(f => [f.id, f]));
    const entries = new Map(ladder.entries.map(e => [e.id, e]));
    for (const entry of ladder.entries) {
      const key = entry.flag?.path ?? entry.id;
      feature(key, entry.title, 'ladder-owner');
      link(key, entry.subject);
      if (entry.composedInto) {
        const parent = entries.get(entry.composedInto);
        addParent(key, { kind: 'feature', id: normalize(parent?.flag?.path ?? entry.composedInto), source: 'ladder-composition' });
      }
      const view = views.get(entry.id);
      const rung = view?.next ? entry.rungs[view.next] : entry.rungs.fleet;
      if (rung && entry.disposition === 'ladder' && (view?.next || !subjects.has(entry.subject))) subjects.set(entry.subject, { contract: contractForRung(rung) });
    }
  });
  read('local-model-capability-projection', () => {
    if (!ctx.capabilityRegistry || !ctx.meshSelfId) throw Error('unavailable');
    const rows = ctx.capabilityRegistry.snapshot(now).filter(r => r.machineId === ctx.meshSelfId);
    if (!rows.length || rows.some(r => r.kind === 'failure')) throw Error('unavailable');
    for (const row of rows) if (row.kind === 'capability') members.push({ kind: 'capability', id: `${row.entry.capabilityId}:${row.entry.doorwayId}`,
      title: bounded(row.entry.capabilityId), sources: ['local-model-capability-projection'], subjects: [], posture: row.status });
  });
  if (!ctx.meshSelfId) sources.push({ name: 'origin-identity', ok: false, reason: 'unavailable' });
  const d7 = ctx.blockerLifecycleService;
  let evidenceAvailable = false;
  read('measurement-evidence-owner', () => { if (!d7?.available()) throw Error('unavailable'); evidenceAvailable = true; });
  for (const member of members) if (member.kind === 'feature') {
    member.subjects = [...(featureLinks.get(member.id) ?? [])];
    const parents = featureParents.get(member.id);
    if (parents) member.parents = [...new Map(parents.map(p => [`${p.kind}:${p.id}:${p.source}`, p])).values()];
  }
  let corroborationReads = 0;
  return measurementCoverage(ctx.meshSelfId ?? 'unknown-origin', now, members, sources, id => {
    const owner = subjects.get(id);
    let declaration: CoverageDeclaration = 'unknown';
    if (owner?.error) declaration = 'invalid';
    else if (owner) declaration = owner.contract?.outcome === undefined ? 'missing'
      : Array.isArray(owner.contract.metrics) && parseMaturationOutcome(owner.contract.outcome, owner.contract.metrics.map(m => m.id)) ? 'declared' : 'invalid';
    const withinBudget = corroborationReads < 64;
    if (declaration === 'declared' && evidenceAvailable && withinBudget) corroborationReads++;
    if (declaration === 'declared' && evidenceAvailable && !withinBudget && !sources.some(s => s.name === 'evidence-read-budget')) sources.push({ name: 'evidence-read-budget', ok: false, reason: 'bounded-read-omitted-proof' });
    const current = declaration === 'declared' && evidenceAvailable && withinBudget ? d7!.maturationOutcomeForContract(id, owner!.contract!) : null;
    return { declaration, enrollmentKnown: evidenceAvailable && withinBudget, subjectKnown: current?.subjectKnown ?? false,
      evidence: current?.evidence ?? { state: 'unavailable', metrics: [] } } as CoverageProof;
  });
}
