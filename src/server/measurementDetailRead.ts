/** Existing board's selected-origin measurement detail, no new state owner. */
import { validMaturationPolicy } from '../monitoring/MaturationOutcome.js';
import { validMeasurementTrend, type MeasurementTrend } from '../monitoring/MeasurementTrend.js';
import { measurementOrigin, readMeasurementOwner, type MeasurementCoverageContext } from './measurementCoverageRead.js';
import type { CoverageSource } from '../monitoring/MeasurementCoverage.js';
export interface MeasurementRead {
  schema: 'measurement-read/1'; advisory: true; authority: 'none'; origin: string; subjectId: string;
  generatedAt: string; windowDays: number;
  state: 'available' | 'missing-contract' | 'invalid-contract' | 'unknown-subject' | 'unregistered-target' | 'ambiguous-target' | 'unavailable';
  detail: MeasurementTrend | null; sources: CoverageSource[];
}
export function readMeasurementDetail(ctx: MeasurementCoverageContext, subjectId: string, windowDays: number, now = Date.now(),
  census?: ReturnType<typeof readMeasurementOwner>): MeasurementRead {
  const { owner, sources } = census ?? readMeasurementOwner(ctx,subjectId,now);
  const relevant = sources.filter(s => ['initiative-tracker','ladder-owner','measurement-evidence-owner','origin-identity'].includes(s.name));
  const result: MeasurementRead = { schema: 'measurement-read/1', advisory: true, authority: 'none', origin: measurementOrigin(ctx),
    subjectId, windowDays, generatedAt: new Date(now).toISOString(), state: 'unavailable', detail: null, sources: relevant };
  if (owner?.targetState) result.sources.push({name:'measurement-target',ok:owner.targetState==='registered',...(owner.targetState!=='registered'?{reason:owner.targetState}:{})});
  if (!owner) { result.state = relevant.some(s => !s.ok) ? 'unavailable' : 'unknown-subject'; return result; }
  if (owner.error) { result.state = 'invalid-contract'; return result; }
  if (owner.targetState && owner.targetState!=='registered') {result.state=owner.targetState==='unregistered'?'unregistered-target':owner.targetState==='ambiguous'?'ambiguous-target':'unavailable';return result;}
  if (!owner.contract) { result.state = 'missing-contract'; return result; }
  if (!validMaturationPolicy(owner.contract)) { result.state = 'invalid-contract'; return result; }
  try {
    if (!ctx.blockerLifecycleService?.available()) return result;
    result.detail = ctx.blockerLifecycleService.maturationTrendForContract(subjectId,owner.contract,windowDays,owner.targetState);
    if (result.detail) result.state = 'available';
  } catch { /* @silent-fallback-ok — unavailable read, never a fabricated empty chart */ }
  return result;
}
export function validMeasurementRead(raw: unknown, origin: string, subjectId: string, windowDays: number, now: number): raw is MeasurementRead {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as Record<string,unknown>;
  const fields = ['schema','advisory','authority','origin','subjectId','generatedAt','windowDays','state','detail','sources'];
  if (Object.keys(r).some(k => !fields.includes(k)) || Buffer.byteLength(JSON.stringify(r)) > 128*1024 ||
      r.schema !== 'measurement-read/1' || r.advisory !== true || r.authority !== 'none' || r.origin !== origin || r.subjectId !== subjectId || r.windowDays !== windowDays ||
      typeof r.generatedAt !== 'string' || !Number.isFinite(Date.parse(r.generatedAt)) || Date.parse(r.generatedAt)>now+5000 || now-Date.parse(r.generatedAt)>120000 ||
      !['available','missing-contract','invalid-contract','unknown-subject','unregistered-target','ambiguous-target','unavailable'].includes(String(r.state)) ||
      !Array.isArray(r.sources) || r.sources.length>16 || !r.sources.every(s => s && typeof s==='object' && Object.keys(s).every(k=>['name','ok','reason'].includes(k)) &&
        typeof s.name==='string' && s.name.length>0 && s.name.length<=80 && typeof s.ok==='boolean' &&
        (s.reason===undefined || (typeof s.reason==='string' && s.reason.length<=120)))) return false;
  return r.state === 'available'
    ? validMeasurementTrend(r.detail,origin,subjectId,now) && r.detail.windowDays === windowDays
    : r.detail === null;
}
