/** Machine-local observations and findings. None of this evidence decides a verify's verdict. */
import fs from 'node:fs';
import path from 'node:path';
import type { FirstPartGroup, FirstPartSetting } from './firstPart.js';
import type { LaneName } from './inventory.js';
import type { LocalVerifyRecord } from './record.js';

export const DAY = 24 * 60 * 60_000;
export interface FirstPartEvidence { setting: FirstPartSetting; group: FirstPartGroup; ran: boolean }
export function validFirstPartEvidence(v: unknown): v is FirstPartEvidence {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const x = v as Record<string, unknown>;
  return typeof x.setting === 'string' && ['off', 'on', 'alternate'].includes(x.setting)
    && typeof x.group === 'string' && ['with', 'without'].includes(x.group)
    && typeof x.ran === 'boolean' && Object.keys(x).length === 3
    && !(x.ran && (x.setting === 'off' || x.setting === 'alternate' && x.group === 'without'));
}
export interface FileFailure {
  file: string; lane: LaneName; firstPart: boolean; own: boolean;
  result: 'failed' | 'passed-on-rerun' | 'rerun-interrupted';
}
export interface ObservationDetail {
  incomplete: boolean; completedLanes: LaneName[]; firstPartFiles: Partial<Record<LaneName, string[]>>;
  failures: FileFailure[]; failuresTotal: number;
}
export interface Observation extends ObservationDetail, FirstPartEvidence {
  type: 'observation'; id: string; at: number; startedAt: number; pr: number; head: string; base: string;
  outcome: LocalVerifyRecord['outcome']; errorStep?: string; minutes: number;
}
export interface Marker { type: 'marker'; id: string; at: number; old: FirstPartSetting | null; setting: FirstPartSetting; reason: 'setting' | 'requested' | 'limit' }
export type Row = Observation | Marker;
export interface Episode {
  redHead: string; lastGreenHead: string | null; at: number; endedAt?: number; historyUnknown: boolean;
  commits: Array<{ head: string; pr: number | null; firstParts: 'yes' | 'no' | 'unknown' }>;
}
/** Snapshot local history when an episode begins; unavailable evidence is never a no. */
export function redMainEpisode(redHead: string, lastGreenHead: string | null, at: number,
  history: Array<{ head: string; message: string }> | null | undefined, records: readonly LocalVerifyRecord[]): Episode {
  return { redHead, lastGreenHead, at, historyUnknown: history == null, commits: (history ?? []).map((c) => {
    const match = c.message.split('\n')[0].match(/\(#(\d+)\)\s*$/) ?? c.message.match(/^Merge pull request #(\d+)\b/);
    const pr = match ? Number(match[1]) : null;
    const passing = records.filter((r) => r.pr === pr && r.outcome === 'success' && Date.parse(r.finishedAt) <= at)
      .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))[0];
    return { head: c.head, pr, firstParts: passing?.firstPart ? (passing.firstPart.ran ? 'yes' : 'no') : 'unknown' };
  }) };
}
export interface Finding { finding: 'confirmed' | 'explained' | 'unknown'; reason: string; at: number; prs: Record<FirstPartGroup, number[]> }
export interface Suspect { name: string; kind: 'file' | 'episode'; trial: string; at: number; group?: FirstPartGroup; findings: Finding[] }
interface Evaluation { at: number; trial: string; observations: number; limits: Record<string, boolean>; groups: ReturnType<typeof summarize>['groups']; stopped?: string; configWritten?: boolean }
interface State { v: 1; since: number; setting: FirstPartSetting | null; suspects: Suspect[]; episodes: Episode[]; lastEvaluation?: Evaluation }

export function observation(record: LocalVerifyRecord, id: string, evidence: FirstPartEvidence, detail?: ObservationDetail): Observation {
  return { type: 'observation', id, at: Date.parse(record.finishedAt), startedAt: Date.parse(record.startedAt), pr: record.pr,
    head: record.headSha, base: record.baseSha, outcome: record.outcome, ...(record.errorStep ? { errorStep: record.errorStep } : {}),
    minutes: Math.max(0, (Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 60_000), ...evidence,
    incomplete: detail?.incomplete ?? true, completedLanes: detail?.completedLanes ?? [], firstPartFiles: detail?.firstPartFiles ?? {},
    failures: (detail?.failures ?? []).slice(0, 50), failuresTotal: detail?.failuresTotal ?? 0 };
}

/** Use run start time, with log order only to break equal-millisecond ties. */
function trialObservations(rows: readonly Row[], id: string) {
  const markers = rows.filter((r): r is Marker => r.type === 'marker');
  const i = markers.findIndex((m) => m.id === id);
  const start = markers[i]; const end = markers[i + 1];
  const after = (r: Observation, marker: Marker) => r.startedAt > marker.at || (r.startedAt === marker.at && rows.indexOf(r) > rows.indexOf(marker));
  return rows.filter((r): r is Observation => r.type === 'observation' && r.setting === 'alternate'
    && (!start || after(r, start)) && (!end || !after(r, end)));
}
export function currentTrial(rows: readonly Row[]) {
  const markers = rows.filter((r): r is Marker => r.type === 'marker');
  for (let i = markers.length - 1; i >= -1; i--) {
    const start = markers[i]; const end = markers[i + 1];
    const selected = trialObservations(rows, start?.id ?? 'initial');
    if (selected.length || i === -1) return { id: start?.id ?? 'initial', from: start?.at ?? selected[0]?.startedAt ?? null,
      to: end?.at ?? null, ended: !!end, observations: selected };
  }
  throw new Error('unreachable trial');
}
const groups: FirstPartGroup[] = ['with', 'without'];
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y); const n = Math.floor(a.length / 2);
  return a.length % 2 ? a[n] : (a[n - 1] + a[n]) / 2;
};
export function summarize(rows: readonly Observation[]) {
  const count = (group: FirstPartGroup) => {
    const rs = rows.filter((r) => r.group === group);
    const passes = rs.filter((r) => r.outcome === 'success');
    const deadlines = rs.filter((r) => r.outcome === 'error' && /^deadline:(?:unit|integration|e2e|total)(?:-|$)/.test(r.errorStep ?? '')).length;
    return { verifies: rs.length, passes: passes.length, failures: rs.filter((r) => r.outcome === 'failure').length,
      errors: rs.filter((r) => r.outcome === 'error').length, passingMedian: median(passes.map((r) => r.minutes)),
      deadlineErrors: deadlines, deadlineRate: rs.length ? deadlines / rs.length : 0 };
  };
  const counts = { with: count('with'), without: count('without') };
  const names = new Map<string, LaneName>();
  for (const r of rows) for (const f of r.failures) if (f.result === 'failed') names.set(f.file, f.lane);
  const files = [...names].map(([file, lane]) => {
    const part = (group: FirstPartGroup) => {
      const rs = rows.filter((r) => r.group === group);
      const failed = rs.filter((r) => r.failures.some((f) => f.file === file && f.result === 'failed'));
      const eligible = failed.filter((r) => r.failures.some((f) => f.file === file && f.result === 'failed' && !f.own));
      return { failures: failed.length, prs: [...new Set(failed.map((r) => r.pr))], eligibleFailures: eligible.length,
        eligiblePrs: [...new Set(eligible.map((r) => r.pr))], firstPart: rs.filter((r) => r.firstPartFiles[lane]?.includes(file)).length,
        ran: rs.filter((r) => r.firstPartFiles[lane]?.includes(file) || r.completedLanes.includes(lane)).length,
        unknown: rs.filter((r) => !r.firstPartFiles[lane]?.includes(file) && !r.completedLanes.includes(lane)).length };
    };
    return { file, lane, with: part('with'), without: part('without') };
  }).filter((f) => f.with.failures + f.without.failures >= 4);
  const a = counts.with; const b = counts.without;
  return { groups: counts, files, limits: {
    passingMedian: a.passes >= 8 && b.passes >= 8 && a.passingMedian! > b.passingMedian! + 1,
    deadlineRate: a.verifies >= 20 && b.verifies >= 20 && a.deadlineErrors >= 3 && a.deadlineRate > 2 * b.deadlineRate,
  } };
}

export class FirstPartReport {
  private state: State;
  readonly log: string;
  readonly file: string;
  constructor(stateDir: string, private readonly now: () => number, private readonly audit: (e: Record<string, unknown>) => void) {
    this.log = path.join(stateDir, 'logs', 'local-verify-first-part-observations.jsonl');
    this.file = path.join(stateDir, 'state', 'local-verify', 'first-part-findings.json');
    this.state = { v: 1, since: now(), setting: null, suspects: [], episodes: [] };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as State;
      if (!saved || saved.v !== 1 || !Array.isArray(saved.suspects) || !Array.isArray(saved.episodes)
        || typeof saved.since !== 'number' || ![null, 'off', 'on', 'alternate'].includes(saved.setting)) throw new Error('invalid findings state');
      this.state = saved;
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') audit({ event: 'first-part-findings-unreadable', detail: String(e) }); }
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state), { mode: 0o600 }); /* state-registry: local-verify-first-part-report */
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  private readRows(): Row[] | null {
    let text: string;
    try { text = fs.readFileSync(this.log, 'utf8'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      this.audit({ event: 'first-part-observations-unreadable', detail: String(e) });
      return null;
    }
    const rows: Row[] = []; let damagedLines = 0;
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const row = JSON.parse(line);
        if (!row || !['marker', 'observation'].includes(row.type)) throw new Error('invalid row');
        rows.push(row);
      } catch { damagedLines++; }
    }
    if (damagedLines) this.audit({ event: 'first-part-observations-unreadable', damagedLines });
    return rows;
  }
  rows(): Row[] { return this.readRows() ?? []; }
  private append(row: Row) {
    const existing = this.readRows();
    fs.mkdirSync(path.dirname(this.log), { recursive: true });
    if (existing === null) {
      fs.appendFileSync(this.log, JSON.stringify(row) + '\n', { mode: 0o600 }); /* state-registry: local-verify-first-part-report */
      return;
    }
    const rows = existing.filter((r) => r.type === 'marker' || r.at >= this.now() - 30 * DAY);
    if (row.type === 'observation' && rows.some((r) => r.type === 'observation' && r.id === row.id)) return;
    rows.push(row);
    fs.writeFileSync(`${this.log}.tmp`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); /* state-registry: local-verify-first-part-report */
    fs.renameSync(`${this.log}.tmp`, this.log);
  }
  marker(setting: FirstPartSetting, reason: Marker['reason'] = 'requested') {
    const at = this.now();
    this.append({ type: 'marker', id: `${at}:${this.rows().filter((r) => r.type === 'marker').length}`, at, old: this.state.setting, setting, reason });
    this.state.setting = setting; this.save();
  }
  readSetting(setting: FirstPartSetting) { if (setting !== this.state.setting) this.marker(setting, 'setting'); }
  observe(row: Observation) { this.append(row); }
  daily(off: () => void, attention: (detail: Record<string, unknown>) => void) {
    if (this.state.lastEvaluation && this.now() - this.state.lastEvaluation.at <= DAY) return;
    const trial = currentTrial(this.rows()); const stats = summarize(trial.observations);
    this.evaluate();
    const prev = this.state.lastEvaluation;
    const fresh = !prev || prev.trial !== trial.id || trial.observations.length > prev.observations;
    const result: Evaluation = { at: this.now(), trial: trial.id, observations: trial.observations.length, groups: stats.groups,
      limits: Object.fromEntries(Object.entries(stats.limits).map(([k, v]) => [k, v && fresh && !trial.ended])) };
    const hit = Object.keys(result.limits).filter((k) => result.limits[k] && prev?.trial === trial.id && prev.limits[k]);
    let notice: Record<string, unknown> | null = null;
    if (hit.length && this.state.setting === 'alternate') {
      result.stopped = hit.join(', ');
      try { off(); result.configWritten = true; }
      catch (e) { result.configWritten = false; this.audit({ event: 'first-part-switch-off-write-failed', detail: String(e) }); }
      this.audit({ event: 'first-part-cost-limit', trial: trial.id, limits: hit, groups: stats.groups, configWritten: result.configWritten });
      if (result.configWritten) {
        try { this.marker('off', 'limit'); }
        catch (e) { this.audit({ event: 'first-part-marker-write-failed', detail: String(e) }); }
      }
      notice = { trial: trial.id, limits: hit, groups: stats.groups, configWritten: result.configWritten,
        note: `First-part cost limit ${hit.join(', ')} met twice with new observations: ${JSON.stringify(stats.groups)}. ${result.configWritten ? 'Setting switched off.' : 'Config could not be written; trial continues and the limit will be judged again next day.'}` };
    }
    this.state.lastEvaluation = result; this.save();
    if (notice) {
      try { attention(notice); }
      catch (e) { this.audit({ event: 'first-part-attention-failed', detail: String(e) }); }
    }
  }
  evaluate() {
    const trial = currentTrial(this.rows()); const stats = summarize(trial.observations);
    for (const file of stats.files) for (const group of groups) {
      const other = group === 'with' ? 'without' : 'with';
      if (file[group].eligibleFailures < 4 || file[group].eligiblePrs.length < 3 || file[other].eligibleFailures * 3 > file[group].eligibleFailures) continue;
      const old = this.state.suspects.find((s) => s.trial === trial.id && s.name === file.file);
      const finding = old?.findings.at(-1);
      if (!old) this.state.suspects.push({ name: file.file, kind: 'file', trial: trial.id, group, at: this.now(), findings: [] });
      else if (finding && finding.finding !== 'unknown' && old.at <= finding.at && file[group].eligiblePrs.filter((p) => !finding.prs[group].includes(p)).length >= 4) {
        old.at = this.now(); old.group = group;
      }
    }
    this.save();
  }
  episode(episode: Episode) {
    if (this.state.episodes.some((e) => e.redHead === episode.redHead && !e.endedAt)) return;
    this.state.episodes.push(episode);
    if (episode.commits.some((c) => c.firstParts === 'yes')) this.state.suspects.push({ name: episode.redHead, kind: 'episode',
      trial: currentTrial(this.rows()).id, at: episode.at, findings: [] });
    this.save();
  }
  hasOpenEpisode() { return this.state.episodes.some((e) => e.endedAt === undefined); }
  completeEpisode(episode: Episode) {
    const saved = this.state.episodes.find((e) => e.redHead === episode.redHead && e.at === episode.at);
    if (!saved) return;
    saved.commits = episode.commits; saved.historyUnknown = episode.historyUnknown;
    if (episode.commits.some((c) => c.firstParts === 'yes') && !this.state.suspects.some((s) => s.kind === 'episode' && s.name === episode.redHead)) {
      this.state.suspects.push({ name: episode.redHead, kind: 'episode', trial: currentTrial(this.rows()).id, at: episode.at, findings: [] });
    }
    this.save();
  }
  green() {
    let changed = false;
    for (const e of this.state.episodes) if (e.endedAt === undefined) { e.endedAt = this.now(); changed = true; }
    if (changed) this.save();
  }
  finding(body: unknown): boolean {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const b = body as Record<string, unknown>;
    if (Object.keys(b).some((k) => !['suspect', 'trial', 'finding', 'reason'].includes(k)) || typeof b.suspect !== 'string'
      || !['confirmed', 'explained', 'unknown'].includes(String(b.finding)) || typeof b.reason !== 'string' || b.reason.length > 300
      || (b.trial !== undefined && typeof b.trial !== 'string')) return false;
    const trial = b.trial ?? currentTrial(this.rows()).id;
    const s = this.state.suspects.find((s) => s.name === b.suspect && s.trial === trial);
    if (!s) return false;
    const rows = this.rows();
    const trialRows = trialObservations(rows, String(trial));
    const file = summarize(trialRows).files.find((f) => f.file === s.name);
    s.findings.push({ finding: b.finding as Finding['finding'], reason: b.reason, at: this.now(),
      prs: { with: file?.with.eligiblePrs ?? [], without: file?.without.eligiblePrs ?? [] } });
    this.save(); return true;
  }
  counts() {
    const suspects = this.suspects();
    return { open: suspects.filter((s) => s.open).length, overdue: suspects.filter((s) => s.overdue).length };
  }
  private suspects() {
    return this.state.suspects.map((s) => {
      const f = s.findings.at(-1); const open = !f || f.finding === 'unknown' || f.at < s.at;
      const ageDays = (this.now() - s.at) / DAY;
      return { ...s, open, unresolved: f?.finding === 'unknown', ageDays,
        overdue: open && (!f || f.at < s.at) && ageDays > 3, status: open && (!f || f.at < s.at) && ageDays > 3 ? 'OVERDUE' : open ? 'pending' : 'closed' };
    });
  }
  report(setting: FirstPartSetting, evaluate = false) {
    if (evaluate) this.evaluate();
    const rows = this.rows(); const trial = currentTrial(rows); const stats = summarize(trial.observations);
    const suspects = this.suspects();
    const last = rows.filter((r): r is Observation => r.type === 'observation').at(-1);
    const confirmed = suspects.filter((s) => s.findings.at(-1)?.finding === 'confirmed');
    return { markers: rows.filter((r): r is Marker => r.type === 'marker'), trial: { id: trial.id, from: trial.from, to: trial.to, ended: trial.ended }, ...stats,
      limitsNote: stats.groups.with.verifies < 20 || stats.groups.without.verifies < 20
        ? 'Too few verifies to judge the deadline limit; it needs twenty in each group.'
        : this.state.lastEvaluation?.trial === trial.id && this.state.lastEvaluation.observations >= trial.observations.length
          ? 'No new observations since the last daily evaluation; another evaluation cannot switch the setting off.' : null,
      passingLimitNote: stats.groups.with.passes < 8 || stats.groups.without.passes < 8 ? 'Too few passes to judge the passing median limit; it needs eight in each group.' : null,
      scope: 'Every verify started under alternate in this trial, including changes outside the enrolment period.',
      episodesSince: this.state.since, episodes: this.state.episodes, suspects, lastEvaluation: this.state.lastEvaluation ?? null,
      open: suspects.filter((s) => s.open).length, overdue: suspects.filter((s) => s.overdue).length,
      stale: setting === 'alternate' && (!last || this.now() - last.at > DAY) ? 'No observation has been written for 24 hours.' : null,
      conclusion: confirmed.length ? `Confirmed changed-verdict cases: ${confirmed.map((s) => s.name).join(', ')}.`
        : 'Main verifies reported no failure traced to first parts. This is not proof that no verdict changed.' };
  }
}
