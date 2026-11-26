/**
 * Projects on the Work door (docs/specs/work-front-doors.md §7 stage 2, slice 2a; plan:
 * .instar/lanes/work-front-doors-1114/stage2-plan.md). One read for the console, the phones and the Mac app:
 * the Chief of Staff's bound projects, where each stands, its done list, and the work-board cards that belong
 * to it (a card's `projectKey` is the project's conversation key). Cards with no project are listed apart.
 *
 * Read-only; no new store. A source that cannot be read is named in `couldNotCheck`, never shown as empty.
 * Owner only in 2a: a member's or guest's phone gets no project names (spec §4.4) and an empty answer.
 */
import type { Request, Response, Router } from 'express';
import { needsViewer, type NeedsViewerRole } from './needsRoutes.js';
import { doneItemCheckRef, isValidConversationKey, isProjectPriority } from '../core/ChiefOfStaffStore.js';
import type { CheckNowResult } from '../core/ChiefOfStaffLoop.js';

/** Stays 1: the row fields of docs/specs/work-door-project-rows.md §3.1 are additive; a client detects them by `actions`. */
export const PROJECTS_SCHEMA_VERSION = 1;
/** One shared build for this long after it finishes (the owner's read; the union read is not free). */
export const PROJECTS_CACHE_MS = 10_000;
export const PROJECTS_MAX_CARDS_PER_PROJECT = 50;

export type ProjectState = 'paused' | 'done' | 'claims-done' | 'waiting-on-you' | 'moving' | 'stalled' | 'drifting' | 'stopped-retrying' | 'quiet' | 'unknown';

/** The words a person sees for each state. The server owns them so every surface says the same thing. */
export const PROJECT_STATE_WORDS: Record<ProjectState, string> = {
  paused: 'Paused by you',
  done: 'Done',
  'claims-done': "Says it's done, not confirmed yet",
  'waiting-on-you': 'Waiting on you',
  moving: 'Moving',
  stalled: 'Stalled',
  drifting: 'Drifting',
  'stopped-retrying': 'I stopped retrying: needs a look',
  quiet: 'Quiet',
  unknown: 'Not known yet',
};

/** Pinned order: what needs the person first, finished last. */
const STATE_ORDER: ProjectState[] = ['waiting-on-you', 'stopped-retrying', 'stalled', 'drifting', 'claims-done', 'moving', 'quiet', 'unknown', 'paused', 'done'];

export interface CosProjectRow {
  priority?: 'high' | 'normal' | 'low';
  conversationKey: string; title: string; goal: string; lastVerdict: string | null; lastCheckAt: string | null; parked: boolean;
  /** The done list; `kind`/`certify` come from the loop's overview (an older loop leaves them out: every item then reads as an automatic check). */
  doneDefinition: Array<{ id: string; text: string; kind?: 'deterministic' | 'judgment'; certify?: 'owner-confirms' | 'agent-may-certify' }>; doneItems: Record<string, 'pass' | 'fail' | 'unknown'> | null;
  /** The owner's pause, from their logged words; it wins over the verdict. */
  pausedBy?: { who: string; at: string; quote: string; messageRef: string } | null;
  /** The tracker's newest check note (its own words), used to say why a project is "Not known yet". */
  lastNote?: string | null;
  // ── work-door-project-rows §3.1 (all optional: an older loop, or a test fixture, leaves them out) ──
  nextCheckAt?: string | null; breakerTripped?: boolean; restartsWithoutProgress?: number;
  ownerChecks?: Record<string, { at: string; who: string }>;
  bindingRef?: string | null;
  lastReport?: { at: string; note: string; verdict: string } | null;
  checkRequested?: boolean;
  // ── project-state-quiet-stalled (optional: an older loop leaves them out, and the row keeps the old "Not known yet") ──
  lastProgressAt?: string | null; lastEvidenceChangeAt?: string | null; lastCheckUnreadable?: boolean; cadenceHours?: number;
}

/** One done item as the row shows it (§3.1.3). */
export interface ProjectDoneItem {
  id: string; text: string; state: 'pass' | 'fail' | 'unknown';
  kind: 'check' | 'owner-judged' | 'agent-may-certify'; stateWords: string; checkedByYou: { at: string } | null;
  canMark: boolean; checkRef: string | null; why?: string;
}

export interface ProjectCard { id: string; title: string; lane: string; needLine: string | null; conversationKey: string | null }

export interface ProjectRow {
  priority?: 'high' | 'normal' | 'low';
  key: string; title: string; goal: string; state: ProjectState; stateWords: string; lastCheckAt: string | null;
  /** For "quiet" and "stalled": the last time anything was seen happening (evidence changed, or progress), ISO. Null otherwise. */
  stateSince: string | null;
  /** Project apps (docs/specs/project-apps.md §3.3): present only when the feature is on. */
  apps?: unknown[]; offers?: unknown[]; answers?: unknown[]; addable?: unknown[];
  /** When paused: the owner's own words and when (shown under the state), and where the tap was made. */
  paused: { at: string; quote: string; via: 'app' | 'telegram' } | null;
  /** For "Not known yet" only: the tracker's last check note, shortened, so the gap reads as known, not blank. */
  why: string | null;
  done: { items: ProjectDoneItem[]; met: number; total: number; checkedByYou: number; waitingForYou: number };
  cards: ProjectCard[]; moreCards: number; conversationKey: string;
  // ── work-door-project-rows §3.1 ──
  /** The Chief of Staff's newest report on the project; `confirmed: false` when that check's verdict was unknown. */
  latestReport: { text: string; at: string; confirmed: boolean } | null;
  /** Only when the state is "Waiting on you": what for, and the owner-judged items still unchecked. */
  waitingOnYou: { why: string; items: string[] } | null;
  checks: { last: string | null; next: string | null; nextWords: string | null; here: boolean; requested: { eligibleAt: string } | null };
  /** Only when the loop stopped retrying: why, in words. */
  stopped: { reason: 'no-progress' | 'breaker'; restarts: number; words: string } | null;
  /** The done list's version; a Finish tap signs it. */
  bindingRef: string | null;
  actions: { checkNow: { allowed: boolean; why: string | null; notBefore: string | null }; pause: 'pause' | 'resume' | null; finish: { allowed: boolean; why: string | null } };
}

export interface ProjectsAnswer {
  schemaVersion: number; viewer: { role: NeedsViewerRole };
  projects: ProjectRow[]; notInProject: ProjectCard[];
  sources: Array<{ id: 'chiefOfStaff' | 'workBoard'; label: string; state: 'ok' | 'off' | 'failed'; detail?: string }>;
  complete: boolean; couldNotCheck: string[];
}

/** A Chief of Staff verdict (and the loop's own parked flag) as one plain state. Parked is the loop giving up, never an owner pause. */
export function projectState(row: Pick<CosProjectRow, 'lastVerdict' | 'parked' | 'pausedBy'>): ProjectState {
  if (row.lastVerdict === 'done-verified') return 'done';
  if (row.pausedBy) return 'paused';
  if (row.parked) return 'stopped-retrying';
  switch (row.lastVerdict) {
    case 'claims-done': return 'claims-done';
    case 'waiting-on-user': return 'waiting-on-you';
    case 'moving': case 'moving-under-existing-owner': return 'moving';
    case 'stalled': return 'stalled';
    case 'drifting': return 'drifting';
    default: return 'unknown';
  }
}

export const PROJECT_WHY_MAX = 160;
/** A check note cut to one short line at a word boundary. */
export function shortNote(note: string): string {
  const one = note.replace(/\s+/g, ' ').trim();
  // A bare internal code (e.g. "judge-unavailable") is not words a person can use.
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(one)) return "The tracker's last check could not run.";
  if (one.length <= PROJECT_WHY_MAX) return one;
  const cut = one.slice(0, PROJECT_WHY_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), PROJECT_WHY_MAX - 30)).replace(/[,;:.\s]+$/, '')}…`;
}

/** Reason codes the loop writes as a check note, in words (§3.1.1). */
const REPORT_CODE_WORDS: Record<string, string> = {
  'gather-failed': "The last check could not read the project's evidence.",
  'owner-confirmed': 'You confirmed it is done.',
  'every deterministic done item passes': 'Every automatic check passes.',
  'every deterministic done item passes; judgment items pending': 'Every automatic check passes; the items only you can judge are waiting for you.',
};

/** A check note as the owner reads it: codes in words, whitespace collapsed, never cut (§3.1.1). */
export function reportWords(note: string): string {
  const one = note.replace(/\s+/g, ' ').trim();
  if (REPORT_CODE_WORDS[one]) return REPORT_CODE_WORDS[one];
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(one)) return 'The last check could not run.';
  return one;
}

/** Context the read needs from the loop beyond the rows: whether checks run here, and the tick interval. */
export interface ProjectsContext { here: boolean; tickMs: number; now: number; /** The owner's IANA zone for day words; absent = this machine's. */ timeZone?: string }

/** A project goes from quiet to stalled after this long with nothing happening while its done list is open. */
export const STALLED_MIN_HOURS = 48;
/** The quiet time after which an open project reads as stalled: two check cadences, at least two days. */
export function stalledAfterMs(cadenceHours: number | undefined): number {
  return Math.max(STALLED_MIN_HOURS, 2 * (cadenceHours && cadenceHours > 0 ? cadenceHours : 24)) * 3_600_000;
}

/** A time as a person says it, in the owner's zone: "9:14 AM" today, "yesterday", else "Nov 13". */
export function dayWords(iso: string, now: number, timeZone?: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'an unknown time';
  const fmt = (o: Intl.DateTimeFormatOptions, ms: number) => {
    try { return new Intl.DateTimeFormat('en-US', { ...o, ...(timeZone ? { timeZone } : {}) }).format(new Date(ms)); }
    catch { return new Intl.DateTimeFormat('en-US', o).format(new Date(ms)); } // @silent-fallback-ok: an invalid zone reads in this machine's zone
  };
  const day = (ms: number) => fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }, ms);
  if (day(t) === day(now)) return fmt({ hour: 'numeric', minute: '2-digit' }, t);
  if (day(t) === day(now - 86_400_000)) return 'yesterday';
  return fmt({ month: 'short', day: 'numeric' }, t);
}

/**
 * The state a person sees (pure). A verdict the judge could not call ("unknown") is settled from what the checks
 * did read: "Quiet since …" when nothing has happened lately, "Stalled since …" when nothing has happened for
 * stalledAfterMs while the done list is still open, and "unknown" only when the newest check could not read the
 * project's evidence (or none has run yet), with the reason in the words. Display only: no verdict changes.
 */
export function settleState(r: CosProjectRow, base: ProjectState, items: ProjectDoneItem[], ctx: ProjectsContext): { state: ProjectState; stateWords: string; stateSince: string | null } {
  const since = [r.lastEvidenceChangeAt, r.lastProgressAt].filter((x): x is string => typeof x === 'string' && x.length > 0).sort().pop() ?? null;
  if (base === 'stalled') return { state: base, stateWords: since ? `Stalled since ${dayWords(since, ctx.now, ctx.timeZone)}` : PROJECT_STATE_WORDS.stalled, stateSince: since };
  if (base !== 'unknown') return { state: base, stateWords: PROJECT_STATE_WORDS[base], stateSince: null };
  // An older loop does not send what settles it: keep the old words rather than guess.
  if (r.lastEvidenceChangeAt === undefined) return { state: 'unknown', stateWords: PROJECT_STATE_WORDS.unknown, stateSince: null };
  if (!r.lastCheckAt) return { state: 'unknown', stateWords: 'Not checked yet: the first check runs on the next round', stateSince: null };
  if (r.lastCheckUnreadable) return { state: 'unknown', stateWords: "Couldn't check: the last check could not read the project's evidence", stateSince: null };
  // Checks stopped landing (a gather that fails writes no check record): what the old checks read is no longer news.
  const lastCheck = Date.parse(r.lastCheckAt);
  if (Number.isFinite(lastCheck) && ctx.now - lastCheck >= stalledAfterMs(r.cadenceHours)) return { state: 'unknown', stateWords: `Couldn't check: no check has run since ${dayWords(r.lastCheckAt, ctx.now, ctx.timeZone)}`, stateSince: null };
  if (!since) return { state: 'unknown', stateWords: "Couldn't check: no check has been able to read the project's evidence", stateSince: null };
  const open = items.some((i) => i.state !== 'pass' && !i.checkedByYou);
  const when = dayWords(since, ctx.now, ctx.timeZone);
  if (open && ctx.now - Date.parse(since) >= stalledAfterMs(r.cadenceHours)) return { state: 'stalled', stateWords: `Stalled since ${when}`, stateSince: since };
  return { state: 'quiet', stateWords: `Quiet since ${when}`, stateSince: since };
}

const APP_REF = 'instar-app:';

function doneItemsOf(r: CosProjectRow, open: boolean): ProjectDoneItem[] {
  const ids = new Map<string, number>();
  for (const d of r.doneDefinition) ids.set(d.id, (ids.get(d.id) ?? 0) + 1);
  return r.doneDefinition.map((d) => {
    const k = d.kind ? { kind: d.kind, certify: d.certify } : null;
    const state = (r.doneItems?.[d.id] ?? 'unknown') as 'pass' | 'fail' | 'unknown';
    if (!k || k.kind === 'deterministic') {
      // "Not checked yet" only when no check ran; a check that could not read the item says so (an unknown is not a skip).
      const unknownWords = r.lastCheckAt ? 'Could not be checked at the last check' : 'Not checked yet';
      return { id: d.id, text: d.text, state, kind: 'check' as const, stateWords: state === 'pass' ? 'Passes' : state === 'fail' ? 'Fails' : unknownWords, checkedByYou: null, canMark: false, checkRef: null };
    }
    const kind = k.certify === 'agent-may-certify' ? 'agent-may-certify' as const : 'owner-judged' as const;
    const c = r.ownerChecks?.[d.id];
    const dup = (ids.get(d.id) ?? 0) > 1;
    const stateWords = c ? 'Checked by you' : kind === 'owner-judged' ? 'Waiting for you to check' : 'You let me certify this; until I can, it waits for you';
    return {
      id: d.id, text: d.text, state, kind, stateWords, checkedByYou: c ? { at: c.at } : null,
      canMark: open && !dup, checkRef: dup ? null : doneItemCheckRef(r.goal, d.id, d.text),
      ...(dup ? { why: "This item's id is used twice in the done list, so it cannot be checked on its own; Finish still confirms it." } : {}),
    };
  });
}

const STOPPED_WORDS = {
  'no-progress': (n: number) => `I restarted it ${n} time${n === 1 ? '' : 's'} without progress, so I stopped. Unpark it from the Chief of Staff's note to let me try again.`,
  breaker: () => "It hit the weekly restart limit, so I stopped. Unpark it from the Chief of Staff's note to let me try again.",
};

/** The §3.1 fields of one row (pure). */
export function rowExtras(r: CosProjectRow, state: ProjectState, ctx: ProjectsContext): Pick<ProjectRow, 'latestReport' | 'waitingOnYou' | 'checks' | 'stopped' | 'bindingRef' | 'actions'> & { items: ProjectDoneItem[] } {
  // Every row is an open binding (a closed project is not listed); "Done" is a verdict word, so actions stay open:
  // a done-verified check under a lapsed check-in lease is still open and still takes Finish.
  const done = false;
  const paused = state === 'paused';
  const items = doneItemsOf(r, true);
  const report = r.lastReport && r.lastReport.note ? { text: reportWords(r.lastReport.note), at: r.lastReport.at, confirmed: r.lastReport.verdict !== 'unknown' } : null;
  const latestReport = report ? { ...report, text: report.confirmed ? report.text : `Not confirmed: ${report.text}` } : null;
  const checks = items.filter((i) => i.kind === 'check');
  const autoPass = checks.every((i) => i.state === 'pass');
  // Items still needing the owner's own check (an item with a shared id cannot be checked alone; Finish confirms it).
  const unchecked = items.filter((i) => i.kind === 'owner-judged' && !i.checkedByYou && i.checkRef !== null);
  let waitingOnYou: ProjectRow['waitingOnYou'] = null;
  if (state === 'waiting-on-you') {
    const lead = checks.length ? 'Every automatic check passes. It' : 'There are no automatic checks; it';
    const why = autoPass && unchecked.length > 0 ? `${lead} needs you to check ${unchecked.length} item${unchecked.length === 1 ? '' : 's'}.`
      : autoPass && items.some((i) => i.kind !== 'check') ? `${checks.length ? 'Every automatic check passes and you' : 'You'} checked the rest. Tap Finish to close it.`
        : latestReport?.text ?? 'The Chief of Staff marked it as waiting on you but did not say why.';
    waitingOnYou = { why, items: unchecked.map((i) => i.id) };
  }
  const stopped = state === 'stopped-retrying' ? (r.breakerTripped ? { reason: 'breaker' as const, restarts: r.restartsWithoutProgress ?? 0, words: STOPPED_WORDS.breaker() } : { reason: 'no-progress' as const, restarts: r.restartsWithoutProgress ?? 0, words: STOPPED_WORDS['no-progress'](r.restartsWithoutProgress ?? 0) }) : null;
  const last = r.lastCheckAt;
  const eligible = last ? Date.parse(last) + ctx.tickMs : null;
  const checkNow = paused ? { allowed: false, why: 'It is paused.', notBefore: null } : done ? { allowed: false, why: 'It is finished.', notBefore: null }
    // notBefore applies only where checks run: elsewhere every tap is queued for the machine that runs them.
    : { allowed: true, why: null, notBefore: ctx.here && eligible !== null && eligible > ctx.now ? new Date(eligible).toISOString() : null };
  const finishWhy = done ? 'It is finished.' : unchecked.length ? `${unchecked.length} item${unchecked.length === 1 ? '' : 's'} still need${unchecked.length === 1 ? 's' : ''} your check.` : !autoPass ? 'Not every automatic check passes yet.' : !items.length ? 'It has no done list.' : null;
  return {
    items,
    latestReport, waitingOnYou, stopped, bindingRef: r.bindingRef ?? null,
    // A queued "Ask for an update" moves the next check forward to its first eligible tick: show that, not the cadence.
    checks: {
      last, here: ctx.here,
      next: paused || done ? null : r.checkRequested ? new Date(Math.max(ctx.now, eligible ?? ctx.now)).toISOString() : r.nextCheckAt ?? null,
      nextWords: paused ? 'Paused, so it is not checked' : done ? 'Finished' : r.checkRequested ? 'You asked for an update; checked on the next round' : last ? null : 'Checked on the next round',
      requested: !paused && r.checkRequested ? { eligibleAt: new Date(Math.max(ctx.now, eligible ?? ctx.now)).toISOString() } : null,
    },
    actions: { checkNow, pause: done ? null : paused ? 'resume' : 'pause', finish: { allowed: finishWhy === null, why: finishWhy } },
  };
}

/** The board answer's cards (owner view), skipping archived ones. Null when the board could not be read. */
function boardCards(board: { status: number; body: unknown } | null): { cards: Array<ProjectCard & { projectKey: string | null }>; state: 'ok' | 'off' | 'failed'; detail?: string } {
  if (!board) return { cards: [], state: 'off' };
  const err = (board.body as { error?: unknown } | null)?.error;
  if (board.status === 503 && (err === 'work-board-disabled' || err === 'work-board-off')) return { cards: [], state: 'off' };
  if (board.status !== 200) return { cards: [], state: 'failed', detail: typeof err === 'string' ? err : `answered ${board.status}` };
  const lanes = (board.body as { lanes?: unknown } | null)?.lanes;
  if (!Array.isArray(lanes)) return { cards: [], state: 'failed', detail: 'the answer could not be read' };
  const out: Array<ProjectCard & { projectKey: string | null }> = [];
  let cut = false;
  for (const l of lanes as Array<{ lane?: unknown; cards?: unknown; more?: unknown; total?: unknown }>) {
    if (l.lane === 'archived' || !Array.isArray(l.cards)) continue;
    // The board page cuts long lanes; the Projects read asks for every card, but if a lane still arrives cut,
    // its missing cards could belong to any project: name the gap instead of calling the list complete.
    if ((typeof l.more === 'number' && l.more > 0) || (typeof l.total === 'number' && l.total > (l.cards as unknown[]).length)) cut = true;
    for (const c of l.cards as Array<Record<string, unknown>>) {
      if (typeof c.id !== 'string') continue;
      out.push({
        id: c.id, title: typeof c.title === 'string' ? c.title : '', lane: String(c.lane ?? l.lane ?? ''),
        needLine: typeof c.needLine === 'string' ? c.needLine : null,
        conversationKey: typeof c.conversationKey === 'string' ? c.conversationKey : null,
        projectKey: typeof c.projectKey === 'string' ? c.projectKey : null,
      });
    }
  }
  return cut ? { cards: out, state: 'failed', detail: 'some cards were cut from the read' } : { cards: out, state: 'ok' };
}

/**
 * Compose the owner's answer. `cos` is null when the Chief of Staff is off on this agent, 'failed' when its
 * record could not be read; `board` is the owner's board read (or null when the board is off).
 */
export function composeProjects(cos: CosProjectRow[] | null | 'failed', board: { status: number; body: unknown } | null, ctx: ProjectsContext = { here: false, tickMs: 15 * 60_000, now: Date.now() }): Omit<ProjectsAnswer, 'viewer'> {
  const b = boardCards(board);
  const sources: ProjectsAnswer['sources'] = [
    { id: 'chiefOfStaff', label: 'the projects', state: cos === 'failed' ? 'failed' : cos === null ? 'off' : 'ok' },
    { id: 'workBoard', label: b.detail === 'some cards were cut from the read' ? 'every card on the work board' : 'the work board', state: b.state, ...(b.detail ? { detail: b.detail } : {}) },
  ];
  const rows = Array.isArray(cos) ? cos : [];
  const byKey = new Map<string, ProjectCard[]>();
  const notInProject: ProjectCard[] = [];
  const keys = new Set(rows.map((r) => r.conversationKey));
  for (const c of b.cards) {
    const { projectKey, ...card } = c;
    if (projectKey && keys.has(projectKey)) (byKey.get(projectKey) ?? byKey.set(projectKey, []).get(projectKey)!).push(card);
    else notInProject.push(card);
  }
  const projects: ProjectRow[] = rows.map((r) => {
    const base = projectState(r);
    // The extras (actions, waiting-on-you, stopped) key off the verdict's state; a settled quiet/stalled changes only the words.
    const { items, ...extras } = rowExtras(r, base, ctx);
    const { state, stateWords, stateSince } = settleState(r, base, items, ctx);
    const cards = byKey.get(r.conversationKey) ?? [];
    return {
      priority: isProjectPriority(r.priority) ? r.priority : 'normal' as const,
      key: r.conversationKey, title: r.title, goal: r.goal, state, stateWords, stateSince, lastCheckAt: r.lastCheckAt,
      paused: state === 'paused' && r.pausedBy ? { at: r.pausedBy.at, quote: r.pausedBy.quote, via: r.pausedBy.messageRef.startsWith(APP_REF) ? 'app' as const : 'telegram' as const } : null,
      why: state === 'unknown' && r.lastNote ? shortNote(r.lastNote) : null,
      // `met` stays the count of passing items: an owner's check is shown in `checkedByYou`, never as a pass.
      done: { items, met: items.filter((i) => i.state === 'pass').length, total: items.length, checkedByYou: items.filter((i) => i.checkedByYou).length, waitingForYou: items.filter((i) => i.kind === 'owner-judged' && !i.checkedByYou).length },
      cards: cards.slice(0, PROJECTS_MAX_CARDS_PER_PROJECT), moreCards: Math.max(0, cards.length - PROJECTS_MAX_CARDS_PER_PROJECT),
      conversationKey: r.conversationKey,
      ...extras,
    };
  }).sort((x, y) => STATE_ORDER.indexOf(x.state) - STATE_ORDER.indexOf(y.state) || x.title.localeCompare(y.title));
  const couldNotCheck = sources.filter((s) => s.state === 'failed').map((s) => s.label);
  return { schemaVersion: PROJECTS_SCHEMA_VERSION, projects, notInProject, sources, complete: couldNotCheck.length === 0, couldNotCheck };
}

export interface ProjectsDeps {
  /** The Chief of Staff's projects: null when it is off on this agent; throws or returns null-from-loop when unreadable. */
  projects: () => CosProjectRow[] | null | 'failed';
  /** The board read as this caller (stage 1's exposeBoardRead); null when the board route is not up yet. */
  boardFor: (req: Request) => { status: number; body: unknown } | null;
  bearerOk: (req: Request) => boolean;
  now?: () => number;
  /** Project apps for one project (docs/specs/project-apps.md §3.3); null/absent when the feature is off. */
  appsFor?: (conversationKey: string) => { apps: unknown[]; offers: unknown[]; answers: unknown[]; addable: unknown[] } | null;
  /** Whether this machine runs the checks, and the "Ask for an update" gap (work-door-project-rows §3.1.4, §3.2). */
  checkContext?: () => { here: boolean; gapMs: number };
  /** The owner's IANA zone for "Quiet since …" day words; absent = this machine's zone. */
  timeZone?: () => string | undefined;
  /** "Ask for an update" (work-door-project-rows §3.2); absent ⇒ 503 chief-of-staff-off. */
  checkNow?: (conversationKey: string, by: 'owner-tap' | 'chief-of-staff') => Promise<CheckNowResult>;
}

/** Each project refusal, its status and its words, shared by every project route (work-door-project-rows §3.2–3.5). */
export const PROJECT_REFUSALS: Record<string, { status: number; words: string }> = {
  'chief-of-staff-off': { status: 503, words: 'Projects need the Chief of Staff, which is not on for this agent.' },
  'union-unreadable': { status: 503, words: "I couldn't read the project's record just now. Try again in a moment." },
  'no-project': { status: 404, words: 'That project is not tracked any more. Pull to refresh.' },
  done: { status: 409, words: 'That project is finished.' },
  paused: { status: 409, words: 'That project is paused. Resume it first.' },
  'not-paused': { status: 409, words: 'That project is not paused.' },
  'no-item': { status: 404, words: 'That item is not on the done list any more. Pull to refresh.' },
  'duplicate-item-id': { status: 409, words: "This item's id is used twice in the done list, so it cannot be checked on its own; Finish still confirms it." },
  'not-owner-judged': { status: 409, words: 'That item is an automatic check; the Chief of Staff checks it itself.' },
  'item-changed': { status: 409, words: "This item or the project's goal changed since you saw it. Pull to refresh." },
  'project-changed': { status: 409, words: "The project's done list changed since you saw it. Pull to refresh." },
  'not-all-checked': { status: 409, words: 'Some items still need your check before you can finish it.' },
  'checks-fail': { status: 409, words: 'Not every automatic check passes, so nothing closed.' },
  'gather-failed': { status: 503, words: "I could not read the project's checks just now, so nothing closed. Try again in a minute." },
  'chief-of-staff-paused': { status: 503, words: 'Your check-in could not be recorded, so nothing closed. Try again in a moment.' },
  'not-recorded': { status: 503, words: "That couldn't be saved. Try again in a minute." },
  'write-failed': { status: 503, words: "That couldn't be saved. Try again in a minute." },
};

/** A refusal as a route answer, with its words. */
export function projectRefusal(reason: string, extra: Record<string, unknown> = {}): { status: number; body: Record<string, unknown> } {
  const r = PROJECT_REFUSALS[reason] ?? { status: 500, words: "That didn't work. Try again in a minute." };
  return { status: r.status, body: { error: reason, detail: r.words, ...extra } };
}

export function mountProjectsRoutes(router: Router, deps: ProjectsDeps): { invalidate: () => void; rowFor: (req: Request, key: string) => ProjectRow | null } {
  const now = () => (deps.now ? deps.now() : Date.now());
  let last: { at: number; answer: Omit<ProjectsAnswer, 'viewer'> } | null = null;
  const ctxNow = (): ProjectsContext => {
    let c = { here: false, gapMs: 14 * 60_000 };
    try { c = deps.checkContext?.() ?? c; } catch { /* @silent-fallback-ok: an unreadable context shows checks as not running here; the action routes answer for themselves */ }
    let timeZone: string | undefined;
    try { timeZone = deps.timeZone?.() || undefined; } catch { timeZone = undefined; } // @silent-fallback-ok: day words read in this machine's zone
    return { here: c.here, tickMs: c.gapMs, now: now(), ...(timeZone ? { timeZone } : {}) };
  };
  const handle = (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const role = needsViewer(req, deps.bearerOk);
    if (!role) { res.status(403).json({ error: 'projects-viewer-unknown', detail: 'This phone is not linked to a person on this agent.' }); return; }
    if (role !== 'owner') {
      // Spec §4.4: no project names for anyone but the owner in 2a. An empty, complete answer, not a refusal.
      res.json({ schemaVersion: PROJECTS_SCHEMA_VERSION, viewer: { role }, projects: [], notInProject: [], sources: [], complete: true, couldNotCheck: [] } satisfies ProjectsAnswer);
      return;
    }
    if (!last || now() - last.at >= PROJECTS_CACHE_MS) {
      let cos: CosProjectRow[] | null | 'failed';
      try { cos = deps.projects(); } catch { cos = 'failed'; } // @silent-fallback-ok — named in couldNotCheck, never shown as no projects
      const composed = composeProjects(cos, deps.boardFor(req), ctxNow());
      if (deps.appsFor) {
        for (const p of composed.projects) {
          let v: ReturnType<NonNullable<ProjectsDeps['appsFor']>> = null;
          try { v = deps.appsFor(p.key); } catch { v = null; } // @silent-fallback-ok — apps are additive; a failed read leaves the row without them
          if (v) Object.assign(p, v);
        }
      }
      last = { at: now(), answer: composed };
    }
    res.json({ ...last.answer, viewer: { role } } satisfies ProjectsAnswer);
  };
  router.get('/work/projects', handle);
  router.get('/mobile/work/projects', handle);

  /** One fresh row (the cache is dropped first): the answer every project action returns. */
  const rowFor = (req: Request, key: string): ProjectRow | null => {
    last = null;
    let cos: CosProjectRow[] | null | 'failed';
    try { cos = deps.projects(); } catch { cos = 'failed'; } // @silent-fallback-ok — a failed re-read answers without a row; the write itself already answered
    const composed = composeProjects(cos, deps.boardFor(req), ctxNow());
    const p = composed.projects.find((x) => x.key === key) ?? null;
    if (p && deps.appsFor) { try { const v = deps.appsFor(p.key); if (v) Object.assign(p, v); } catch { /* @silent-fallback-ok — apps are additive */ } }
    return p;
  };

  // "Ask for an update" (work-door-project-rows §3.2): the owner's phone (device-signed, no Face ID) or the bearer.
  const check = async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const role = needsViewer(req, deps.bearerOk);
    if (role !== 'owner') { res.status(403).json({ error: 'owner-required', detail: 'Only the owner can ask for an update on a project.' }); return; }
    const key = (req.body as { key?: unknown } | undefined)?.key;
    if (typeof key !== 'string' || !isValidConversationKey(key)) { res.status(400).json({ error: 'bad-key', detail: 'Name the project by its conversation key.' }); return; }
    if (!deps.checkNow) { const r = projectRefusal('chief-of-staff-off'); res.status(r.status).json(r.body); return; }
    const by = deps.bearerOk(req) ? 'chief-of-staff' as const : 'owner-tap' as const;
    let r: CheckNowResult;
    try { r = await deps.checkNow(key, by); } catch { r = { ok: false, reason: 'not-recorded' }; } // @silent-fallback-ok — answered as not recorded, never as checked
    if (!r.ok) { const f = projectRefusal(r.reason); res.status(f.status).json(f.body); return; }
    const project = rowFor(req, key);
    if (r.queued) {
      const mins = Math.max(1, Math.round((2 * (ctxNow().tickMs + 60_000)) / 60_000));
      res.status(202).json({ ok: true, queued: true, eligibleAt: r.eligibleAt, words: `The Chief of Staff will check it on its next round, within about ${mins} minutes.`, project });
      return;
    }
    res.json({ ok: true, queued: false, checkedAt: r.checkedAt, project });
  };
  router.post('/work/projects/check', check);
  router.post('/mobile/work/projects/check', check);
  return { invalidate: () => { last = null; }, rowFor };
}
