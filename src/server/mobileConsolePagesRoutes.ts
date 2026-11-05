/**
 * Native read-only screens for the console's remaining pages (docs/specs/mobile-native-console-pages.md).
 *
 *   GET /mobile/ideas        what the weekly look at similar projects found
 *   GET /mobile/pace         one plain line per work queue, across machines
 *   GET /mobile/development  shipping and feedback at a glance (maintainer agents)
 *   GET /mobile/maturation   the maturation board: features, grouped by the review's verdict
 *   GET /mobile/files        one folder of the file viewer, on this machine
 *   GET /mobile/files/read   one text file of the file viewer, on this machine
 *
 * Owner phone or bearer, read-only. Each answer is built from the console route it mirrors, read over
 * this server's own loopback, so a page can never show more than the console does: a switched-off
 * feature stays off, and every file rule (never-served paths, blocked names, allowed folders, symlinks)
 * is the viewer's own, not a copy. Answers are built field by field from an explicit list.
 */
import type { Request, Response, Router } from 'express';
import { ownerOrBearer, rowKey, singleFlight, POOL_READ_CACHE_MS } from './mobileCapacityRoutes.js';
import { cleanText } from './mobilePlansPeopleRoutes.js';
import { freeText } from './mobileProposalsInsideRoutes.js';
import { scrubSecrets } from '../monitoring/scrubSecrets.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export const MOBILE_CONSOLE_PAGES_SCHEMA_VERSION = 1;
export const MAX_IDEAS = 60;
export const MAX_PROJECTS = 40;
export const MAX_QUEUES = 40;
export const MAX_FEATURES = 300;
export const MAX_ENTRIES = 500;
export const MAX_PR_ROWS = 15;
/** The most of a file the phone is sent, and the longest line. Scrubbing runs per line, so the cost stays bounded. */
export const MAX_FILE_CHARS = 64 * 1024;
export const MAX_LINE_CHARS = 2000;

type Rec = Record<string, unknown>;
/** A console route's answer; status 0 means it could not be read at all. */
export interface SelfRead { status: number; body: unknown }
export interface MobileConsolePagesDeps {
  /** GET a path on this server with its own token. */
  read: (path: string) => Promise<SelfRead>;
  bearerOk: (req: Request) => boolean;
  now?: () => number;
}

const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === 'object' && !Array.isArray(x)) : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => { const n = num(v); return n !== null && n >= 0 ? Math.floor(n) : 0; };
const date = (v: unknown): string | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const pick = <T extends string>(words: Record<string, T>, key: unknown, fallback: T): T => (typeof key === 'string' && Object.hasOwn(words, key) ? words[key] : fallback);

/** A console route answering 503 or 404 means the feature is off here; anything else not 200 is a failed read. */
const isOff = (r: SelfRead): boolean => r.status === 503 || r.status === 404;
const off = (line: string): Rec => ({ state: 'off', line });
const unavailable = (line: string): Rec => ({ state: 'unavailable', line });

// ── Ideas ─────────────────────────────────────────────────────────────────────
const BANDS: Record<string, string> = { now: 'Ready to act on', plan: 'Worth planning', watch: 'Watching', unranked: 'Not ranked', stopped: 'Stopped' };
const BAND_ORDER = Object.keys(BANDS);
const CLASS_WORDS: Record<string, string> = {
  'additive-dark': 'New and off by default',
  'behaviour-changing': 'Changes what agents do',
  'reduces-capability': 'Takes something away, so it needs a blind trial',
};

export function summarizeIdeas(r: SelfRead): Rec {
  if (isOff(r)) return off('The idea review is not switched on for this agent.');
  if (r.status !== 200 || !Array.isArray(rec(r.body).ideas)) return unavailable("Can't read the ideas right now.");
  const b = rec(r.body);
  const f = rec(b.funnel);
  const bands = rec(f.bands);
  const ready = count(bands.now);
  const headline = b.neverRun === true ? 'The weekly review has not run yet.'
    : ready > 0 ? `${ready} idea${ready === 1 ? ' is' : 's are'} ready to act on.`
      : `Nothing is ready to act on. ${count(f.seen)} seen so far, ${count(f.adopted)} adopted.`;
  const all = arr(b.ideas).filter((i) => typeof i.band === 'string' && Object.hasOwn(BANDS, i.band))
    .sort((x, y) => BAND_ORDER.indexOf(String(x.band)) - BAND_ORDER.indexOf(String(y.band)));
  const ideas = all.slice(0, MAX_IDEAS).map((i) => ({
    key: rowKey('idea', String(i.id ?? i.claim)),
    band: String(i.band),
    bandWords: BANDS[String(i.band)],
    claim: freeText(i.claim, 280) ?? 'An idea',
    project: freeText(i.project, 100),
    reason: freeText(i.bandReason, 200),
    riskWords: pick(CLASS_WORDS, i.effectClass, 'Risk not judged yet'),
    costOfNotAdopting: freeText(rec(i.goal).costOfNotAdopting, 280),
  }));
  const watched = arr(b.watchlist);
  const projects = watched.slice(0, MAX_PROJECTS).map((w) => ({
    key: rowKey('idea-project', String(w.id ?? w.repo)),
    name: freeText(w.repo, 140) ?? 'A project',
    line: w.stalled === true ? 'Stalled after three failed weeks.'
      : w.lastError ? 'Last try failed, and it will try again.'
        : date(w.lastCheckedAt) ? `Checked ${String(date(w.lastCheckedAt)).slice(0, 10)}.` : 'Not checked yet.',
    stalled: w.stalled === true,
  }));
  return {
    state: 'ok', headline,
    funnel: { seen: count(f.seen), verified: count(f.verified), decided: count(f.decided), adopted: count(f.adopted) },
    ideas, truncated: all.length > ideas.length, projects, projectsTruncated: watched.length > projects.length,
    suggested: arr(b.proposals).length,
    lastRunProblem: !!b.lastTickError,
  };
}

// ── Pace ──────────────────────────────────────────────────────────────────────
const PACE_WORDS: Record<string, string> = {
  'falling-behind': 'falling behind',
  'catching-up': 'catching up',
  holding: 'holding steady',
  'shrinking-by-exits': 'shrinking, but not by finishing work',
  unknown: 'can’t tell yet',
  'owner-not-serving': 'not being worked on right now',
};
const rate = (n: number | null): string | null => (n === null ? null : n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));

function paceTone(q: Rec): string {
  if (rec(q.bottleneck).kind === 'person') return 'muted';
  if (q.verdict === 'falling-behind' || q.verdict === 'shrinking-by-exits') return 'attn';
  const measured = num(q.inflowPerDay) !== null && num(q.outflowPerDay) !== null;
  return measured && (q.verdict === 'catching-up' || q.verdict === 'holding') ? 'ok' : 'unknown';
}

function paceLine(q: Rec, label: string): string {
  const person = rec(q.bottleneck).kind === 'person';
  let verdict = pick(PACE_WORDS, q.verdict, PACE_WORDS.unknown);
  if (person && q.verdict === 'falling-behind') verdict = 'waiting on you';
  const inflow = num(q.inflowPerDay); const outflow = num(q.outflowPerDay); const open = count(q.open);
  if (inflow === 0 && outflow === 0 && open > 0) return `${label}: nothing came in or got done this week; ${open} still open`;
  const days = num(q.daysToClear);
  if (q.verdict === 'catching-up' && days !== null && !person) verdict += `, about ${rate(days)} days to clear`;
  const i = rate(inflow); const o = rate(outflow);
  return `${label}: ${i !== null && o !== null ? `${i} a day in, ${o} done — ` : ''}${verdict}`;
}

export function summarizePace(r: SelfRead): Rec {
  if (isOff(r)) return off('Pace is not switched on for this agent.');
  if (r.status !== 200 || !Array.isArray(rec(r.body).queues)) return unavailable("Can't read the pace of the work right now.");
  const b = rec(r.body);
  // Idle only when both rates were measured as zero and nothing is open; an unmeasured queue stays listed.
  const busy = arr(b.queues).filter((q) => !(num(q.inflowPerDay) === 0 && num(q.outflowPerDay) === 0 && !count(q.open)));
  // What needs attention comes first; the headline counts every queue, so a cut row still shows there.
  const ordered = [...busy.filter((q) => paceTone(q) === 'attn'), ...busy.filter((q) => paceTone(q) !== 'attn')];
  const rows = ordered.slice(0, MAX_QUEUES).map((q) => {
    const label = cleanText(q.label, 60) ?? 'Work queue';
    return { key: rowKey('pace', `${String(q.machineId)}:${String(q.id)}`), line: paceLine(q, label), tone: paceTone(q), machine: cleanText(q.machine, 60) };
  });
  // Counted before the row cap, so a queue past the cap still reaches the headline.
  const behind = busy.filter((q) => paceTone(q) === 'attn').length;
  const waitingOnYou = busy.filter((q) => rec(q.bottleneck).kind === 'person' && q.verdict === 'falling-behind').length;
  const unmeasured = busy.filter((q) => num(q.inflowPerDay) === null || num(q.outflowPerDay) === null || paceTone(q) === 'unknown').length;
  const unread = arr(b.sources).filter((s) => s.ok === false).map((s) => cleanText(s.machine, 60)).filter((n): n is string => !!n);
  const worries = [
    behind ? `${plural(behind, 'queue is', 'queues are')} falling behind` : null,
    waitingOnYou ? `${plural(waitingOnYou, 'queue is', 'queues are')} waiting on you` : null,
    unmeasured ? `${plural(unmeasured, 'queue')} can't be told yet` : null,
  ].filter(Boolean);
  return {
    state: 'ok', rows, truncated: busy.length > rows.length, unread,
    headline: busy.length === 0 ? (unread.length ? 'No work moving on the machines that answered.' : 'No work moving through the queues this week.')
      : worries.length ? `${worries.join('; ')}.`
        : unread.length ? 'Nothing is falling behind on the machines that answered.' : 'Nothing is falling behind.',
  };
}

// ── Development ───────────────────────────────────────────────────────────────
export function summarizeDevelopment(watcher: SelfRead, verify: SelfRead, triage: SelfRead): Rec {
  if (isOff(watcher) && isOff(verify) && triage.status !== 200) return off('Development is only on agents that build instar.');
  const w = rec(watcher.body); const v = rec(verify.body); const t = rec(triage.body);
  const wOk = watcher.status === 200 && Array.isArray(w.episodes);
  const vOk = verify.status === 200 && Array.isArray(v.queue);
  const tOk = triage.status === 200 && !!t.counts;
  if (!wOk && !vOk && !tOk) return unavailable("Can't read how shipping is going right now.");
  const queue = vOk ? arr(v.queue).filter((e) => count(e.pr) > 0) : [];
  const inFlight = vOk ? count(rec(v.inFlight).pr) : 0;
  const stuck = wOk ? arr(w.stuckRed) : [];
  const gaveUp = wOk ? arr(w.episodes).filter((e) => e.state === 'gave-up') : [];
  const held = vOk && (!!v.mainRedHold || !!v.verifierHold);
  const c = rec(t.counts);
  const rows = !wOk ? null : stuck.slice(0, MAX_PR_ROWS).map((s) => ({
    key: rowKey('dev-red', String(s.pr)), pr: count(s.pr),
    days: Math.floor(count(s.redForMs) / 86_400_000),
    checks: Array.isArray(s.failingChecks) ? s.failingChecks.length : 0,
  }));
  const parts = [
    vOk ? `${plural(queue.length, 'pull request')} waiting for tests` : null,
    wOk ? `${stuck.length} failing` : null,
  ].filter(Boolean);
  return {
    state: 'ok',
    headline: held ? 'Merging is on hold.' : parts.length ? `${parts.join(', ')}.` : 'Part of this could not be read.',
    tone: held || stuck.length ? 'attn' : wOk && vOk ? 'ok' : 'unknown',
    shipping: vOk || wOk ? {
      waiting: vOk ? queue.length : null, testingNow: inFlight || null, held: vOk ? held : null,
      failing: wOk ? stuck.length : null, gaveUp: wOk ? gaveUp.length : null, rows, rowsTruncated: wOk ? stuck.length > MAX_PR_ROWS : null,
    } : null,
    feedback: tOk ? { queued: count(c.queued), work: count(c.work), held: count(c.hold), ignored: count(c.ignored), untriaged: count(c.untriaged), paused: !!t.pausedBecause || !!t.quotaPause } : null,
  };
}

// ── Maturation board ──────────────────────────────────────────────────────────
const GROUPS: Array<{ id: string; label: string; tone: string; verdicts: string[] }> = [
  { id: 'broken', label: 'Broken', tone: 'bad', verdicts: ['regressed'] },
  { id: 'stuck', label: 'Stuck', tone: 'attn', verdicts: ['stalled'] },
  { id: 'unmeasured', label: 'Not measured', tone: 'attn', verdicts: ['blind'] },
  { id: 'progressing', label: 'On its way', tone: 'ok', verdicts: ['on-track', 'ready', 'too-new'] },
  { id: 'working', label: 'Working', tone: 'ok', verdicts: ['live'] },
  { id: 'leaving', label: 'Being retired', tone: 'muted', verdicts: ['retire-pending'] },
  { id: 'other', label: 'Not reviewed', tone: 'muted', verdicts: ['other', 'not-reviewed'] },
];
const groupOf = (verdict: unknown) => GROUPS.find((g) => g.verdicts.includes(String(verdict))) ?? GROUPS[GROUPS.length - 1];

export function summarizeMaturation(r: SelfRead): Rec {
  if (isOff(r)) return off('The maturation board is not switched on for this agent.');
  if (r.status !== 200 || !Array.isArray(rec(r.body).features)) return unavailable("Can't read the maturation board right now.");
  const b = rec(r.body);
  if (b.reviewState === 'unavailable') return unavailable('Can’t show the latest review right now: the machine that holds it isn’t answering.');
  const all = arr(b.features);
  const groupId = (f: Rec): string => groupOf(f.review ? rec(f.review).verdict : 'not-reviewed').id;
  // Group order puts what needs attention first; the counts cover every feature, cut or not.
  const rank = (f: Rec): number => GROUPS.findIndex((g) => g.id === groupId(f));
  const rows = [...all].sort((x, y) => rank(x) - rank(y)).slice(0, MAX_FEATURES).map((f) => {
    const review = rec(f.review);
    return {
      key: rowKey('maturation', String(f.id)),
      group: groupId(f),
      name: freeText(f.title, 100) ?? 'A feature',
      area: freeText(review.area, 60),
      line: freeText(review.line, 200) ?? freeText(review.summary, 200),
      purpose: freeText(review.purpose, 240),
      nextStep: freeText(review.nextStep, 240),
    };
  });
  // Counted over every feature, not the shown rows.
  const tally = new Map<string, number>();
  for (const f of all) tally.set(groupId(f), (tally.get(groupId(f)) ?? 0) + 1);
  const groups = GROUPS.map((g) => ({ id: g.id, label: g.label, tone: g.tone, count: tally.get(g.id) ?? 0 })).filter((g) => g.count > 0);
  const unread = [...new Set(arr(b.sources).filter((s) => s.ok === false).map((s) => cleanText(s.machine, 60)).filter((n): n is string => !!n))];
  const n = (id: string) => groups.find((g) => g.id === id)?.count ?? 0;
  const need = n('broken') + n('stuck') + n('unmeasured');
  return {
    state: 'ok',
    headline: all.length ? `${all.length} features: ${n('working')} working, ${need} need attention.` : 'No features to show yet.',
    reviewDate: typeof b.reviewDate === 'string' ? b.reviewDate.slice(0, 10) : null,
    groups, rows, truncated: all.length > rows.length, unread,
  };
}

// ── Files ─────────────────────────────────────────────────────────────────────
const fileName = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, 255) : null);
/**
 * One step past the viewer's own rules, for the phone only: a file or folder whose name says it holds a
 * secret is neither listed nor read, even where the console shows it. Over-hiding a name costs little.
 */
const SECRET_WORD = /(^|[-_.])(auth|keys?|tokens?|secrets?|credentials?|passwords?|vault|private)([-_.]|$)/i;
export const secretShaped = (p: string): boolean => p.split('/').some((part) => SECRET_WORD.test(part));

export function summarizeFolder(r: SelfRead): Rec {
  if (r.status === 404 && rec(r.body).error === 'file viewer is disabled') return off('The file viewer is switched off for this agent.');
  if (r.status === 403) return { state: 'refused', line: 'This folder can’t be shown.' };
  if (r.status !== 200 || !Array.isArray(rec(r.body).entries)) return unavailable("Can't read this folder right now.");
  const b = rec(r.body);
  const shown = arr(b.entries).flatMap((e) => {
    const name = fileName(e.name);
    if (!name || secretShaped(name) || (e.type !== 'file' && e.type !== 'directory')) return [];
    return [{ name, folder: e.type === 'directory', size: num(e.size), modified: date(e.modified) }];
  });
  const entries = shown.slice(0, MAX_ENTRIES);
  return { state: 'ok', path: typeof b.path === 'string' ? b.path : '', entries, truncated: b.truncated === true || shown.length > entries.length };
}

/** Cut, then scrub line by line: the scrub patterns cost more on long text, and a line is where a secret sits. */
export function phoneFileText(content: string): { text: string; cut: boolean } {
  const cut = content.length > MAX_FILE_CHARS;
  let shortened = false;
  const lines = content.slice(0, MAX_FILE_CHARS).split('\n').map((line) => {
    if (line.length <= MAX_LINE_CHARS) return scrubSecrets(line);
    shortened = true;
    return `${scrubSecrets(line.slice(0, MAX_LINE_CHARS))}…`;
  });
  return { text: lines.join('\n'), cut: cut || shortened };
}

export function summarizeFile(r: SelfRead): Rec {
  if (r.status === 404 && rec(r.body).error === 'file viewer is disabled') return off('The file viewer is switched off for this agent.');
  if (r.status === 403) return { state: 'refused', line: 'This file can’t be shown here.' };
  if (r.status === 413) return { state: 'too-big', line: 'This file is too big to show.' };
  if (r.status !== 200) return unavailable("Can't read this file right now.");
  const b = rec(r.body);
  const base = { path: typeof b.path === 'string' ? b.path : '', size: num(b.size), modified: date(b.modified) };
  if (b.binary === true) return { state: 'binary', line: 'This file isn’t text, so it can’t be shown here.', ...base };
  if (typeof b.content !== 'string') return unavailable("Can't read this file right now.");
  const { text, cut } = phoneFileText(b.content);
  return { state: 'ok', ...base, text, cut };
}

// ── routes ────────────────────────────────────────────────────────────────────
function report(route: string, err: unknown): void {
  try {
    DegradationReporter.getInstance().report({
      feature: 'mobile-console-pages', primary: `Answer ${route} from the console's own read`,
      fallback: 'The phone is told this part could not be read', reason: err instanceof Error ? err.name : 'read-failed',
      impact: 'A native screen shows that it could not read this',
    });
  } catch { /* @silent-fallback-ok — reporting must never turn a 500 into a crash */ }
}

/** A path from the phone, as the file routes expect it: a relative text path, nothing else. */
function pathQuery(req: Request): string | null {
  const p = req.query.path;
  if (p === undefined) return '';
  return typeof p === 'string' && p.length <= 1024 ? p : null;
}

export function mountMobileConsolePagesRoutes(router: Router, deps: MobileConsolePagesDeps): void {
  const now = () => (deps.now ? deps.now() : Date.now());
  const cached = singleFlight<Rec>(POOL_READ_CACHE_MS, now);
  /** A read that fails is reported and answers status 0, which every page turns into "can't read this". */
  const read = async (path: string): Promise<SelfRead> => {
    try { return await deps.read(path); } catch (err) { report(`read ${path.split('?')[0]}`, err); return { status: 0, body: null }; }
  };
  const guard = (req: Request, res: Response): boolean => {
    res.set('Cache-Control', 'no-store');
    if (ownerOrBearer(req, deps.bearerOk)) return true;
    res.status(403).json({ error: 'owner-phone-required', detail: 'Only the owner\'s phone can see this.' });
    return false;
  };
  const head = () => ({ schemaVersion: MOBILE_CONSOLE_PAGES_SCHEMA_VERSION, generatedAt: new Date(now()).toISOString() });
  const page = (route: string, build: () => Promise<Rec>) => {
    router.get(route, async (req: Request, res: Response) => {
      if (!guard(req, res)) return;
      try {
        res.json({ ...head(), ...await cached(route, build) });
      } catch (err) {
        report(`GET ${route}`, err);
        res.status(500).json({ error: 'console-page-unavailable' });
      }
    });
  };
  page('/mobile/ideas', async () => summarizeIdeas(await read('/ecosystem-ideas')));
  page('/mobile/pace', async () => summarizePace(await read('/queue-pace?scope=pool')));
  page('/mobile/development', async () => {
    const [watcher, verify, triage] = await Promise.all([read('/green-pr-automerge'), read('/local-verify'), read('/feedback-factory/triage/summary')]);
    return summarizeDevelopment(watcher, verify, triage);
  });
  page('/mobile/maturation', async () => summarizeMaturation(await read('/maturation/board?scope=pool')));

  router.get('/mobile/files', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    const p = pathQuery(req);
    if (p === null) { res.status(400).json({ error: 'bad-path' }); return; }
    if (secretShaped(p)) { res.json({ ...head(), state: 'refused', line: 'This folder can’t be shown.' }); return; }
    try {
      res.json({ ...head(), ...summarizeFolder(await read(`/api/files/list${p ? `?path=${encodeURIComponent(p)}` : ''}`)) });
    } catch (err) {
      report('GET /mobile/files', err);
      res.status(500).json({ error: 'console-page-unavailable' });
    }
  });
  router.get('/mobile/files/read', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    const p = pathQuery(req);
    if (!p) { res.status(400).json({ error: 'bad-path' }); return; }
    if (secretShaped(p)) { res.json({ ...head(), state: 'refused', line: 'This file can’t be shown here.' }); return; }
    try {
      res.json({ ...head(), ...summarizeFile(await read(`/api/files/read?path=${encodeURIComponent(p)}`)) });
    } catch (err) {
      report('GET /mobile/files/read', err);
      res.status(500).json({ error: 'console-page-unavailable' });
    }
  });
}

