/**
 * What a degraded /health answer means for the person (docs/specs/mobile-health-issues.md).
 *
 * /health says "degraded" if any one thing is off, and it must keep saying so: scripts, peers and the
 * lifeline read that word. Most of what sets it is internal and already handled. This module sorts each
 * reason into one of three impacts from a declared table, so the app and the console can say "Degraded"
 * only when the person is affected and give every problem a next step.
 *
 * Signal only: nothing here gates, alerts or changes /health. The table matches stable ids (a degradation's
 * `feature`, an LLM component), never message text.
 *
 * A row is only as true as the id it names: one id must mean one thing. Before adding a row, read every
 * report() of that id. A family (`*`) is for ids that all mean the same; `GitSync.*`, for example, would
 * also cover conflicts that need a person, so only the reviewed members are listed.
 *
 * The safe default: an id the table does not name is `unclassified`. It shows in the details, and the
 * verdict is `unsure`, which never reads as healthy. Adding a row needs an `action`: a place to go, or an
 * explicit null, in which case asking the agent is the path.
 */
import { scrubSecrets } from './scrubSecrets.js';

export type HealthImpact = 'user-affecting' | 'internal' | 'unclassified';
export type HealthVerdict = 'healthy' | 'running' | 'unsure' | 'attention';

/** Screens the phone can open by name. The app maps each to a native view; an unknown name shows no button. */
export const HEALTH_APP_SCREENS = ['accounts', 'schedule', 'sessions', 'machines', 'agents', 'desktop'] as const;
export type HealthAppScreen = typeof HEALTH_APP_SCREENS[number];

export interface HealthAction {
  label: string;
  /** The native screen, by name. */
  app: HealthAppScreen;
  /** The console page: a route, or a page of its own under /dashboard. */
  console: `#/${string}` | `/dashboard/${string}`;
}

export interface HealthRule {
  /** The id this rule covers. A key ending in `*` covers every id that starts with what comes before it. */
  key: string;
  impact: Exclude<HealthImpact, 'unclassified'>;
  title: string;
  detail: string;
  /** Required: where the person can act, or null when the only step is asking the agent. */
  action: HealthAction | null;
}

export interface HealthIssue {
  /** Stable across reads: the rule's key, or the id itself when no rule names it. */
  id: string;
  impact: HealthImpact;
  title: string;
  detail: string;
  /** The agent's own latest words about it, when it left any. */
  evidence: string | null;
  count: number;
  lastAt: string | null;
  action: HealthAction | null;
  /** The message "Ask the agent about this" starts from. */
  ask: string;
}

export interface HealthIssuesSummary {
  verdict: HealthVerdict;
  headline: string;
  uptime: string | null;
  counts: { userAffecting: number; internal: number; unclassified: number };
  issues: HealthIssue[];
  truncated: boolean;
}

export const MAX_HEALTH_ISSUES = 40;
export const EVIDENCE_MAX = 300;
const SCRUB_MARGIN = 2048;
/** A narrative can name a file; the owner's screen has no use for where it is. */
const LOCAL_PATH = /(?:~|\/(?:Users|home|private|tmp|var|opt|etc))\/[^\s'"`)]+/g;

const ACCOUNTS: HealthAction = { label: 'Open Accounts', app: 'accounts', console: '#/capacity/accounts' };
const SCHEDULE: HealthAction = { label: 'Open Schedule', app: 'schedule', console: '#/work/schedule' };
const SESSIONS: HealthAction = { label: 'Open Sessions', app: 'sessions', console: '#/work/sessions' };
const MACHINES: HealthAction = { label: 'Open Machines', app: 'machines', console: '#/capacity/machines' };
const DESKTOP: HealthAction = { label: 'Open Remote Desktop', app: 'desktop', console: '/dashboard/desktop.html' };
const AGENTS: HealthAction = { label: 'Open Other agents', app: 'agents', console: '#/people/agents' };

/**
 * The declared table. Exact ids come before families in spirit, and in matching: an exact key always beats
 * a `*` family, and a longer family beats a shorter one, so one risky member can be pulled out of a family.
 */
export const HEALTH_RULES: readonly HealthRule[] = [
  // ── Affects the person ──
  { key: 'iMessage', impact: 'user-affecting', title: 'iMessage isn’t connected', detail: 'Messages sent to me through iMessage won’t reach me until this is fixed. Other ways of reaching me still work. To fix it, someone at this Mac allows my program in System Settings, under Privacy & Security, then Full Disk Access, and then I restart. If you don’t use iMessage, ask me to turn it off.', action: DESKTOP },
  { key: 'WhatsApp', impact: 'user-affecting', title: 'WhatsApp isn’t connected', detail: 'Messages sent to me through WhatsApp won’t reach me until this is fixed. Other ways of reaching me still work.', action: null },
  { key: 'Slack', impact: 'user-affecting', title: 'Slack isn’t connected', detail: 'Messages sent to me through Slack won’t reach me until this is fixed. Other ways of reaching me still work.', action: null },
  { key: 'Telegram.Lifeline', impact: 'user-affecting', title: 'My Telegram connection is struggling', detail: 'Messages through Telegram may be slow or missing until it recovers.', action: null },
  { key: 'TelegramLifeline.restartStorm', impact: 'user-affecting', title: 'My Telegram connection keeps restarting', detail: 'Messages through Telegram may be slow or missing until it settles.', action: null },
  { key: 'InboundQueue.drain', impact: 'user-affecting', title: 'Messages to me may be delayed', detail: 'Incoming messages are waiting longer than they should to reach a session.', action: SESSIONS },
  { key: 'SessionManager.verifyInjection.unsubmitted', impact: 'user-affecting', title: 'A message didn’t reach a session', detail: 'It is still waiting at the session’s prompt. A background check keeps trying to send it.', action: SESSIONS },
  { key: 'SessionManager.monitorTick.interactiveLoginExpired', impact: 'user-affecting', title: 'A sign-in ran out', detail: 'A session stopped because its account needs signing in again.', action: ACCOUNTS },
  { key: 'SessionManager.monitorTick.reroutedLoginExpired', impact: 'user-affecting', title: 'A sign-in ran out', detail: 'A session stopped because its account needs signing in again.', action: ACCOUNTS },
  { key: 'health:claude-key', impact: 'user-affecting', title: 'The Claude key stopped working', detail: 'Work that depends on it can’t run while it’s failing.', action: ACCOUNTS },
  { key: 'health:sessions-full', impact: 'user-affecting', title: 'All session slots are in use', detail: 'New work has to wait until a session finishes.', action: SESSIONS },
  { key: 'health:job-failures', impact: 'user-affecting', title: 'Scheduled jobs keep failing', detail: 'Work that should run on its own is not getting done.', action: SCHEDULE },
  { key: 'health:whatsapp', impact: 'user-affecting', title: 'WhatsApp isn’t connected', detail: 'Messages sent to me through WhatsApp won’t reach me until this is fixed.', action: null },

  // ── Internal: handled, or no effect on the person ──
  { key: 'SessionManager.verifyInjection', impact: 'internal', title: 'I pressed Enter for a stuck message', detail: 'A session didn’t pick up its input, so I pressed Enter for it. If that doesn’t work, this turns into a problem you can see.', action: null },
  { key: 'GitSync.gitHygiene', impact: 'internal', title: 'Some files were kept out of sync on purpose', detail: 'Files that belong on this machine only were left out of sync. Nothing failed.', action: null },
  { key: 'health:llm:jev-load-assessment', impact: 'internal', title: 'A background self-check is failing often', detail: 'It’s a second opinion on how busy this machine is. The basic reading still works.', action: null },
  { key: 'TelegramLifeline.versionSkewInfo', impact: 'internal', title: 'My message relay is out of step with the server', detail: 'It restarts itself at the next quiet moment.', action: null },
  { key: 'telegram-session-lifecycle-notice', impact: 'internal', title: 'A status note about a session may not have sent', detail: 'I won’t send a replacement.', action: null },
  { key: 'unjustifiedStopGate.*', impact: 'internal', title: 'A self-check on my stopping had a problem', detail: 'The check that reviews whether a session stopped too early didn’t finish cleanly, so stops may not be reviewed for now.', action: null },
  { key: 'rope-health', impact: 'internal', title: 'Coordination between machines hit a snag', detail: 'A connection between machines needed a retry.', action: MACHINES },
  { key: 'rope-recovery-probe', impact: 'internal', title: 'Coordination between machines hit a snag', detail: 'A connection between machines needed a retry.', action: MACHINES },
  { key: 'local-verify-status-floor', impact: 'internal', title: 'A merge check is waiting', detail: 'Pull requests wait until the local test run can vouch for them again. This only touches development work.', action: null },
];

const exactRules = new Map(HEALTH_RULES.filter((r) => !r.key.endsWith('*')).map((r) => [r.key, r]));
const familyRules = HEALTH_RULES.filter((r) => r.key.endsWith('*'))
  .map((r) => ({ prefix: r.key.slice(0, -1), rule: r }))
  .sort((a, b) => b.prefix.length - a.prefix.length);

export function ruleFor(id: string): HealthRule | null {
  return exactRules.get(id) ?? familyRules.find((f) => id.startsWith(f.prefix))?.rule ?? null;
}

/** One reason /health is not plainly ok. `id` is a degradation's feature, or a `health:` id for the other checks. */
export interface HealthSignal {
  id: string;
  /** A title written here, in plain words, for an id no rule names. Never a reporter's text. */
  plainTitle?: string;
  /** Replaces the rule's detail with the numbers of this occurrence. */
  detail?: string;
  evidence?: string | null;
  at?: string | null;
  internalOnly?: boolean;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Text for the owner: secrets scrubbed, whitespace folded, length capped. Cut first: scrubbing long text is slow. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const clean = scrubSecrets(v.slice(0, max + SCRUB_MARGIN)).replace(LOCAL_PATH, 'a file on this machine').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * The reasons in an authenticated /health answer other than its degradation list (`events`). Reading the
 * answer itself, rather than repeating its rules, means the two cannot drift: if /health says degraded and
 * none of these explains it, `summarizeHealth` still adds an unclassified row.
 */
export function signalsFromHealth(health: unknown): HealthSignal[] {
  const h = rec(health);
  const out: HealthSignal[] = [];
  const sessions = rec(h.sessions);
  const current = num(sessions.current);
  const max = num(sessions.max);
  if (current !== null && max !== null && current >= max) out.push({ id: 'health:sessions-full', detail: `All ${max} session slots are in use, so new work has to wait until one finishes.` });
  const failures = num(h.consecutiveJobFailures);
  if (failures !== null && failures >= 5) out.push({ id: 'health:job-failures', detail: `${failures} failures in a row across scheduled jobs, so work that should run on its own is not getting done.` });
  if (rec(h.claudeKey).status === 'dead') out.push({ id: 'health:claude-key' });
  if (rec(h.whatsapp).state === 'disconnected') out.push({ id: 'health:whatsapp' });
  const review = rec(rec(h.systemReview).lastReview);
  if (review.status === 'critical') {
    const failed = num(review.failed);
    out.push({ id: 'health:system-review', plainTitle: 'My last self-review found a serious problem', detail: failed === null ? undefined : `${failed} of my self-checks failed.`, at: typeof review.timestamp === 'string' ? review.timestamp : null });
  }
  const reliability = rec(h.llmReliability);
  if (reliability.status === 'unavailable') out.push({ id: 'health:llm-unavailable', plainTitle: 'I can’t read how my background checks are doing' });
  else if (typeof reliability.status === 'string' && reliability.status !== 'ok') {
    for (const c of Array.isArray(reliability.components) ? reliability.components : []) {
      const row = rec(c);
      if (typeof row.feature !== 'string' || !row.feature) continue;
      const errors = num(row.errors);
      const calls = num(row.realCalls);
      out.push({ id: `health:llm:${row.feature}`, plainTitle: 'A background check is failing often', detail: errors !== null && calls !== null ? `${errors} of its last ${calls} calls failed in the past day.` : undefined });
    }
  }
  return out;
}

const askFor = (title: string, id: string): string =>
  `Your health page shows this problem: "${title}" (reference: ${id}). What happened, does it affect me, and what should we do about it?`;

/** What is true right now, for a channel whose failure is reported once and never again. */
export interface HealthCurrentState {
  /** down: switched on and not connected. up: connected. off: not switched on here. Undefined: not asked. */
  iMessage?: 'down' | 'up' | 'off';
}

const IMPACT_ORDER: Record<HealthImpact, number> = { 'user-affecting': 0, unclassified: 1, internal: 2 };

/**
 * The owner's answer. `events` are the recent degradations /health counted; `health` its authenticated
 * answer. Pure. Repeats of one rule collapse into one row with a count.
 */
export function summarizeHealth(
  health: unknown,
  events: ReadonlyArray<{ feature?: unknown; timestamp?: unknown; internalOnly?: unknown; narrative?: unknown }>,
  current: HealthCurrentState = {},
): HealthIssuesSummary {
  const h = rec(health);
  // iMessage fails once at startup and is never retried, so its event ages out of the window while it stays down.
  // The present state decides when it is known: down stays, up or off drops the old event.
  const known = current.iMessage !== undefined;
  const signals: HealthSignal[] = [
    ...events.filter((e) => !(known && e.feature === 'iMessage')).map((e): HealthSignal => {
      const named = typeof e.feature === 'string' && e.feature.length > 0;
      return {
        id: named ? (e.feature as string) : 'health:unnamed-event',
        evidence: typeof e.narrative === 'string' ? e.narrative : null,
        at: typeof e.timestamp === 'string' ? e.timestamp : null,
        internalOnly: e.internalOnly === true,
      };
    }),
    ...signalsFromHealth(health),
    ...(current.iMessage === 'down' ? [{ id: 'iMessage', evidence: events.find((e) => e.feature === 'iMessage')?.narrative as string | undefined ?? null, at: (events.find((e) => e.feature === 'iMessage')?.timestamp as string | undefined) ?? null }] : []),
  ];
  const groups = new Map<string, HealthIssue>();
  for (const s of signals) {
    const rule = ruleFor(s.id);
    const key = rule?.key ?? s.id;
    // A reporter's own `internalOnly` mark counts as a declaration. It can only quieten an unnamed id, never a row.
    const impact: HealthImpact = rule ? rule.impact : s.internalOnly ? 'internal' : 'unclassified';
    // A self-marked internal event's narrative is written for logs; only an unsorted one needs its own words as a title.
    // Never the reporter's own words as a title: they can hold setting names and session ids. They stay in `evidence`.
    const title = rule?.title ?? (impact === 'internal' ? 'A background step used its backup' : s.plainTitle) ?? 'Something inside me used a backup path';
    const seen = groups.get(key);
    const evidence = text(s.evidence, EVIDENCE_MAX);
    if (seen) {
      seen.count += 1;
      if (s.at && (!seen.lastAt || s.at > seen.lastAt)) {
        seen.lastAt = s.at;
        seen.evidence = evidence ?? seen.evidence;
      }
      continue;
    }
    groups.set(key, {
      id: key,
      impact,
      title,
      detail: text(s.detail, EVIDENCE_MAX) ?? rule?.detail ?? (impact === 'internal'
        ? 'This is internal and doesn’t need you.'
        : 'I haven’t sorted this one yet, so I can’t say whether it affects you. Ask me and I’ll look into it.'),
      evidence,
      count: 1,
      lastAt: s.at ?? null,
      action: rule?.action ?? null,
      ask: askFor(title, s.id),
    });
  }
  // /health says something is wrong and nothing above explains it: say so, never read as healthy.
  // Not when the only reason was an iMessage event the present state just cleared.
  const cleared = known && current.iMessage !== 'down' && events.some((e) => e.feature === 'iMessage');
  if (h.status !== 'ok' && h.status !== 'healthy' && groups.size === 0 && !cleared) {
    const title = 'The agent reports a problem I can’t name';
    groups.set('health:unnamed', { id: 'health:unnamed', impact: 'unclassified', title, detail: 'The health check says something is off but didn’t say what. Ask me and I’ll look into it.', evidence: null, count: 1, lastAt: null, action: null, ask: askFor(title, 'health:unnamed') });
  }
  const all = [...groups.values()].sort((a, b) => IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact] || (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.id.localeCompare(b.id));
  const counts = {
    userAffecting: all.filter((i) => i.impact === 'user-affecting').length,
    internal: all.filter((i) => i.impact === 'internal').length,
    unclassified: all.filter((i) => i.impact === 'unclassified').length,
  };
  const verdict: HealthVerdict = counts.userAffecting > 0 ? 'attention' : counts.unclassified > 0 ? 'unsure' : counts.internal > 0 ? 'running' : 'healthy';
  const headline = verdict === 'attention'
    ? (counts.userAffecting === 1 ? all[0].title + '.' : `${counts.userAffecting} problems are affecting you.`)
    : verdict === 'unsure'
      ? (counts.unclassified === 1 ? 'Running, with one thing I haven’t sorted yet.' : `Running, with ${counts.unclassified} things I haven’t sorted yet.`)
      : verdict === 'running' ? 'Running normally.' : 'Healthy.';
  return {
    verdict,
    headline,
    uptime: typeof h.uptimeHuman === 'string' ? h.uptimeHuman : null,
    counts,
    issues: all.slice(0, MAX_HEALTH_ISSUES),
    truncated: all.length > MAX_HEALTH_ISSUES,
  };
}

/** A console or app rule must stay inside this list; tests hold the table to it. */
export function isDeclaredAction(a: HealthAction | null): boolean {
  return a === null || ((HEALTH_APP_SCREENS as readonly string[]).includes(a.app) && (a.console.startsWith('#/') || a.console.startsWith('/dashboard/')) && a.label.length > 0);
}
