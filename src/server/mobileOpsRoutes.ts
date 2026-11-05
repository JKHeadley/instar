/**
 * Native "is everything up" reads for the Instar iPhone app (docs/specs/mobile-native-ops-screens.md).
 *
 *   GET /mobile/jobs         — the schedule: every job, late or failing first, with next run times.
 *   GET /mobile/commitments  — promises: open ones first, with their due dates.
 *   GET /mobile/machines     — each machine with a plain status line, load verdict and version.
 *
 * Read-only. A paired OWNER phone (device-signed; DEVICE_ALLOWLIST lists exactly these three
 * paths) or the agent's bearer token may read them; an MSP phone gets 403 `owner-phone-required`.
 * Each answer is a purpose-built trimmed summary of what the web console already shows the owner
 * (Work > Schedule, Work > Promises, Capacity > Machines). It never carries a job's prompt or
 * script, a file path, a hostname, a token or any configuration value; free text (job
 * descriptions, promise text) is length-capped and passed through the shared secret scrubber.
 *
 * The summarizers are pure (unit-tested on both sides of every rule); the router takes its data
 * from the same server-side reads the console's own routes use (`GET /jobs?scope=pool`,
 * `GET /commitments?scope=mesh`, `GET /pool`), so the phone and the console cannot disagree about
 * which data exists.
 */
import crypto from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { devicePersonOf } from './mobilePairingRoutes.js';
import { scrubSecrets } from '../monitoring/scrubSecrets.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export const MOBILE_OPS_SCHEMA_VERSION = 1;
/** A job is late when its recorded next run is this far in the past and it is not running (console rule). */
export const LATE_GRACE_MS = 10 * 60_000;
/** Closed promises stay on the list for this long after they close. */
export const CLOSED_WINDOW_MS = 7 * 86_400_000;
export const MAX_JOBS = 300;
export const MAX_COMMITMENTS = 200;
export const DESCRIPTION_MAX = 200;
export const PROMISE_TEXT_MAX = 280;
/** A replicated promise older than this is marked stale (the console's REPLICA_FRESH_MS). */
export const REPLICA_FRESH_MS = 15 * 60_000;

type Rec = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const SCRUB_MARGIN = 2048;

/** Free text for the phone: secrets scrubbed, whitespace folded, length capped. */
export function phoneText(v: unknown, max: number): string | null {
  // Cut before scrubbing: a scrub pattern is quadratic on long text, and a peer's answer can be long.
  // The margin keeps a secret that crosses the shown length whole enough to be caught.
  const s = str(v)?.slice(0, max + SCRUB_MARGIN);
  if (!s) return null;
  const clean = scrubSecrets(s).replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

// ── access ────────────────────────────────────────────────────────────────────

type Principal = { kind: string };
/**
 * The bearer token (checked explicitly by `bearerOk`, never inferred from a missing principal), or a
 * device whose person resolves to the owner. Everything else is refused.
 */
export function ownerOrBearer(req: Request, bearerOk: (req: Request) => boolean): boolean {
  const p = (req as unknown as { instarPrincipal?: Principal }).instarPrincipal;
  if (!p || p.kind === 'token') return bearerOk(req);
  if (p.kind !== 'device') return false;
  const person = devicePersonOf(req);
  return person !== null && person.role === 'owner';
}

// ── words ─────────────────────────────────────────────────────────────────────

/** A length of time in plain words: "45 s", "3 min", "1 h 20 min", "2 d". */
export function spell(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60); const rm = m % 60;
  if (h < 48) return rm ? `${h} h ${rm} min` : `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** A cron expression in plain words, the console's wording (unrecognised shapes return the raw text). */
export function scheduleWords(cron: unknown): string {
  if (typeof cron !== 'string' || !cron.trim()) return 'no schedule';
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const clock = (h: number, m: number) => `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h >= 12 ? 'pm' : 'am'}`;
  const every = dom === '*' && mon === '*' && dow === '*';
  if (/^\*\/\d+$/.test(min) && hour === '*' && every) { const n = Number(min.slice(2)); return n === 1 ? 'Every minute' : `Every ${n} minutes`; }
  if (min === '*' && hour === '*' && every) return 'Every minute';
  if (/^\d+$/.test(min) && /^\*\/\d+$/.test(hour) && every) { const n = Number(hour.slice(2)); return n === 1 ? 'Every hour' : `Every ${n} hours`; }
  if (/^\d+$/.test(min) && hour === '*' && every) return 'Every hour';
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*') {
    if (dow === '*') return `Daily at ${clock(Number(hour), Number(min))}`;
    if (/^\d$/.test(dow)) return `${DAYS[Number(dow)] ?? dow} at ${clock(Number(hour), Number(min))}`;
    if (dow === '1-5') return `Weekdays at ${clock(Number(hour), Number(min))}`;
  }
  return cron;
}

// ── jobs ──────────────────────────────────────────────────────────────────────

export type MobileJobStatus = 'failing' | 'late' | 'running' | 'next-unknown' | 'ok' | 'elsewhere' | 'off';
const JOB_ORDER: Record<MobileJobStatus, number> = { failing: 0, late: 1, running: 2, 'next-unknown': 3, ok: 4, elsewhere: 5, off: 6 };

export interface MobileJob {
  slug: string;
  name: string;
  description: string | null;
  schedule: string | null;
  scheduleWords: string;
  enabled: boolean;
  status: MobileJobStatus;
  statusLine: string;
  needsLook: boolean;
  lastRunAt: string | null;
  lastResult: string | null;
  nextRunAt: string | null;
  consecutiveFailures: number;
  /** Verified nicknames of the machines whose entry decided the status (empty: none verified). */
  machines: string[];
}

interface JobEntry { job: Rec; state: Rec; local: boolean; machine: string | null }

function entryStatus(e: JobEntry, now: number): { status: MobileJobStatus; line: string; next: number | null } {
  const s = e.state;
  const failures = num(s.consecutiveFailures) ?? 0;
  const failWords = failures ? (failures === 1 ? 'Failed its last run' : `Failed its last ${failures} runs`) : null;
  if (e.job.enabled === false) return { status: 'off', line: 'Switched off', next: null };
  const nextT = Date.parse(String(s.nextScheduled ?? ''));
  const next = Number.isFinite(nextT) ? nextT : null;
  // Placement decides first: a machine that does not run the job reports "elsewhere", whatever
  // failures or running state it once recorded, so it can never outrank the machine that runs it.
  if (!e.local) return { status: 'elsewhere', line: 'Not set to run on these machines', next: null };
  if (s.lastResult === 'pending') {
    const since = Date.parse(String(s.lastRun ?? ''));
    const running = Number.isFinite(since) ? `Running for ${spell(now - since)}` : 'Running';
    // A retry running after failures stays "failing" (it needs a look until a run succeeds).
    if (failures) return { status: 'failing', line: [running, failWords?.toLowerCase()].join(' · '), next };
    return { status: 'running', line: running, next };
  }
  const late = next !== null && now - next > LATE_GRACE_MS;
  const lateWords = late ? `past its next-run time by ${spell(now - (next as number))}` : null;
  if (failures) return { status: 'failing', line: [failWords, lateWords].filter(Boolean).join(' · '), next };
  if (next === null) return { status: 'next-unknown', line: 'Next run unknown', next };
  if (late) return { status: 'late', line: `Late: ${lateWords}, not running`, next };
  return { status: 'ok', line: next > now ? `Next run in ${spell(next - now)}` : 'Due now', next };
}

/**
 * The schedule from `GET /jobs?scope=pool`'s payload (or the plain `{ jobs }` answer). One row per
 * job slug; a job read from several machines shows its worst machine's status (console rule).
 */
export function summarizeJobs(payload: unknown, now: number): { jobs: MobileJob[]; truncated: boolean } {
  const list = Array.isArray((payload as Rec | null)?.jobs) ? ((payload as Rec).jobs as unknown[]) : [];
  const bySlug = new Map<string, JobEntry[]>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const j = raw as Rec;
    // Job slugs are kebab-case identifiers; anything else is not a job this screen shows.
    const slug = str(j.slug);
    if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(slug)) continue;
    const state = (j.state && typeof j.state === 'object' ? j.state : {}) as Rec;
    const machine = verifiedEntityName(String(j.machineId ?? ''), j.machineNickname);
    const entries = bySlug.get(slug) ?? [];
    // An older peer may not send runsOnThisMachine: a peer row without it is not counted as
    // running there (so it can never read "late"); a local row without it is (older scheduler).
    const local = j.runsOnThisMachine === true || (j.runsOnThisMachine === undefined && j.remote !== true);
    entries.push({ job: j, state, local, machine });
    bySlug.set(slug, entries);
  }
  const rows: Array<MobileJob & { _next: number | null }> = [];
  for (const [slug, entries] of bySlug) {
    const scored = entries.map((e) => ({ e, r: entryStatus(e, now) }));
    // Worst status wins (failing > late > running > next-unknown > ok > elsewhere > off); among
    // entries with that status, the soonest recorded next run. Every time shown is that entry's
    // own, so a late row shows its overdue time, never another machine's future run.
    const worstOrder = Math.min(...scored.map((x) => JOB_ORDER[x.r.status]));
    const same = scored.filter((x) => JOB_ORDER[x.r.status] === worstOrder);
    const worst = same.reduce((w, x) => ((x.r.next ?? Infinity) < (w.r.next ?? Infinity) ? x : w), same[0]);
    const job = worst.e.job;
    const s = worst.e.state;
    const machines = same.map((x) => x.e.machine).filter((m): m is string => !!m);
    const lastResult = str(s.lastResult);
    rows.push({
      slug,
      name: phoneText(job.name, 80) ?? phoneText(slug, 80) ?? 'A job with no name',
      description: phoneText(job.description, DESCRIPTION_MAX),
      schedule: phoneText(job.schedule, 64),
      scheduleWords: phoneText(scheduleWords(job.schedule), 64) ?? 'no schedule',
      enabled: job.enabled !== false,
      status: worst.r.status,
      statusLine: worst.r.line,
      needsLook: worst.r.status === 'failing' || worst.r.status === 'late',
      lastRunAt: iso(s.lastRun),
      lastResult: lastResult && /^[a-z-]{1,24}$/.test(lastResult) ? lastResult : null,
      nextRunAt: worst.r.next !== null ? new Date(worst.r.next).toISOString() : null,
      consecutiveFailures: num(s.consecutiveFailures) ?? 0,
      machines: [...new Set(machines)],
      _next: worst.r.next !== null && worst.r.next > now ? worst.r.next : null,
    });
  }
  rows.sort((a, b) => JOB_ORDER[a.status] - JOB_ORDER[b.status]
    || (a._next ?? Infinity) - (b._next ?? Infinity)
    || a.name.localeCompare(b.name));
  const truncated = rows.length > MAX_JOBS;
  return { jobs: rows.slice(0, MAX_JOBS).map(({ _next, ...r }) => r), truncated };
}

// ── commitments ───────────────────────────────────────────────────────────────

export interface MobileCommitment {
  id: string;
  text: string;
  request: string | null;
  status: string;
  open: boolean;
  dueAt: string | null;
  overdue: boolean;
  waitingOn: 'you' | 'your answer' | 'your approval' | 'something outside' | null;
  atRisk: boolean;
  createdAt: string | null;
  resolvedAt: string | null;
  /** Verified name of the machine holding the promise when it is another machine's; else null. */
  machine: string | null;
  /** A replicated copy whose last update is older than 15 min, or of unknown age. */
  stale: boolean;
}

const WAIT_WORDS: Record<string, MobileCommitment['waitingOn']> = { 'user-input': 'your answer', 'user-authorization': 'your approval', external: 'something outside' };

/** The soonest real date a promise carries (console's nextDue). */
function nextDue(c: Rec): number | null {
  const ts = [c.hardDeadlineAt, c.checkInAt, c.nextUpdateDueAt, c.softDeadlineAt].map((t) => Date.parse(String(t ?? ''))).filter(Number.isFinite);
  return ts.length ? Math.min(...ts) : null;
}

/**
 * Promises from the commitment rows (own and, with the mesh view, replicas). Open (`pending`)
 * promises first — overdue, then by due date, then newest — then promises closed in the last
 * seven days, newest first. Older closed promises are left out.
 */
export function summarizeCommitments(rows: unknown, now: number, nicknameOf: (machineId: string) => string | null = () => null): { commitments: MobileCommitment[]; truncated: boolean } {
  const list = Array.isArray(rows) ? rows : [];
  const out: Array<MobileCommitment & { _due: number | null; _at: number }> = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Rec;
    const id = str(c.id);
    const status = str(c.status);
    if (!id || !status) continue;
    const open = status === 'pending';
    const resolved = Date.parse(String(c.resolvedAt ?? ''));
    const created = Date.parse(String(c.createdAt ?? ''));
    if (!open) {
      const closedAt = Number.isFinite(resolved) ? resolved : created;
      if (!Number.isFinite(closedAt) || now - closedAt > CLOSED_WINDOW_MS) continue;
    }
    const due = nextDue(c);
    const hard = Date.parse(String(c.hardDeadlineAt ?? ''));
    const blockedOn = str(c.blockedOn);
    const waitingOn: MobileCommitment['waitingOn'] = c.owner === 'user' && (!blockedOn || blockedOn === 'none') ? 'you' : (blockedOn ? WAIT_WORDS[blockedOn] ?? null : null);
    const replica = c.viewSource === 'replica';
    const origin = str(c.originMachineId);
    const text = phoneText(c.agentResponse, PROMISE_TEXT_MAX) ?? phoneText(c.userRequest, PROMISE_TEXT_MAX) ?? 'Promise details unavailable';
    out.push({
      id: id.slice(0, 64),
      text,
      request: phoneText(c.userRequest, PROMISE_TEXT_MAX),
      status: /^[a-z-]{1,24}$/.test(status) ? status : 'unknown',
      open,
      dueAt: due !== null ? new Date(due).toISOString() : null,
      overdue: open && Number.isFinite(hard) && hard < now,
      waitingOn: open ? waitingOn : null,
      atRisk: open && c.atRisk === true,
      createdAt: Number.isFinite(created) ? new Date(created).toISOString() : null,
      resolvedAt: Number.isFinite(resolved) ? new Date(resolved).toISOString() : null,
      machine: replica && origin ? verifiedEntityName(origin, nicknameOf(origin)) : null,
      stale: replica && !(typeof c.stalenessMs === 'number' && Number.isFinite(c.stalenessMs) && c.stalenessMs <= REPLICA_FRESH_MS),
      _due: due,
      _at: Number.isFinite(open ? created : resolved) ? (open ? created : resolved) : 0,
    });
  }
  out.sort((a, b) => Number(b.open) - Number(a.open)
    || (a.open ? Number(b.overdue) - Number(a.overdue) || (a._due ?? Infinity) - (b._due ?? Infinity) : 0)
    || b._at - a._at);
  const truncated = out.length > MAX_COMMITMENTS;
  return { commitments: out.slice(0, MAX_COMMITMENTS).map(({ _due, _at, ...r }) => r), truncated };
}

// ── machines ──────────────────────────────────────────────────────────────────

export type MobileMachineState = 'live' | 'struggling' | 'unreachable' | 'stale' | 'unknown';
const MACHINE_ORDER: Record<MobileMachineState, number> = { unreachable: 0, struggling: 1, stale: 2, unknown: 3, live: 4 };

export interface MobileMachine {
  /** A stable opaque row key (a hash of the machine id), so rows keep their identity across refreshes. */
  key: string;
  name: string;
  isSelf: boolean;
  leading: boolean;
  state: MobileMachineState;
  statusLine: string;
  loadVerdict: string | null;
  loadPerCore: number | null;
  sessions: number | null;
  maxSessions: number | null;
  version: string | null;
}

/** Display state: the server's liveness block when present; else `online` read as live/stale (estimated). */
function machineState(m: Rec): { state: MobileMachineState; estimated: boolean } {
  const lv = m.liveness as Rec | undefined;
  if (lv && typeof lv.state === 'string') {
    if (lv.state === 'live') {
      const verdict = str(m.loadVerdict);
      return { state: verdict === 'saturated' || verdict === 'impaired' ? 'struggling' : 'live', estimated: false };
    }
    if (lv.state === 'unreachable') return { state: lv.shape === 'struggling' ? 'struggling' : 'unreachable', estimated: false };
    if (lv.state === 'stale') return { state: 'stale', estimated: false };
    return { state: 'unknown', estimated: false };
  }
  return { state: m.online === true ? 'live' : m.online === false ? 'stale' : 'unknown', estimated: true };
}

/** A one-way, stable row key for a machine (never the id itself). */
function machineKey(id: string): string {
  return crypto.createHash('sha256').update(`mobile-ops-machine:${id}`).digest('hex').slice(0, 16);
}

const LOAD_WORDS: Record<string, string> = { ok: 'load normal', elevated: 'busy', saturated: 'overloaded', impaired: 'struggling to keep up' };

/**
 * Each machine from the `GET /pool` view. A pool switched off gets one "This machine" row; a pool
 * that is on (or unstated) with no usable rows gets the same row with `inventoryKnown: false`.
 * `single` is true only for a pool switched off. Machines that are not answering come first.
 */
export function summarizeMachines(pool: unknown, selfVersion: string | null): { machines: MobileMachine[]; headline: string; single: boolean; inventoryKnown: boolean } {
  const p = (pool && typeof pool === 'object' ? pool : {}) as Rec;
  const raw = Array.isArray(p.machines) ? (p.machines as unknown[]).filter((m): m is Rec => !!m && typeof m === 'object' && !!str((m as Rec).machineId)) : [];
  const selfId = str(p.selfMachineId);
  const router = p.router as Rec | null | undefined;
  const leader = router ? str(router.holder) : null;
  if (raw.length === 0) {
    // This server answered, so this machine is up. Only a pool that is switched off proves it is
    // the only machine; an enabled pool with no usable rows means the list could not be read.
    const machines: MobileMachine[] = [{ key: selfId ? machineKey(selfId) : 'self', name: 'This machine', isSelf: true, leading: false, state: 'live', statusLine: 'Answering (this machine)', loadVerdict: null, loadPerCore: null, sessions: null, maxSessions: null, version: selfVersion }];
    if (p.enabled === false) return { machines, headline: 'One machine, answering.', single: true, inventoryKnown: true };
    return { machines, headline: "This machine is answering, but I can't read the list of your other machines right now.", single: false, inventoryKnown: false };
  }
  let estimatedPeers = 0;
  const rows = raw.map((m): MobileMachine => {
    const id = str(m.machineId) as string;
    const isSelf = !!selfId && id === selfId;
    const { state, estimated } = machineState(m);
    if (estimated && !isSelf) estimatedPeers += 1;
    const hw = (m.hardware && typeof m.hardware === 'object' ? m.hardware : {}) as Rec;
    const cores = num(hw.cpuCores);
    const load = num(m.loadAvg);
    const perCore = load !== null && cores ? Math.round((load / cores) * 100) / 100 : null;
    const verdict = str(m.loadVerdict);
    const liveness = phoneText(m.livenessLine, 160);
    const baseLine = liveness
      ? liveness.charAt(0).toUpperCase() + liveness.slice(1)
      : state === 'live' ? (isSelf ? 'Answering (this machine)' : 'Answering') : state === 'stale' ? 'Not heard from recently' : 'No evidence yet';
    const loadLine = verdict && verdict !== 'unknown' ? LOAD_WORDS[verdict] ?? null : null;
    const line = [baseLine, loadLine, estimated && !isSelf ? 'estimated' : null].filter(Boolean).join(' · ');
    return {
      key: machineKey(id),
      name: verifiedEntityName(id, m.nickname) ?? (isSelf ? 'This machine' : 'A machine with no name yet'),
      isSelf,
      leading: !!leader && leader === id,
      state,
      statusLine: line,
      loadVerdict: verdict && /^[a-z]{1,16}$/.test(verdict) ? verdict : null,
      loadPerCore: perCore,
      sessions: num(m.activeSessionCount),
      maxSessions: num(m.maxSessions),
      version: (str(hw.instarVersion) && /^[0-9A-Za-z.+-]{1,32}$/.test(String(hw.instarVersion)) ? String(hw.instarVersion) : null) ?? (isSelf ? selfVersion : null),
    };
  }).sort((a, b) => MACHINE_ORDER[a.state] - MACHINE_ORDER[b.state] || Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name));
  const down = rows.filter((r) => r.state === 'unreachable');
  const slow = rows.filter((r) => r.state === 'struggling');
  const unclear = rows.filter((r) => r.state === 'stale' || r.state === 'unknown');
  let headline: string;
  if (down.length) headline = down.length === 1 ? `${down[0].name} isn't answering.` : `${down.length} machines aren't answering.`;
  else if (slow.length) headline = slow.length === 1 ? `${slow[0].name} is struggling.` : `${slow.length} machines are struggling.`;
  else if (unclear.length) headline = unclear.length === 1 ? `I can't see ${unclear[0].name} clearly right now.` : `I can't see ${unclear.length} machines clearly right now.`;
  else if (estimatedPeers > 0) headline = rows.length === 2 ? 'Both machines appear to be answering (estimated from heartbeats).' : `All ${rows.length} machines appear to be answering (estimated from heartbeats).`;
  else headline = rows.length === 1 ? 'One known machine, answering.' : rows.length === 2 ? 'Both machines are answering.' : `All ${rows.length} machines are answering.`;
  // Only a pool switched off proves a single machine; a pool's one row is "one known machine".
  return { machines: rows, headline, single: p.enabled === false && rows.length === 1, inventoryKnown: true };
}

// ── routes ────────────────────────────────────────────────────────────────────

export interface MobileOpsDeps {
  /** The `GET /jobs?scope=pool` payload. */
  jobsView: () => Promise<unknown>;
  /** Whether this machine's scheduler is running (peers' jobs are listed either way). */
  schedulerRunning: () => boolean;
  /** The commitment rows (`GET /commitments?scope=mesh`), or null when promises are off. */
  commitmentsView: () => Promise<unknown[] | null>;
  /** The `GET /pool` payload. */
  poolView: () => unknown;
  /** Machine id → registry nickname (unverified; the summarizers verify it). */
  nicknameOf: (machineId: string) => string | null;
  /** This server's running version. */
  selfVersion: () => string | null;
  /** Whether the request carries the agent's own bearer token (explicit check). */
  bearerOk: (req: Request) => boolean;
  now?: () => number;
}

/** A read the phone could not get is recorded (route + error class only), never silent. */
function reportReadFailure(route: string, err: unknown): void {
  try {
    DegradationReporter.getInstance().report({
      feature: 'MobileOpsScreens.read',
      primary: `${route} answers the phone's native screen`,
      fallback: 'the phone shows "couldn\'t read" and the owner can retry or open the console',
      reason: err instanceof Error ? err.name : 'unknown error',
      impact: 'The owner\'s phone cannot show this screen until the read succeeds.',
    });
  } catch { /* @silent-fallback-ok — reporting must never turn a 500 into a crash */ }
}

/** Unreached peers in a pool payload, by verified name only (never an id or error text). */
function unreadMachines(payload: unknown, nicknameOf: (id: string) => string | null): { count: number; names: string[] } {
  const failed = (payload as Rec | null)?.pool && Array.isArray(((payload as Rec).pool as Rec).failed) ? (((payload as Rec).pool as Rec).failed as Rec[]) : [];
  const names = failed.map((f) => verifiedEntityName(String(f.machineId ?? ''), nicknameOf(String(f.machineId ?? '')))).filter((n): n is string => !!n);
  return { count: failed.length, names };
}

export function mountMobileOpsRoutes(router: Router, deps: MobileOpsDeps): void {
  const now = () => (deps.now ? deps.now() : Date.now());
  const guard = (req: Request, res: Response): boolean => {
    res.set('Cache-Control', 'no-store');
    if (ownerOrBearer(req, deps.bearerOk)) return true;
    res.status(403).json({ error: 'owner-phone-required', detail: 'Only the owner\'s phone can see the schedule, promises and machines.' });
    return false;
  };

  router.get('/mobile/jobs', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const payload = await deps.jobsView();
      const { jobs, truncated } = summarizeJobs(payload, now());
      const stale = ((payload as Rec | null)?.pool as Rec | undefined)?.stale === true;
      res.json({ schemaVersion: MOBILE_OPS_SCHEMA_VERSION, generatedAt: new Date(now()).toISOString(), schedulerRunning: deps.schedulerRunning(), poolEnabled: (payload as Rec | null)?.pool !== undefined && (((payload as Rec).pool as Rec).enabled === true), jobs, truncated, unread: unreadMachines(payload, deps.nicknameOf), ...(stale ? { stale: true } : {}) });
    } catch (err) {
      reportReadFailure('GET /mobile/jobs', err);
      res.status(500).json({ error: 'schedule-unavailable' });
    }
  });

  router.get('/mobile/commitments', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const rows = await deps.commitmentsView();
      if (rows === null) { res.json({ schemaVersion: MOBILE_OPS_SCHEMA_VERSION, generatedAt: new Date(now()).toISOString(), enabled: false, commitments: [], truncated: false }); return; }
      const { commitments, truncated } = summarizeCommitments(rows, now(), deps.nicknameOf);
      res.json({ schemaVersion: MOBILE_OPS_SCHEMA_VERSION, generatedAt: new Date(now()).toISOString(), enabled: true, commitments, truncated });
    } catch (err) {
      reportReadFailure('GET /mobile/commitments', err);
      res.status(500).json({ error: 'promises-unavailable' });
    }
  });

  router.get('/mobile/machines', (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const pool = deps.poolView();
      const { machines, headline, single, inventoryKnown } = summarizeMachines(pool, deps.selfVersion());
      res.json({ schemaVersion: MOBILE_OPS_SCHEMA_VERSION, generatedAt: new Date(now()).toISOString(), poolEnabled: (pool as Rec | null)?.enabled === true, single, inventoryKnown, headline, machines });
    } catch (err) {
      reportReadFailure('GET /mobile/machines', err);
      res.status(500).json({ error: 'machines-unavailable' });
    }
  });
}
