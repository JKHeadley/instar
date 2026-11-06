/** Independent read projection over existing inventories, never a registry.
 * Observability: a measurement declaration cannot define its own denominator.
 */
export const COVERAGE_KINDS = ['feature', 'decision', 'job', 'effort', 'capability'] as const;
export type CoverageKind = typeof COVERAGE_KINDS[number];
export const COVERAGE_STATES = ['corroborated', 'missing-contract', 'invalid-contract', 'not-linked', 'stale', 'unavailable', 'insufficient-samples', 'incompatible', 'ambiguous', 'inactive'] as const;
export type CoverageState = typeof COVERAGE_STATES[number];
export interface CoverageParent { kind: CoverageKind; id: string; source: 'initiative-parent' | 'accounting-owner' | 'ladder-composition' }
export interface CoverageMember {
  kind: CoverageKind;
  id: string;
  title: string;
  sources: string[];
  /** Exact links supplied by an existing owner, never a name-based guess. */
  subjects: string[];
  parentId?: string;
  parents?: CoverageParent[];
  posture?: string;
}
export interface CoverageSource { name: string; ok: boolean; reason?: string }
export type CoverageDeclaration = 'declared' | 'missing' | 'invalid' | 'unknown';
export interface CoverageProof {
  /** Read from retained owner metadata, independently of active D7 enrollment. */
  declaration: CoverageDeclaration;
  enrollmentKnown: boolean;
  subjectKnown: boolean;
  evidence: { state: string; metrics: Array<{ baseline: { state: string }; current: { state: string } }> };
}
export interface CoverageRow extends CoverageMember { state: CoverageState; declaration: CoverageDeclaration | 'not-linked' | 'ambiguous' }
export interface MeasurementCoverage {
  schema: 'measurement-coverage/1';
  advisory: true;
  authority: 'none';
  origin: string;
  generatedAt: string;
  /** Source completeness, never a claim of semantic or universal coverage. */
  sourcesComplete: boolean;
  denominator: 'existing-registry-entries-by-kind';
  sources: CoverageSource[];
  counts: Record<CoverageKind, { total: number; states: Record<CoverageState, number> }>;
  rows: CoverageRow[];
  omittedRows: number;
}

function proofState(subjects: string[], read: (id: string) => CoverageProof | null): CoverageState {
  if (!subjects.length) return 'not-linked';
  if (subjects.length !== 1) return 'ambiguous';
  let p: CoverageProof | null;
  try { p = read(subjects[0]); } catch { return 'unavailable'; }
  if (p?.declaration === 'invalid') return 'invalid-contract';
  if (p?.declaration === 'missing') return 'missing-contract';
  if (!p?.enrollmentKnown) return 'unavailable';
  if (!p.subjectKnown) return p.declaration === 'declared' ? 'inactive' : 'unavailable';
  if (p.evidence.state === 'missing-contract') return 'missing-contract';
  if (p.evidence.state === 'invalid-contract') return 'invalid-contract';
  const states = p.evidence.metrics.flatMap(m => [m.baseline.state, m.current.state]);
  if (!states.length) return 'unavailable';
  if (p.evidence.state === 'verified' && states.every(s => s === 'verified')) return 'corroborated';
  if (states.includes('stale')) return 'stale';
  if (states.includes('unavailable')) return 'unavailable';
  if (states.includes('insufficient-samples')) return 'insufficient-samples';
  return 'incompatible';
}

/** Counts the complete enumerated input before trimming display rows. */
export function measurementCoverage(origin: string, now: number, members: CoverageMember[], sources: CoverageSource[],
  read: (id: string) => CoverageProof | null, limits = { maxRows: 2048, maxBytes: 128 * 1024 }): MeasurementCoverage {
  const unique = new Map<string, CoverageMember>();
  for (const m of members) {
    const key = `${m.kind}:${m.id}`;
    const old = unique.get(key);
    unique.set(key, old ? { ...old, sources: [...new Set([...old.sources, ...m.sources])].sort(),
      subjects: [...new Set([...old.subjects, ...m.subjects])].sort(),
      ...((old.parents || m.parents) ? { parents: [...new Map([...(old.parents ?? []), ...(m.parents ?? [])].map(p => [`${p.kind}:${p.id}:${p.source}`, p])).values()] } : {}) } : { ...m, sources: [...new Set(m.sources)].sort(), subjects: [...new Set(m.subjects)].sort() });
  }
  const counts = Object.fromEntries(COVERAGE_KINDS.map(k => [k, { total: 0,
    states: Object.fromEntries(COVERAGE_STATES.map(s => [s, 0])) }])) as MeasurementCoverage['counts'];
  const all = [...unique.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const proofCache = new Map<string, CoverageProof | null>();
  const cachedRead = (id: string) => { if (!proofCache.has(id)) { try { proofCache.set(id, read(id)); } catch { proofCache.set(id, null); } } return proofCache.get(id) ?? null; };
  const result: MeasurementCoverage = { schema: 'measurement-coverage/1', advisory: true, authority: 'none', origin,
    generatedAt: new Date(now).toISOString(), sourcesComplete: sources.length > 0 && sources.every(s => s.ok),
    denominator: 'existing-registry-entries-by-kind', sources, counts, rows: [], omittedRows: all.length };
  let bytes = Buffer.byteLength(JSON.stringify(result));
  // Round-robin kinds so a large feature registry cannot hide every job/effort.
  const queues = COVERAGE_KINDS.map(kind => all.filter(m => m.kind === kind));
  for (let index = 0; queues.some(q => index < q.length); index++) {
    for (const queue of queues) {
      const member = queue[index];
      if (!member) continue;
      let declaration: CoverageRow['declaration'] = member.subjects.length === 0 ? 'not-linked' : member.subjects.length > 1 ? 'ambiguous' : 'unknown';
      if (member.subjects.length === 1) { try { declaration = cachedRead(member.subjects[0])?.declaration ?? 'unknown'; } catch { /* @silent-fallback-ok — unknown retained declaration is explicit */ } }
      const row: CoverageRow = { ...member, declaration, state: proofState(member.subjects, cachedRead) };
      counts[row.kind].total++;
      counts[row.kind].states[row.state]++;
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (result.rows.length < limits.maxRows && bytes + size < limits.maxBytes - 2048) {
        result.rows.push(row); result.omittedRows--; bytes += size;
      }
    }
  }
  result.sourcesComplete = sources.length > 0 && sources.every(s => s.ok);
  return result;
}

/** Bounded schema check for origin-local pool reads; never certifies semantics. */
export function validMeasurementCoverage(raw: unknown, origin: string, now: number): raw is MeasurementCoverage {
  const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
  const text = (v: unknown, n: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= n && !/[\u0000-\u001f\u007f]/.test(v);
  const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
  if (!object(raw) || Buffer.byteLength(JSON.stringify(raw)) > 128 * 1024 || raw.schema !== 'measurement-coverage/1' || raw.origin !== origin ||
      raw.advisory !== true || raw.authority !== 'none' || raw.denominator !== 'existing-registry-entries-by-kind' ||
      typeof raw.sourcesComplete !== 'boolean' || !text(raw.generatedAt, 40) || !Number.isFinite(Date.parse(raw.generatedAt)) ||
      Date.parse(raw.generatedAt) > now + 5000 || now - Date.parse(raw.generatedAt) > 120_000 ||
      !Array.isArray(raw.sources) || raw.sources.length > 16 || !object(raw.counts) || !count(raw.omittedRows) ||
      !Array.isArray(raw.rows) || raw.rows.length > 2048) return false;
  if (!raw.sources.every(s => object(s) && text(s.name, 80) && typeof s.ok === 'boolean' && (s.reason === undefined || text(s.reason, 120))) ||
      raw.sourcesComplete !== (raw.sources.length > 0 && raw.sources.every(s => (s as CoverageSource).ok))) return false;
  let total = 0;
  for (const kind of COVERAGE_KINDS) {
    const group = raw.counts[kind];
    if (!object(group) || !count(group.total) || !object(group.states) ||
        !COVERAGE_STATES.every(s => count((group.states as Record<string, unknown>)[s])) ||
        COVERAGE_STATES.reduce((n, s) => n + (group.states as Record<string, number>)[s], 0) !== group.total) return false;
    total += group.total;
  }
  if (total !== raw.rows.length + raw.omittedRows) return false;
  const seen = new Set<string>();
  const shown = new Map<string, number>();
  for (const row of raw.rows) {
    if (!object(row) || !COVERAGE_KINDS.includes(row.kind as CoverageKind) || !COVERAGE_STATES.includes(row.state as CoverageState) ||
        !text(row.id, 512) || !text(row.title, 160) || !['declared', 'missing', 'invalid', 'unknown', 'not-linked', 'ambiguous'].includes(String(row.declaration)) ||
        !Array.isArray(row.sources) || !row.sources.length || row.sources.length > 16 || !row.sources.every(s => text(s, 80)) ||
        !Array.isArray(row.subjects) || row.subjects.length > 512 || !row.subjects.every(s => text(s, 128)) ||
        (row.parentId !== undefined && !text(row.parentId, 128)) || (row.posture !== undefined && !text(row.posture, 160))) return false;
    if (row.parents !== undefined && (!Array.isArray(row.parents) || row.parents.length > 512 || !row.parents.every(p => object(p) && COVERAGE_KINDS.includes(p.kind as CoverageKind) && text(p.id, 512) && ['initiative-parent', 'accounting-owner', 'ladder-composition'].includes(String(p.source))))) return false;
    if (new Set(row.subjects).size !== row.subjects.length) return false;
    if (row.subjects.length === 0 && (row.state !== 'not-linked' || row.declaration !== 'not-linked')) return false;
    if (row.subjects.length > 1 && (row.state !== 'ambiguous' || row.declaration !== 'ambiguous')) return false;
    if (row.subjects.length === 1 && (row.state === 'not-linked' || row.state === 'ambiguous' || row.declaration === 'not-linked' || row.declaration === 'ambiguous')) return false;
    if (row.declaration === 'missing' && row.state !== 'missing-contract') return false;
    if (row.declaration === 'invalid' && row.state !== 'invalid-contract') return false;
    if ((row.state === 'corroborated' || row.state === 'inactive') && (row.subjects.length !== 1 || row.declaration !== 'declared')) return false;
    const key = `${row.kind}:${row.id}`;
    if (seen.has(key)) return false; seen.add(key);
    const stateKey = `${row.kind}:${row.state}`;
    shown.set(stateKey, (shown.get(stateKey) ?? 0) + 1);
    const expected = (raw.counts[row.kind as CoverageKind] as MeasurementCoverage['counts'][CoverageKind]).states[row.state as CoverageState];
    if (shown.get(stateKey)! > expected) return false;
  }
  return true;
}
