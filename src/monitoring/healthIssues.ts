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
 * The safe default: an id the table does not name is `unclassified`. It shows as a note, and the verdict is
 * `running`, never `healthy`. (It used to be `unsure`, which made a healthy, answering agent read "Can't tell";
 * Justin, 2026-11-07. `unsure` now means only that the agent could not read its own health.) Adding a row needs an `action`: a place to go, or an
 * explicit null, in which case asking the agent is the path.
 */
import { scrubSecrets } from './scrubSecrets.js';
import { offerFor, type HealthChoiceMode, type HealthHiddenRow } from './healthChoices.js';

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
  /** The exact ids behind this row. A choice binds to these, never to a family. */
  keys: string[];
  /** What the person can do about it (docs/specs/health-quick-actions.md). Empty when nothing is offered. */
  choices: HealthChoiceMode[];
  /** The one sentence Ignore's confirmation shows. */
  ignoreSays: string | null;
  /** Why a choice isn't offered. */
  choiceNote: string | null;
  /** Said when it's showing again after being hidden for a while. */
  returnNote: string | null;
}

/** The person's choices, as a read needs them. HealthChoiceStore is the real one. */
export interface HealthChoiceView {
  hidesNow(key: string): boolean;
  returnNote(key: string): string | null;
  hiddenRows(present: ReadonlySet<string>): HealthHiddenRow[];
  observe(present: ReadonlySet<string>): void;
}

export interface HealthIssuesSummary {
  verdict: HealthVerdict;
  headline: string;
  uptime: string | null;
  counts: { userAffecting: number; internal: number; unclassified: number };
  issues: HealthIssue[];
  truncated: boolean;
  /** What the person hid. Never counted above. */
  hidden: HealthHiddenRow[];
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

// ── Plain names for rows no rule names (the owner's screen, 2026-11-06) ──
// Two different unsorted problems both read "Something inside me used a backup path", and their own words
// showed internals ("verifyInjection", "sentinel", "tick"). Every row the table doesn't name now gets a title
// of its own: a known subsystem's plain name first, then the reporter's own impact line when it is already
// plain words, then the subsystem named in plain words. Deterministic; no model call.

/** Known subsystems by id prefix (case-insensitive, longest first): a plain title and, where its own words are internal, plain words. */
export const SUBSYSTEM_NAMES: ReadonlyArray<{ prefix: string; title: string; words?: string }> = [
  { prefix: 'StuckInputSentinel', title: 'I pressed Enter for a stuck session', words: 'A message sat unsent at a session’s prompt, so I pressed Enter for it. I check a moment later whether it went through.' },
  { prefix: 'SessionManager.verifyInjection', title: 'I pressed Enter for a stuck message' },
  { prefix: 'SessionManager.spawn', title: 'A background job waited for a free session', words: 'All session slots were busy, so a background job waited its turn. It tries again on its own.' },
  { prefix: 'SessionManager', title: 'Session handling used a backup path' },
  { prefix: 'feedback-execute', title: 'Feedback fixes are waiting' },
  { prefix: 'feedback-triage', title: 'Sorting new feedback used a backup path' },
  { prefix: 'FeedbackFactory', title: 'Feedback handling used a backup path' },
  { prefix: 'GitSync', title: 'Background sync used a backup path' },
  { prefix: 'Threadline', title: 'Messaging with other agents used a backup path' },
  { prefix: 'JobScheduler', title: 'The job scheduler used a backup path' },
  { prefix: 'TelegramLifeline', title: 'My Telegram relay used a backup path' },
  { prefix: 'TelegramAdapter', title: 'My Telegram connection used a backup path' },
  { prefix: 'telegram-origin', title: 'Telling who sent a Telegram message used a backup path' },
  { prefix: 'Telegram', title: 'My Telegram connection used a backup path' },
  { prefix: 'RecommendedServices', title: 'Recommended services used a backup path' },
  { prefix: 'unjustifiedStopGate', title: 'A self-check on my stopping had a problem' },
  { prefix: 'TopicMemory', title: 'Conversation memory used a backup path' },
  { prefix: 'StateManager', title: 'Saving my state used a backup path' },
  { prefix: 'SessionMigrator', title: 'Moving a session used a backup path' },
  { prefix: 'QuotaManager', title: 'Usage-limit tracking used a backup path' },
  { prefix: 'OutboundDedupStore', title: 'Duplicate-message checking used a backup path' },
  { prefix: 'SecretStore', title: 'My secret storage used a backup path' },
  { prefix: 'MultiMachine', title: 'Working across my machines used a backup path' },
  { prefix: 'HandoffManager', title: 'Handing work between sessions used a backup path' },
  { prefix: 'DesktopLocked', title: 'Remote Desktop’s locked-screen access used a backup path' },
  { prefix: 'CartographerSweep', title: 'My code map used a backup path' },
  { prefix: 'CapabilityRegistry', title: 'Tracking what each machine can do used a backup path' },
  { prefix: 'promiseReview', title: 'Reviewing my promises used a backup path' },
  { prefix: 'commitments', title: 'Tracking my promises used a backup path' },
  { prefix: 'sessionPool', title: 'Sharing sessions across machines used a backup path' },
  { prefix: 'lease', title: 'Deciding which machine leads used a backup path' },
  { prefix: 'MobileHealthIssues', title: 'Reading my own health used a backup path' },
  { prefix: 'MobileOwnerPresence', title: 'Face ID sign-in from the app used a backup path' },
].slice().sort((a, b) => b.prefix.length - a.prefix.length);

/** Internal words the owner's screen never shows (they mean nothing outside the code). */
const JARGON_WORDS = /\b(sentinel|tick|ticks|verifyInjection|mutex|reaper|shard|payload|enum|null|undefined|regex|stdout|stderr|pid|tmux|sqlite|json|jsonl|cas|lease|rope|spawn(?:ed)?|refused|caller|in-process|repo)\b/i;
/** A code-shaped token: camelCase, dotted or snake_case ids, key:value ids, backticks, braces, all-caps flags. */
const CODE_TOKEN = /([a-z][A-Z])|\b\w+[._:/]\w+\b|`|[{}<>[\]=]|\b[A-Z]{3,}\b|\b[a-z]+_[a-z]+\b|\d{4,}/;

/** True when `t` is plain words a person can read: no code tokens, no internal words. */
export function isPlainWords(t: string): boolean {
  return !CODE_TOKEN.test(t) && !JARGON_WORDS.test(t);
}

function subsystemOf(id: string): { known: (typeof SUBSYSTEM_NAMES)[number] | null; words: string } {
  const lower = id.toLowerCase();
  const known = SUBSYSTEM_NAMES.find((n) => lower.startsWith(n.prefix.toLowerCase())) ?? null;
  const head = id.split(/[.:]/)[0] ?? id;
  const words = head
    .replace(/^health$/i, 'health check')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\bsentinel\b/gi, 'watcher')
    .toLowerCase()
    .trim();
  return { known, words: words || 'part' };
}

/** The reporter's own impact line as a title, only when it is short plain words; otherwise null. */
function titleFromImpact(impact: unknown): string | null {
  if (typeof impact !== 'string') return null;
  const first = impact.split(/[;.]/)[0]?.trim() ?? '';
  const n = first.split(/\s+/).filter(Boolean).length;
  if (n < 2 || n > 8 || first.length > 60 || !/^[A-Za-z][A-Za-z ,'’-]*$/.test(first) || !isPlainWords(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** The title for a row no rule names. */
export function plainTitleFor(id: string, impact: unknown, internal: boolean): string {
  const { known, words } = subsystemOf(id);
  if (known) return known.title;
  const fromImpact = titleFromImpact(impact);
  if (fromImpact) return fromImpact;
  return internal ? `A background step in my ${words} used its backup` : `Something in my ${words} used a backup path`;
}

/**
 * "In the agent's words", in plain words or not at all. A known subsystem's own plain words replace internal ones.
 * Otherwise the reporter's "Using … in the meantime — everything else is working fine." tail is dropped, and the
 * rest is kept only when it reads as plain words.
 */
export function plainEvidence(id: string, narrative: string | null): string | null {
  const { known } = subsystemOf(id);
  if (known?.words) return known.words;
  if (!narrative) return null;
  const kept = narrative.replace(/\s*Using [^]*? in the meantime\s*[—-]\s*everything else is working fine\.?/i, '').trim();
  if (!kept || !isPlainWords(kept)) return null;
  return kept;
}

/** One reason /health is not plainly ok. `id` is a degradation's feature, or a `health:` id for the other checks. */
export interface HealthSignal {
  id: string;
  /** A title written here, in plain words, for an id no rule names. Never a reporter's text. */
  plainTitle?: string;
  /** Replaces the rule's detail with the numbers of this occurrence. */
  detail?: string;
  evidence?: string | null;
  /** The reporter's own one-line impact, for a title when it is already plain words. */
  impactWords?: string | null;
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
  events: ReadonlyArray<{ feature?: unknown; timestamp?: unknown; internalOnly?: unknown; narrative?: unknown; impact?: unknown }>,
  current: HealthCurrentState = {},
  choices?: HealthChoiceView,
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
        impactWords: typeof e.impact === 'string' ? e.impact : null,
        at: typeof e.timestamp === 'string' ? e.timestamp : null,
        internalOnly: e.internalOnly === true,
      };
    }),
    ...signalsFromHealth(health),
    ...(current.iMessage === 'down' ? [{ id: 'iMessage', evidence: events.find((e) => e.feature === 'iMessage')?.narrative as string | undefined ?? null, at: (events.find((e) => e.feature === 'iMessage')?.timestamp as string | undefined) ?? null }] : []),
  ];
  // What's happening now, hidden or not: the choices note what stopped and what came back.
  const present = new Set(signals.map((s) => s.id));
  choices?.observe(present);
  const hidden = choices?.hiddenRows(present) ?? [];
  const groups = new Map<string, HealthIssue>();
  let hidNow = false;
  for (const s of signals) {
    // By exact id: a different problem in the same family still shows.
    if (choices?.hidesNow(s.id)) { hidNow = true; continue; }
    const rule = ruleFor(s.id);
    const key = rule?.key ?? s.id;
    // A reporter's own `internalOnly` mark counts as a declaration. It can only quieten an unnamed id, never a row.
    const impact: HealthImpact = rule ? rule.impact : s.internalOnly ? 'internal' : 'unclassified';
    // A self-marked internal event's narrative is written for logs; only an unsorted one needs its own words as a title.
    // Never the reporter's own words as a title: they can hold setting names and session ids. They stay in `evidence`.
    // Its own plain title: a rule's, a title written here, or one made from the subsystem (never a shared catch-all).
    const title = rule?.title ?? s.plainTitle ?? plainTitleFor(s.id, s.impactWords, impact === 'internal');
    const seen = groups.get(key);
    // A rule's row shows its reporter's words as they are; a row no rule names shows them only in plain words.
    // Scrubbed first (secrets, local paths), then judged as plain words.
    const evidence = rule ? text(s.evidence, EVIDENCE_MAX) : text(plainEvidence(s.id, text(s.evidence, EVIDENCE_MAX * 4)), EVIDENCE_MAX);
    if (seen) {
      seen.count += 1;
      if (!seen.keys.includes(s.id)) seen.keys.push(s.id);
      seen.returnNote = seen.returnNote ?? choices?.returnNote(s.id) ?? null;
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
      keys: [s.id],
      choices: [],
      ignoreSays: null,
      choiceNote: null,
      returnNote: choices?.returnNote(s.id) ?? null,
    });
  }
  // /health says something is wrong and nothing above explains it: say so, never read as healthy.
  // Not when the only reason was an iMessage event the present state just cleared.
  const cleared = known && current.iMessage !== 'down' && events.some((e) => e.feature === 'iMessage');
  if (h.status !== 'ok' && h.status !== 'healthy' && groups.size === 0 && !cleared && !hidNow) {
    const title = 'The agent reports a problem I can’t name';
    groups.set('health:unnamed', { id: 'health:unnamed', impact: 'unclassified', title, detail: 'The health check says something is off but didn’t say what. Ask me and I’ll look into it.', evidence: null, count: 1, lastAt: null, action: null, ask: askFor(title, 'health:unnamed'), keys: ['health:unnamed'], choices: [], ignoreSays: null, choiceNote: null, returnNote: null });
  }
  // No two different rows share a title: a later unnamed row with a taken title names its own part, then a number.
  const taken = new Set<string>();
  for (const g of groups.values()) if (ruleFor(g.id)) taken.add(g.title);
  for (const g of groups.values()) {
    if (ruleFor(g.id)) continue;
    if (taken.has(g.title)) {
      const second = (g.id.split(/[.:]/)[1] ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase().trim();
      let next = second && isPlainWords(second) ? `${g.title} (${second})` : g.title;
      for (let n = 2; taken.has(next); n++) next = `${g.title} (${n})`;
      g.title = next;
      g.ask = askFor(g.title, g.keys[0] ?? g.id);
    }
    taken.add(g.title);
  }
  for (const g of groups.values()) Object.assign(g, offerFor(g.keys, g.impact === 'unclassified'));
  const all = [...groups.values()].sort((a, b) => IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact] || (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.id.localeCompare(b.id));
  const counts = {
    userAffecting: all.filter((i) => i.impact === 'user-affecting').length,
    internal: all.filter((i) => i.impact === 'internal').length,
    unclassified: all.filter((i) => i.impact === 'unclassified').length,
  };
  // A hidden problem that's happening, or one nobody is tracking, is never "healthy". It doesn't raise anything either.
  const unseen = hidden.filter((r) => r.happening !== false).length;
  // Answering and running decides the dot; only what affects the person raises it. Unsorted items are notes:
  // they keep it off "healthy" but never make an answering agent "unsure" (that is for a reading that failed).
  // The agent's own /health answer couldn't be read: the one case where it truly can't tell.
  const unreadable = !health || typeof health !== 'object';
  const verdict: HealthVerdict = counts.userAffecting > 0 ? 'attention' : unreadable ? 'unsure' : counts.unclassified > 0 || counts.internal > 0 || unseen > 0 ? 'running' : 'healthy';
  const headline = verdict === 'unsure' ? 'I couldn’t read my own health just now.' : verdict === 'attention'
    ? (counts.userAffecting === 1 ? all[0].title + '.' : `${counts.userAffecting} problems are affecting you.`)
    : verdict === 'running'
      ? (counts.unclassified > 0
        ? (counts.unclassified === 1 ? 'Running, with one note I haven’t sorted yet.' : `Running, with ${counts.unclassified} notes I haven’t sorted yet.`)
        : unseen === 0 ? 'Running normally.' : unseen === 1 ? 'Running, with one thing you’ve hidden.' : `Running, with ${unseen} things you’ve hidden.`)
      : 'Healthy.';
  return {
    verdict,
    headline,
    uptime: typeof h.uptimeHuman === 'string' ? h.uptimeHuman : null,
    counts,
    issues: all.slice(0, MAX_HEALTH_ISSUES),
    truncated: all.length > MAX_HEALTH_ISSUES,
    hidden,
  };
}

/** A console or app rule must stay inside this list; tests hold the table to it. */
export function isDeclaredAction(a: HealthAction | null): boolean {
  return a === null || ((HEALTH_APP_SCREENS as readonly string[]).includes(a.app) && (a.console.startsWith('#/') || a.console.startsWith('/dashboard/')) && a.label.length > 0);
}
