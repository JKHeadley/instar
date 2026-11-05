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
  const sub = d.verdict === 'attention' ? (problems.length === 1 ? problems[0].detail : '')
    : d.verdict === 'unsure' ? 'It may not affect you. Each one has a way to ask me.'
      : d.verdict === 'running' ? 'Nothing here affects you.' : '';
  return {
    ok: true, verdict: d.verdict, tone: TONE[d.verdict], headline: d.headline, sub, uptime: d.uptime || null,
    problems, unsorted, quiet, truncated: Boolean(d.truncated),
  };
}

/** Home's rows: only what affects the person. Internal items never raise the count. */
export function healthNeedRows(res) {
  const d = readableIssues(res);
  if (!d) return null;
  return d.issues.filter((i) => i && i.impact === 'user-affecting').map((i) => ({ key: i.id, title: i.title, detail: i.detail, href: issueHref(i) }));
}

/** "3 times", or nothing for one. */
export function timesWord(n) { return Number(n) > 1 ? `${n} times in the last half hour` : ''; }
