// Health page and Home's health rows (docs/specs/mobile-health-issues.md). Pure: it reads nothing itself.
// The answer comes from GET /mobile/health-issues, the same one the phone reads, so the two surfaces say
// the same thing. Every problem carries a next step: a page when there is one, and always the question
// to ask the agent.

export const HEALTH_PAGE = '#/capacity/health';

/** Opens the Sessions page with the question ready in the message box. */
export function askHref(issue) {
  return `#/work/sessions?ask=${encodeURIComponent(String((issue && issue.ask) || ''))}`;
}

export function issueHref(issue) {
  return `${HEALTH_PAGE}?s=${encodeURIComponent(String((issue && issue.id) || ''))}`;
}

const KNOWN_VERDICTS = new Set(['healthy', 'running', 'unsure', 'attention']);
const TONE = { healthy: 'ok', running: 'ok', unsure: 'muted', attention: 'attn' };

/** A readable answer, or null: a 200 of the wrong shape tells us nothing and must never read as healthy. */
export function readableIssues(res) {
  const d = res && res.ok ? res.data : null;
  return d && KNOWN_VERDICTS.has(d.verdict) && Array.isArray(d.issues) ? d : null;
}

export function buildHealthPage(res) {
  if (!res || !res.ok) return { ok: false, reason: `Couldn't read my health: ${(res && res.reason) || 'no answer'}.` };
  const d = readableIssues(res);
  if (!d) return { ok: false, reason: 'The health answer had the wrong shape, so I can’t say how I’m doing.' };
  const of = (impact) => d.issues.filter((i) => i && i.impact === impact);
  const problems = of('user-affecting');
  const unsorted = of('unclassified');
  const quiet = of('internal');
  const sub = d.verdict === 'unsure' ? 'It may not affect you. Each one has a way to ask me.'
      : d.verdict === 'running' ? 'Nothing here affects you.' : '';
  return {
    ok: true, verdict: d.verdict, tone: TONE[d.verdict], headline: d.headline, sub, uptime: d.uptime || null,
    problems, unsorted, quiet, truncated: Boolean(d.truncated),
    hidden: Array.isArray(d.hidden) ? d.hidden.filter((h) => h && typeof h.key === 'string') : [],
    hiddenUnreadable: d.hiddenUnreadable === true,
  };
}

// ── Quick actions (docs/specs/health-quick-actions.md) ──

export const SNOOZE_CHOICES = [{ hours: 1, label: '1 hour' }, { hours: 24, label: '1 day' }, { hours: 168, label: '1 week' }];

/** What this answer lets the person do. An older agent sends no `choices`, so no button shows. */
export function issueChoices(issue) {
  // `keys` is what binds a choice to what's on screen. No keys, no buttons.
  const c = issue && Array.isArray(issue.choices) && Array.isArray(issue.keys) && issue.keys.length > 0 ? issue.choices : [];
  return { snooze: c.includes('snooze'), hide: c.includes('hide'), ignore: c.includes('ignore') && typeof issue.ignoreSays === 'string' && issue.ignoreSays.length > 0 };
}

/** The server's reason for a refused choice, in the person's words. */
export function choiceFailure(reason) {
  const words = {
    'issue-gone': 'This has stopped happening, so there’s nothing to hide.',
    'not-hidden': 'That isn’t hidden any more.',
    'choice-not-offered': 'That choice isn’t available for this one.',
    'choice-not-saved': 'I couldn’t save that, so nothing changed. Try again.',
    'choices-unavailable': 'This agent can’t save that right now.',
  };
  return words[reason] || 'That didn’t work, so nothing changed. Try again.';
}

/** "Comes back in 3 hours": rounded up, so it never says less time than is left. */
export function comesBackWords(until, now = Date.now()) {
  const t = Date.parse(String(until));
  if (Number.isNaN(t)) return '';
  const minutes = Math.max(1, Math.ceil((t - now) / 60000));
  if (minutes < 60) return `Comes back in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `Comes back in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `Comes back in ${Math.ceil(hours / 24)} days`;
}

/** The words on one row of the Hidden list. */
export function hiddenRowWords(row, now = Date.now()) {
  const kind = row.mode === 'snooze' ? comesBackWords(row.until, now) : row.mode === 'hide' ? 'Hidden from you' : 'Ignored';
  const by = row.by === 'phone' ? 'Hidden from your phone' : row.by === 'another-machine' ? 'Hidden on another of this agent’s machines' : 'Hidden from the dashboard, or by the agent';
  return { kind, line: String(row.line || ''), by };
}

export function hiddenAskHref(row) {
  return askHref({ ask: `You have this hidden on your health page: "${row.title}" (reference: ${row.key}). Is it still happening, and should I bring it back?` });
}

/** "On Mac Studio": the machine this problem is on, or nothing when the agent didn't name one. */
export function machineWords(issue) {
  const name = issue && issue.machine && typeof issue.machine.name === 'string' ? issue.machine.name.trim() : '';
  return name ? `On ${name}` : '';
}

/** Home's rows: only what affects the person. Internal items never raise the count. */
export function healthNeedRows(res) {
  const d = readableIssues(res);
  if (!d) return null;
  return d.issues.filter((i) => i && i.impact === 'user-affecting').map((i) => ({ key: i.id, title: i.title, detail: [machineWords(i), i.detail].filter(Boolean).join(' · '), href: issueHref(i) }));
}

/** "3 times", or nothing for one. */
export function timesWord(n) { return Number(n) > 1 ? `${n} times in the last half hour` : ''; }
