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

export const PROJECTS_SCHEMA_VERSION = 1;
/** One shared build for this long after it finishes (the owner's read; the union read is not free). */
export const PROJECTS_CACHE_MS = 10_000;
export const PROJECTS_MAX_CARDS_PER_PROJECT = 50;

export type ProjectState = 'paused' | 'done' | 'claims-done' | 'waiting-on-you' | 'moving' | 'stalled' | 'drifting' | 'stopped-retrying' | 'unknown';

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
  unknown: 'Not known yet',
};

/** Pinned order: what needs the person first, finished last. */
const STATE_ORDER: ProjectState[] = ['waiting-on-you', 'stopped-retrying', 'stalled', 'drifting', 'claims-done', 'moving', 'unknown', 'paused', 'done'];

export interface CosProjectRow {
  conversationKey: string; title: string; goal: string; lastVerdict: string | null; lastCheckAt: string | null; parked: boolean;
  doneDefinition: Array<{ id: string; text: string }>; doneItems: Record<string, 'pass' | 'fail' | 'unknown'> | null;
  /** The owner's pause, from their logged words; it wins over the verdict. */
  pausedBy?: { who: string; at: string; quote: string; messageRef: string } | null;
  /** The tracker's newest check note (its own words), used to say why a project is "Not known yet". */
  lastNote?: string | null;
}

export interface ProjectCard { id: string; title: string; lane: string; needLine: string | null; conversationKey: string | null }

export interface ProjectRow {
  key: string; title: string; goal: string; state: ProjectState; stateWords: string; lastCheckAt: string | null;
  /** Project apps (docs/specs/project-apps.md §3.3): present only when the feature is on. */
  apps?: unknown[]; offers?: unknown[]; answers?: unknown[]; addable?: unknown[];
  /** When paused: the owner's own words and when (shown under the state). */
  paused: { at: string; quote: string } | null;
  /** For "Not known yet" only: the tracker's last check note, shortened, so the gap reads as known, not blank. */
  why: string | null;
  done: { items: Array<{ id: string; text: string; state: 'pass' | 'fail' | 'unknown' }>; met: number; total: number };
  cards: ProjectCard[]; moreCards: number; conversationKey: string;
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
export function composeProjects(cos: CosProjectRow[] | null | 'failed', board: { status: number; body: unknown } | null): Omit<ProjectsAnswer, 'viewer'> {
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
    const state = projectState(r);
    const items = r.doneDefinition.map((d) => ({ id: d.id, text: d.text, state: (r.doneItems?.[d.id] ?? 'unknown') as 'pass' | 'fail' | 'unknown' }));
    const cards = byKey.get(r.conversationKey) ?? [];
    return {
      key: r.conversationKey, title: r.title, goal: r.goal, state, stateWords: PROJECT_STATE_WORDS[state], lastCheckAt: r.lastCheckAt,
      paused: state === 'paused' && r.pausedBy ? { at: r.pausedBy.at, quote: r.pausedBy.quote } : null,
      why: state === 'unknown' && r.lastNote ? shortNote(r.lastNote) : null,
      done: { items, met: items.filter((i) => i.state === 'pass').length, total: items.length },
      cards: cards.slice(0, PROJECTS_MAX_CARDS_PER_PROJECT), moreCards: Math.max(0, cards.length - PROJECTS_MAX_CARDS_PER_PROJECT),
      conversationKey: r.conversationKey,
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
}

export function mountProjectsRoutes(router: Router, deps: ProjectsDeps): { invalidate: () => void } {
  const now = () => (deps.now ? deps.now() : Date.now());
  let last: { at: number; answer: Omit<ProjectsAnswer, 'viewer'> } | null = null;
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
      const composed = composeProjects(cos, deps.boardFor(req));
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
  return { invalidate: () => { last = null; } };
}
