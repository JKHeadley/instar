/**
 * The owner's reading of /health (docs/specs/mobile-health-issues.md) and what they can do about it
 * (docs/specs/health-quick-actions.md).
 *
 *   GET  /mobile/health-issues              each reason /health is degraded, sorted, in plain words, with a next step
 *   POST /mobile/health-issues/choices      hide for a while, hide from me, or ignore one problem
 *   POST /mobile/health-issues/choices/undo bring one back
 *
 * Owner phone or bearer; the console uses its bearer. /health itself is read over loopback, so the two cannot
 * disagree about what is wrong. A choice is only taken for a problem showing right now, and binds to its exact ids.
 * Two more routes are for this agent's other machines, bearer only and off the phone's allowlist.
 *
 * Every problem in the reading is this machine's own (/health is read locally), so the answer and each row name
 * the machine that answered (`machine: { key, name }`, the same key as GET /mobile/machines). An agent on more than
 * one machine otherwise shows "someone at this Mac" with no way to tell which Mac.
 */
import type { Request, Response, Router } from 'express';
import { ownerOrBearer, singleFlight } from './mobileCapacityRoutes.js';
import { summarizeHealth, type HealthCurrentState, type HealthIssuesSummary } from '../monitoring/healthIssues.js';
import { SNOOZE_HOURS, offerFor, type HealthChoiceBy, type HealthChoiceMode, type HealthChoiceRow, type HealthChoiceStore } from '../monitoring/healthChoices.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export const MOBILE_HEALTH_SCHEMA_VERSION = 1;
/** The Fleet screen reads every 30 s per agent; a short cache keeps a burst to one /health read. */
export const HEALTH_READ_CACHE_MS = 5_000;
export const HEALTH_CHOICES_LOCAL_PATH = '/mobile/health-issues/choices?scope=local';
export const HEALTH_CHOICES_MERGE_PATH = '/mobile/health-issues/choices/merge';
/** How often this machine pulls choices from the others, and notices what stopped or came back. */
export const HEALTH_CHOICES_TICK_MS = 5 * 60_000;

type RawEvents = ReadonlyArray<{ feature?: unknown; timestamp?: unknown; internalOnly?: unknown; narrative?: unknown }>;

interface RawRead { body: unknown; events: RawEvents; current: HealthCurrentState }

export interface HealthChoicePeers {
  /** The machines a choice should reach. */
  list: () => string[];
  /** Each other online machine's saved rows, one entry per machine. */
  pull: () => Promise<unknown[]>;
  push: (rows: HealthChoiceRow[]) => Promise<{ reached: number; unreached: number }>;
}

export interface MobileHealthDeps {
  /** GET /health on this server with its own token, so the detailed fields are present. */
  readHealth: () => Promise<{ status: number; body: unknown }>;
  bearerOk: (req: Request) => boolean;
  /** The recent degradations /health counted. Defaults to the reporter. */
  recentEvents?: () => RawEvents;
  /** What is true now for channels that report a failure only once. */
  current?: () => HealthCurrentState;
  /** The person's choices. Without it the read is unchanged and the choice routes answer 503. */
  choices?: HealthChoiceStore;
  peers?: HealthChoicePeers;
  /** The machine that answered: its row key on GET /mobile/machines and its verified name. Without it no machine is named. */
  machine?: () => HealthMachine;
  now?: () => number;
}

/** Which machine a problem is on. `name` is null when the machine has no verified name yet. */
export interface HealthMachine { key: string | null; name: string | null }

/** Adds the machine that answered to the reading and to each of its problems. A failing lookup names none. */
export function withMachine<T extends { issues: object[] }>(summary: T, machine: (() => HealthMachine) | undefined): T & { machine?: HealthMachine } {
  if (!machine) return summary;
  let m: HealthMachine;
  try {
    m = machine();
  } catch (err) {
    report('naming this machine', err);
    return summary;
  }
  if (!m || (m.key === null && m.name === null)) return summary;
  const one = { key: m.key, name: m.name };
  return { ...summary, machine: one, issues: summary.issues.map((i) => ({ ...i, machine: one })) };
}

function report(detail: string, err: unknown): void {
  DegradationReporter.getInstance().report({
    feature: 'MobileHealthIssues.read',
    primary: 'Owner health reading',
    fallback: 'The phone and console say they could not read the agent’s health',
    reason: `${detail}: ${err instanceof Error ? err.message : String(err)}`,
    impact: 'The health screens can’t explain what is wrong right now.',
  });
}

function byOf(req: Request, bearerOk: (r: Request) => boolean): HealthChoiceBy {
  return bearerOk(req) ? 'dashboard-or-agent' : 'phone';
}

function notReachedNote(unreached: number): string | null {
  if (unreached === 0) return null;
  return unreached === 1
    ? 'Saved. One of this agent’s other machines didn’t answer, so it picks this up when it’s back.'
    : `Saved. ${unreached} of this agent’s other machines didn’t answer, so they pick this up when they’re back.`;
}

export function mountMobileHealthRoutes(router: Router, deps: MobileHealthDeps): void {
  const now = () => (deps.now ? deps.now() : Date.now());
  const cached = singleFlight<RawRead>(HEALTH_READ_CACHE_MS, now);
  const events = deps.recentEvents ?? (() => DegradationReporter.getInstance().getRecentEvents()
    .map((e) => ({ ...e, narrative: DegradationReporter.narrativeFor(e) })));
  const read = () => cached('health', async () => {
    const r = await deps.readHealth();
    if (r.status !== 200) throw new Error(`/health answered ${r.status}`);
    return { body: r.body, events: events(), current: deps.current?.() ?? {} };
  });
  const answer = (raw: RawRead): HealthIssuesSummary => summarizeHealth(raw.body, raw.events, raw.current, deps.choices);
  const page = (summary: HealthIssuesSummary) => ({ schemaVersion: MOBILE_HEALTH_SCHEMA_VERSION, generatedAt: new Date(now()).toISOString(), ...withMachine(summary, deps.machine) });

  const owner = (req: Request, res: Response): boolean => {
    res.set('Cache-Control', 'no-store');
    if (ownerOrBearer(req, deps.bearerOk)) return true;
    res.status(403).json({ error: 'owner-phone-required', detail: 'Only the owner\'s phone can see this.' });
    return false;
  };
  const machine = (req: Request, res: Response): boolean => {
    res.set('Cache-Control', 'no-store');
    if (deps.bearerOk(req)) return true;
    res.status(403).json({ error: 'bearer-required' });
    return false;
  };
  const off = (res: Response): void => { res.status(503).json({ error: 'choices-unavailable', detail: 'This agent can’t save that right now.' }); };

  /** Tell the other machines, and say honestly if one didn't answer. Never fails the choice: it's saved here. */
  const spread = async (rows: HealthChoiceRow[]): Promise<number> => {
    if (!deps.peers) return 0;
    try {
      return (await deps.peers.push(rows)).unreached;
    } catch (err) {
      report('telling other machines about a choice', err);
      return deps.peers.list().length;
    }
  };

  router.get('/mobile/health-issues', async (req: Request, res: Response) => {
    if (!owner(req, res)) return;
    try {
      res.json({ ...page(answer(await read())), ...(deps.choices?.failedToRead ? { hiddenUnreadable: true } : {}) });
    } catch (err) {
      report('GET /mobile/health-issues', err);
      // The one honest "can't tell": the agent answered but couldn't read its own health. Say why.
      const msg = err instanceof Error ? err.message : String(err);
      const reason = /abort|timeout|timed out/i.test(msg) ? 'timeout' : /\/health answered/.test(msg) ? 'health-read-failed' : 'summary-failed';
      res.status(500).json({
        error: 'health-unavailable', verdict: 'unsure', reason,
        detail: reason === 'timeout' ? 'I took too long to read my own health just now.' : 'I couldn’t read my own health just now.',
      });
    }
  });

  router.post('/mobile/health-issues/choices', async (req: Request, res: Response) => {
    if (!owner(req, res)) return;
    if (!deps.choices) { off(res); return; }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const { id, choice, hours, keys } = body;
    if (typeof id !== 'string' || id.length === 0 || id.length > 256 || (choice !== 'snooze' && choice !== 'hide' && choice !== 'ignore')) {
      res.status(400).json({ error: 'invalid-choice' });
      return;
    }
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 50 || keys.some((k) => typeof k !== 'string')) {
      res.status(400).json({ error: 'invalid-choice' });
      return;
    }
    if (choice === 'snooze' ? !(SNOOZE_HOURS as readonly unknown[]).includes(hours) : hours !== undefined) {
      res.status(400).json({ error: 'invalid-choice' });
      return;
    }
    try {
      const raw = await read();
      // Only ids that are behind this row now AND were on the person's screen: nothing that arrived since they looked.
      const issue = answer(raw).issues.find((i) => i.id === id);
      const shown = issue ? issue.keys.filter((k) => (keys as unknown[]).includes(k)) : [];
      if (!issue || shown.length === 0) { res.status(404).json({ error: 'issue-gone', detail: 'This has stopped happening, so there’s nothing to hide.' }); return; }
      if (!offerFor(shown, issue.impact === 'unclassified').choices.includes(choice as HealthChoiceMode)) {
        res.status(409).json({ error: 'choice-not-offered', detail: 'That choice isn’t available for this one.' });
        return;
      }
      const rows = deps.choices.choose(shown, { mode: choice as HealthChoiceMode, hours: hours as number | undefined, title: issue.title, by: byOf(req, deps.bearerOk) });
      const note = notReachedNote(await spread(rows));
      res.json({ ok: true, note, ...page(answer(raw)) });
    } catch (err) {
      report('POST /mobile/health-issues/choices', err);
      res.status(500).json({ error: 'choice-not-saved', detail: 'I couldn’t save that, so nothing changed. Try again.' });
    }
  });

  router.post('/mobile/health-issues/choices/undo', async (req: Request, res: Response) => {
    if (!owner(req, res)) return;
    if (!deps.choices) { off(res); return; }
    const key = (req.body as Record<string, unknown> | undefined)?.key;
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) { res.status(400).json({ error: 'invalid-choice' }); return; }
    try {
      // Read first: a failed read then truly means nothing changed.
      const raw = await read();
      const row = deps.choices.undo(key, byOf(req, deps.bearerOk));
      if (!row) { res.status(404).json({ error: 'not-hidden', detail: 'That isn’t hidden any more.' }); return; }
      const note = notReachedNote(await spread([row]));
      res.json({ ok: true, note, ...page(answer(raw)) });
    } catch (err) {
      report('POST /mobile/health-issues/choices/undo', err);
      res.status(500).json({ error: 'choice-not-saved', detail: 'I couldn’t save that, so it’s still hidden. Try again.' });
    }
  });

  // ── This agent's other machines ──

  router.get('/mobile/health-issues/choices', (req: Request, res: Response) => {
    if (!machine(req, res)) return;
    res.json({ rows: deps.choices?.rows() ?? [] });
  });

  router.post('/mobile/health-issues/choices/merge', (req: Request, res: Response) => {
    if (!machine(req, res)) return;
    if (!deps.choices) { off(res); return; }
    res.json({ ok: true, changed: deps.choices.merge((req.body as Record<string, unknown> | undefined)?.rows) });
  });

  // Catches up a machine that was offline, and notices what stopped or came back while nobody was looking.
  if (deps.choices && deps.peers) {
    const store = deps.choices;
    const peers = deps.peers;
    setInterval(() => {
      void (async () => {
        // One machine at a time, so a long list from one can't crowd out another.
        if (peers.list().length > 0) for (const rows of await peers.pull()) store.merge(rows);
        if (store.hasRows()) answer(await read());
      })().catch((err) => report('the hidden-problem check', err));
    }, HEALTH_CHOICES_TICK_MS).unref();
  }
}
