// What thinking costs — pure view-model (docs/specs/console-features/capacity.md:
// "What thinking costs", "Background checks", "Your conversations", "Which model
// does what"). Merges the legacy Spend, Tokens, LLM activity and Routing map tabs
// into one read-only page: recorded AI cost on THIS machine.
//
// Every decision lives here so it can be unit-tested; costs.js only renders.
// The honesty rules this file enforces:
//   - a cost row keeps the cost basis the server gave it (estimated / provider-
//     reported / subscription / unpriced); unpriced tokens are counted, not hidden;
//   - the committed figure a limit enforces (/routing-spend/caps) is shown apart
//     from the reporting figure (/routing-spend/summary), never merged;
//   - Claude's window usage and Codex's lifetime-of-active-sessions usage are two
//     labelled lines and are NEVER added together (TokenLedger.summary sums events
//     inside the window; codexSummary sums each active session's lifetime total);
//   - a check has calls and tokens but no dollars (feature rows carry no route);
//   - a 503 is "switched off on this agent"; any other failure is "Can't tell" + why.

import { ago } from './home-model.js';

export const WINDOWS = {
  today: { label: 'Today', hours: 24, phrase: 'today' },
  week: { label: '7 days', hours: 168, phrase: 'this week' },
  month: { label: '30 days', hours: 720, phrase: 'in the last 30 days' },
};
export const DEFAULT_WINDOW = 'week';

/** The legacy grain choices, kept under "More detail". Maps to the route's `grain`. */
export const GRAINS = [
  { key: 'day', label: 'By day' },
  { key: 'hour', label: 'By hour (last 24 h)' },
  { key: 'month', label: 'By month (all retained)' },
  { key: 'total', label: 'All time (all retained)' },
];

/** The time control's query parameters. `since` for the token routes, `sinceHours` for the ledger routes. */
export function windowParams(key, now = Date.now()) {
  const w = WINDOWS[key] || WINDOWS[DEFAULT_WINDOW];
  return { key: WINDOWS[key] ? key : DEFAULT_WINDOW, label: w.label, phrase: w.phrase, sinceHours: w.hours, sinceMs: now - w.hours * 3600000 };
}

/**
 * The spend query for a grain. The route reads `sinceHours` only for the hour and day
 * grains (hour: raw rows, day: ceil(sinceHours/24) days); month and total re-bucket
 * every retained daily bucket, so no window is sent and the label says so.
 */
export function spendQuery(grain, sinceHours) {
  if (grain === 'hour') return `grain=hour&sinceHours=24`;
  if (grain === 'month' || grain === 'total') return `grain=${grain}`;
  return `grain=day&sinceHours=${sinceHours}`;
}

const off = (res) => Boolean(res && !res.ok && /switched off/.test(res.reason || ''));

// ── words ──────────────────────────────────────────────────────────────────
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
  return v.toLocaleString('en-US');
}
export function fmtUsd(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0';
  if (v < 0.01) return 'under $0.01';
  return `$${v.toFixed(2)}`;
}
const DOOR_WORDS = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex', 'gemini-cli': 'Gemini CLI', 'pi-cli': 'Pi', 'grok-build': 'Grok', openrouter: 'OpenRouter', groq: 'Groq', google: 'Google', anthropic: 'Anthropic', openai: 'OpenAI' };
export function doorWord(door) {
  if (!door) return 'an unknown route';
  return DOOR_WORDS[door] || String(door).split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
/** A plain model name: 'claude-opus-4-8-20260115' → 'Claude Opus 4.8', 'gpt-6-luna' → 'GPT-6 Luna'. */
export function modelWord(id) {
  if (!id) return 'unknown model';
  const parts = String(id).split(/[-_]/).filter((p) => p && !/^\d{8}$/.test(p));
  const out = [];
  for (const p of parts) {
    if (/^\d+$/.test(p) && out.length && /\d$/.test(out[out.length - 1])) out[out.length - 1] += `.${p}`;
    else if (/^\d+$/.test(p) && out.length && /^gpt$/i.test(out[out.length - 1])) out[out.length - 1] += `-${p}`;
    else if (/^(gpt|llm|ai)$/i.test(p)) out.push(p.toUpperCase());
    else out.push(p.charAt(0).toUpperCase() + p.slice(1));
  }
  return out.join(' ') || String(id);
}
const CHECK_WORDS = {
  MessagingToneGate: 'Message tone check', CoherenceReviewer: 'Coherence review', TopicIntentExtractor: 'Topic intent reader', TopicIntentArcCheck: 'Topic intent arc check',
  MessageSentinel: 'Emergency-stop message check', CommitmentSentinel: 'Promise check', PresenceProxy: 'Unanswered-message check', SessionActivitySentinel: 'Session activity check',
  SessionSummarySentinel: 'Session summary', StallTriageNurse: 'Stall triage', ExternalHogClassifier: 'Runaway-process classifier', ContextualEvaluator: 'Contextual evaluation',
  crossModelReviewer: 'Cross-model review', 'completion-claim-verify': 'Completion claim check', WarrantsReplyGate: 'Needs-a-reply check', UnjustifiedStopGate: 'Early-stop check',
  PromptGate: 'Prompt gate', InputGuard: 'Input guard', TaskClassifier: 'Task classifier', TopicSummarizer: 'Topic summary', TemporalCoherenceChecker: 'Time coherence check',
  GoalPriorityExtractor: 'Goal priority reader', ProjectDriftChecker: 'Plan drift check', FeedbackTriageArbiter: 'Feedback triage', FeedbackReadinessArbiter: 'Feedback readiness',
  'correction-learning': 'Correction learning', 'correction-class-review': 'Correction class review', 'subscription-relogin-supervisor': 'Sign-in repair supervisor',
  RelationshipManager: 'Relationship notes', TreeTriage: 'Self-knowledge triage', TreeSynthesis: 'Self-knowledge synthesis', Usher: 'Conversation usher', ResumeValidator: 'Resume check',
  'telegram-origin-recovery': 'Telegram origin recovery', openConversationBrief: 'Conversation brief', 'mentor-stage-b': 'Mentor review', SessionWatchdog: 'Session watchdog',
};
export function checkWord(feature) {
  if (!feature) return 'An unnamed check';
  if (CHECK_WORDS[feature]) return CHECK_WORDS[feature];
  const words = String(feature).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s\-_/.:]+/).filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(' ');
}

/** The basis word for a reporting row, from the server's costBasis (routingSpendView.ts). */
export function basisWord(row) {
  const b = row && row.costBasis;
  if (b === 'provider-reported') return 'provider-reported';
  if (b === 'subscription-zero') return 'subscription';
  if (b === 'unpriced') return 'unpriced';
  if (b === 'internal-derived' || b === 'internal-derived-provider-tokens') return 'estimated';
  // No basis field: never invent one.
  return 'basis not stated';
}
/** The status word for a paid route, used everywhere: Frozen wins; else Open / Closed / Not open. */
export function routeStatusWord(k) {
  if (k && k.frozen) return 'Frozen';
  if (k && k.goLiveState === 'live') return 'Open';
  if (k && k.goLiveState === 'disarmed') return 'Closed';
  return 'Not open';
}

// ── 1. Recorded cost (this machine's ledger) ───────────────────────────────
/** One priced row in words. */
export function costRow(r) {
  const basis = basisWord(r);
  const tokens = (Number(r.tokensIn) || 0) + (Number(r.tokensOut) || 0);
  const unpriced = (Number(r.unpricedTokensIn) || 0) + (Number(r.unpricedTokensOut) || 0);
  const usd = r.costBasis === 'provider-reported' && typeof r.providerReportedUsd === 'number' ? r.providerReportedUsd : r.netUsd;
  const bits = [basis, `${fmtTokens(tokens)} tokens`];
  if (unpriced > 0 && basis !== 'unpriced') bits.push(`${fmtTokens(unpriced)} unpriced`);
  if (r.priceStale) bits.push('price may be out of date');
  if (r.notLiveYet) bits.push('route not open yet');
  return {
    key: `cost:${r.door}|${r.modelId}`, type: 'cost', main: `${modelWord(r.modelId)} · ${doorWord(r.door)}`, sub: bits.join(' · '),
    end: basis === 'unpriced' ? 'unpriced' : fmtUsd(usd), tone: basis === 'unpriced' ? 'unknown' : r.priceStale ? 'attn' : null,
    basis, usd: basis === 'unpriced' ? null : Number(usd) || 0, tokens, unpriced, record: r,
  };
}

/**
 * The recorded-cost model from GET /routing-spend/summary.
 * { state:'off'|'failed'|'ok', reason, rows, netUsd, unpricedTokens, tokens, bases:[...],
 *   costWords, grain, horizonNote, lastReconcileAt, rollupMaintained, amortized }
 */
export function buildRecordedCost(res) {
  if (!res || !res.ok) {
    if (off(res)) return { state: 'off', reason: 'Spend figures aren’t available on this agent (the reporting view is switched off here). Turning limits on does not change that.', rows: [] };
    return { state: 'failed', reason: `Can’t tell what was recorded: ${res ? res.reason : 'not read'}.`, rows: [] };
  }
  const d = res.data || {};
  const list = Array.isArray(d.rows) ? d.rows : null;
  const t = d.totals;
  if (!list || !t || typeof t !== 'object') return { state: 'failed', reason: 'The spend view answered without its rows or totals.', rows: [] };
  const rows = list.filter((r) => r && typeof r === 'object').map(costRow);
  const netUsd = Number(t.netUsd) || 0;
  const unpricedTokens = (Number(t.unpricedTokensIn) || 0) + (Number(t.unpricedTokensOut) || 0);
  const tokens = (Number(t.tokensIn) || 0) + (Number(t.tokensOut) || 0);
  // The bases that carry dollars (subscription and unpriced rows contribute none).
  const bases = [...new Set(rows.filter((r) => r.usd !== null && r.usd > 0).map((r) => r.basis))];
  const doors = [...new Set(rows.filter((r) => r.usd !== null && r.usd > 0).map((r) => doorWord(r.record.door)))];
  const subscriptionTokens = rows.filter((r) => r.basis === 'subscription').reduce((a, r) => a + r.tokens, 0);
  // The plain sentence: dollars first, the basis spelled out in words, never a label in the headline.
  const BASIS_PLAIN = { estimated: 'estimated from token counts and a price list', 'provider-reported': 'reported by the provider', 'basis not stated': 'basis not stated' };
  let costWords = 'No pay-per-use cost';
  let howWords = null;
  if (netUsd > 0) {
    costWords = `About ${fmtUsd(netUsd)} of pay-per-use cost`;
    howWords = `${bases.map((b) => BASIS_PLAIN[b] || b).join(' and ') || 'basis not stated'}${doors.length === 1 ? `, all on ${doors[0]}` : ''}.`;
    howWords = howWords.charAt(0).toUpperCase() + howWords.slice(1);
  }
  const rb = d.reportingBasis && typeof d.reportingBasis === 'object' ? d.reportingBasis : {};
  return {
    state: 'ok', reason: null, rows, netUsd, grossUsd: Number(t.grossUsd) || 0, creditUsd: Number(t.creditUsd) || 0, unpricedTokens, tokens, bases, costWords, howWords, subscriptionTokens,
    grain: d.grain || 'day', horizonNote: typeof d.horizonNote === 'string' ? d.horizonNote : null,
    lastReconcileAt: rb.lastReconcileAt || null, rollupMaintained: rb.rollupMaintained === true, source: rb.source || null,
    amortized: typeof t.amortizedSubscriptionUsd === 'number' ? t.amortizedSubscriptionUsd : null,
    anyStalePrice: rows.some((r) => r.record.priceStale),
  };
}

// ── 1b. Paid routes: committed limits (kept apart from the reporting rows) ──
/** One paid route's committed line: "$3 of $25 today · $40 of $60 total (committed)". */
export function committedLine(k) {
  return `${fmtUsd(k.committedDayUsd)} of ${fmtUsd(k.dailyCapUsd)} today · ${fmtUsd(k.committedLifetimeUsd)} of ${fmtUsd(k.lifetimeCapUsd)} total (committed)`;
}
/** The limits model from GET /routing-spend/caps (+ GET /routing-spend/enable-status for the switch). */
export function buildLimits(capsRes, statusRes) {
  const out = { caps: { state: 'ok', reason: null, rows: [] }, controls: { state: 'ok', reason: null, word: null, sentence: null, machine: null } };
  if (!capsRes || !capsRes.ok) {
    out.caps = off(capsRes) ? { state: 'off', reason: 'Paid-route limits aren’t readable on this agent (same switch as the spend figures).', rows: [] }
      : { state: 'failed', reason: `Can’t tell the limits: ${capsRes ? capsRes.reason : 'not read'}.`, rows: [] };
  } else {
    const keys = Array.isArray(capsRes.data && capsRes.data.keys) ? capsRes.data.keys : null;
    if (!keys) out.caps = { state: 'failed', reason: 'The limits view answered without its routes.', rows: [] };
    else {
      out.caps.rows = keys.filter((k) => k && typeof k === 'object').map((k) => {
        const word = routeStatusWord(k);
        return { key: `cap:${k.keyRef}`, type: 'cap', main: `${doorWord(k.provider)} · ${doorWord(k.door)}`, sub: committedLine(k), end: word, word,
          tone: word === 'Frozen' ? 'attn' : word === 'Open' ? null : 'unknown', record: k };
      });
      out.caps.storeError = typeof capsRes.data.storeError === 'string' ? capsRes.data.storeError : null;
    }
  }
  if (!statusRes || !statusRes.ok) {
    out.controls = off(statusRes) ? { state: 'off', reason: 'Spending controls aren’t built on this machine.', word: 'off', sentence: 'Spending limits are not built on this machine.', machine: null }
      : { state: 'failed', reason: `Can’t tell whether limits are on: ${statusRes ? statusRes.reason : 'not read'}.`, word: 'Can’t tell', sentence: null, machine: null };
  } else {
    const s = statusRes.data || {};
    const machine = typeof s.machineNickname === 'string' && s.machineNickname ? s.machineNickname : null;
    let word; let sentence;
    if (s.enforcementReady === true) { word = 'on'; sentence = 'Limits are on and enforcing'; }
    else if (s.lifecycleState === 'enable-pending-restart') { word = 'waiting'; sentence = 'Limits are turned on but wait for a restart to start enforcing'; }
    else if (s.lifecycleState === 'probe-failed' || s.lifecycleState === 'construction-failed') { word = 'failing'; sentence = `Limits are turned on but not enforcing (${String(s.lifecycleState).replace(/-/g, ' ')}${s.failingComponent ? `: ${s.failingComponent}` : ''})`; }
    else if (s.lifecycleState === 'disabled' || s.lifecycleState === undefined) { word = 'off'; sentence = 'Spending limits are off'; }
    else { word = String(s.lifecycleState).replace(/-/g, ' '); sentence = `Limits: ${word}`; }
    if (s.anyKeyFrozen === true) { word = 'a route frozen'; sentence += '; a paid route is frozen'; }
    out.controls = { state: 'ok', reason: null, word, sentence: `${sentence}${machine ? ` (held by ${machine})` : ''}.`, machine, lifecycleState: s.lifecycleState || null, enforcementReady: s.enforcementReady === true, anyKeyFrozen: s.anyKeyFrozen === true, configEnabled: Boolean(s.enableSources && (s.enableSources.state === 'config-enabled' || s.enableSources.state === 'both-enabled')) };
  }
  const open = out.caps.rows.filter((r) => r.word === 'Open').length;
  const frozen = out.caps.rows.filter((r) => r.word === 'Frozen').length;
  out.openRoutes = open; out.frozenRoutes = frozen;
  out.routesSentence = out.caps.state !== 'ok' ? null : out.caps.rows.length === 0 ? 'No paid route is set up.' : open === 0 && frozen === 0 ? 'No paid route is open.' : [open ? `${open} paid ${open === 1 ? 'route is' : 'routes are'} open` : null, frozen ? `${frozen} frozen` : null].filter(Boolean).join('; ') + '.';
  return out;
}

// ── 2. Background checks (LLM activity) ────────────────────────────────────
/** One check as a row with its stacked-bar segments. No dollars: the ledger cannot attribute a route per check. */
export function checkRow(f) {
  const real = Number(f.realCalls) || 0;
  const calls = Number(f.calls) || 0;
  const errors = Number(f.errors) || 0;
  const shed = Number(f.shed) || 0;
  const fired = Number(f.fired) || 0;
  const noop = Number(f.noop) || 0;
  const unclassified = Number(f.unclassified) || 0;
  const tokens = (Number(f.tokensIn) || 0) + (Number(f.tokensOut) || 0);
  const skipShare = calls > 0 ? shed / calls : 0;
  const models = Array.isArray(f.models) ? f.models.filter(Boolean).map(modelWord) : [];
  const bits = [`${real} ${real === 1 ? 'call' : 'calls'}`, `${fired} acted`];
  if (shed) bits.push(`${shed} skipped`);
  if (errors) bits.push(`${errors} failed`);
  if (models.length) bits.push(`on ${models.join(', ')}`);
  return {
    key: `check:${f.feature}`, type: 'check', feature: f.feature, main: checkWord(f.feature), sub: bits.join(' · '), end: tokens ? `${fmtTokens(tokens)} tokens` : 'no tokens recorded',
    tone: errors > 0 ? 'bad' : skipShare >= 0.5 ? 'unknown' : null, real, calls, errors, shed, fired, noop, unclassified, tokens, skipShare,
    segments: [['acted', fired], ['quiet', noop], ['other', unclassified], ['skipped', shed], ['failed', errors]].filter(([, n]) => n > 0),
    // Order: anything that failed first (most failures first), then the checks that acted most, then volume.
    sortKey: (errors > 0 ? 1e12 : 0) + Math.min(errors, 999) * 1e9 + Math.min(fired, 999999) * 1e3 + Math.min(calls, 999),
    latency: { p50: Number(f.p50LatencyMs) || 0, p95: Number(f.p95LatencyMs) || 0 },
    byModel: Array.isArray(f.byModel) ? f.byModel.map((m) => ({ model: modelWord(m.model), framework: doorWord(m.framework), calls: Number(m.realCalls) || 0, tokens: (Number(m.tokensIn) || 0) + (Number(m.tokensOut) || 0), errors: Number(m.errors) || 0 })) : [],
    record: f,
  };
}

/** The Insights line for this page from GET /insights/llm-activity: absent on 503/404/failure, "paused", or the plain read with its stamp. */
export function insightLine(res, now = Date.now()) {
  if (!res || !res.ok) return { state: 'absent' };
  const d = res.data || {};
  if (d.source === 'paused') return { state: 'paused', text: 'Plain read paused: this page’s data was unavailable when it was last written.' };
  if (typeof d.headline !== 'string' || !d.headline) return { state: 'absent' };
  const age = d.asOf ? ago(d.asOf, now) : null;
  const by = d.source === 'llm' ? 'written by AI' : 'summary';
  return { state: 'ok', text: d.headline, stamp: [by, age, d.stale ? 'may be out of date' : null].filter(Boolean).join(' · '), lines: Array.isArray(d.lines) ? d.lines.map((l) => l && l.text).filter(Boolean) : [] };
}

/** The Background checks model from GET /metrics/features (+ the Insights line). */
export function buildChecks(res, insightsRes, now = Date.now()) {
  const insight = insightLine(insightsRes, now);
  if (!res || !res.ok) {
    if (off(res)) return { state: 'off', reason: 'Background checks aren’t tracked on this agent.', rows: [], insight };
    return { state: 'failed', reason: `Can’t tell about the background checks: ${res ? res.reason : 'not read'}.`, rows: [], insight };
  }
  const d = res.data || {};
  const list = Array.isArray(d.features) ? d.features : null;
  if (!list) return { state: 'failed', reason: 'The check ledger answered without its features.', rows: [], insight };
  const rows = list.filter((f) => f && typeof f.feature === 'string').map(checkRow).sort((a, b) => b.sortKey - a.sortKey);
  const t = d.totals && typeof d.totals === 'object' ? d.totals : {};
  const real = typeof t.realCalls === 'number' ? t.realCalls : rows.reduce((a, r) => a + r.real, 0);
  const errors = typeof t.errors === 'number' ? t.errors : rows.reduce((a, r) => a + r.errors, 0);
  const shed = typeof t.shed === 'number' ? t.shed : rows.reduce((a, r) => a + r.shed, 0);
  const tokens = (Number(t.tokensIn) || 0) + (Number(t.tokensOut) || 0);
  const skipper = rows.filter((r) => r.calls >= 5 && r.skipShare >= 0.2).sort((a, b) => b.skipShare - a.skipShare)[0] || null;
  let sentence;
  if (rows.length === 0 || (real === 0 && shed === 0)) sentence = 'No background checks ran in this window.';
  else {
    const parts = [`${real.toLocaleString('en-US')} background ${real === 1 ? 'check' : 'checks'}`];
    parts.push(errors ? `${errors} failed` : 'none failed');
    if (skipper) parts.push(`the ${skipper.main.replace(/ check$/i, '').toLowerCase()} check skipped ${Math.round(skipper.skipShare * 100)}% to save limits`);
    sentence = parts.join('; ') + '.';
  }
  // Models used by all background checks together (the ledger cannot say which routing lane a call belonged to).
  const byModel = Array.isArray(t.byModel) ? t.byModel.filter((m) => m && (Number(m.realCalls) || 0) > 0) : [];
  const totalCalls = byModel.reduce((a, m) => a + (Number(m.realCalls) || 0), 0);
  const usedLately = byModel.map((m) => ({ model: modelWord(m.model), framework: doorWord(m.framework), calls: Number(m.realCalls) || 0, pct: totalCalls ? Math.round(((Number(m.realCalls) || 0) / totalCalls) * 100) : 0 })).sort((a, b) => b.calls - a.calls);
  return { state: 'ok', reason: null, rows, real, errors, shed, tokens, sentence, insight, usedLately, note: 'Cost per check isn’t recorded yet: a check knows its model but not the route it was served through, so no dollar figure can be derived.' };
}

// ── 3. Your conversations (transcripts) ────────────────────────────────────
function shortProject(p) { if (!p) return null; const s = String(p).replace(/\/+$/, '').split('/').pop(); return s || null; }

/** The title line when no session name resolves: "In echo, last active 2 h ago" — the project and the age, never a repeated placeholder. */
function unnamedTitle(project, lastTs, now) {
  const age = lastTs ? ago(lastTs, now) : null;
  if (project && age) return `In ${project}, last active ${age}`;
  if (project) return `In ${project}`;
  return age ? `Last active ${age}` : 'A conversation';
}
/** A Claude conversation row from /tokens/sessions (window total). */
export function claudeRow(s, names = {}, now = Date.now()) {
  const name = names[s.sessionId] || null;
  const project = shortProject(s.projectPath);
  const age = s.lastTs ? ago(s.lastTs, now) : null;
  return { key: `claude:${s.sessionId}`, type: 'claude', main: name || unnamedTitle(project, s.lastTs, now), sub: name ? [project, age ? `last active ${age}` : null].filter(Boolean).join(' · ') : '', end: `${fmtTokens(s.totalTokens)} tokens`, tokens: Number(s.totalTokens) || 0, record: s };
}
/** A Codex row from /tokens/codex-sessions: the figure is the session's LIFETIME total. */
export function codexRow(s, names = {}, now = Date.now()) {
  const name = names[s.sessionId] || null;
  const project = shortProject(s.projectPath);
  const age = s.lastTs ? ago(s.lastTs, now) : null;
  return { key: `codex:${s.sessionId}`, type: 'codex', main: name || unnamedTitle(project, s.lastTs, now), sub: ['lifetime total', name && age ? `last active ${age}` : null, s.model ? modelWord(s.model) : null].filter(Boolean).join(' · '), end: `${fmtTokens(s.totalTokens)} tokens`, tokens: Number(s.totalTokens) || 0, record: s };
}

/**
 * The conversations model. Two lines that measure different things and are never added:
 * Claude = events inside the window (summary.sessionsActive, summary.totalTokens);
 * Codex = lifetime totals of sessions active in the window (codex.sessionCount, codex.totalTokens).
 */
export function buildConversations(res, phrase, { claude, codex, orphans, names = {} } = {}, now = Date.now()) {
  if (!res || !res.ok) {
    if (off(res)) return { state: 'off', reason: 'Conversation token use isn’t tracked here.' };
    return { state: 'failed', reason: `Can’t tell about conversation token use: ${res ? res.reason : 'not read'}.` };
  }
  const d = res.data || {};
  const s = d.summary && typeof d.summary === 'object' ? d.summary : null;
  const c = d.codex && typeof d.codex === 'object' ? d.codex : null;
  if (!s) return { state: 'failed', reason: 'The token summary answered without its Claude figures.' };
  const cl = { count: Number(s.sessionsActive) || 0, tokens: Number(s.totalTokens) || 0, newestEventAt: s.newestEventTs || null };
  cl.line = `Claude: ${cl.count} ${cl.count === 1 ? 'conversation' : 'conversations'} processed ${fmtTokens(cl.tokens)} tokens ${phrase}.`;
  cl.rows = claude && claude.ok && Array.isArray(claude.data && claude.data.sessions) ? claude.data.sessions.filter(Boolean).map((x) => claudeRow(x, names, now)) : [];
  cl.listReason = claude && !claude.ok ? `Couldn’t list Claude conversations: ${claude.reason}.` : null;
  let cx = null;
  if (c) {
    cx = { count: Number(c.sessionCount) || 0, tokens: Number(c.totalTokens) || 0 };
    cx.line = `Codex: ${cx.count} ${cx.count === 1 ? 'conversation' : 'conversations'} active ${phrase} ${cx.count === 1 ? 'has' : 'have'} used ${fmtTokens(cx.tokens)} tokens over ${cx.count === 1 ? 'its' : 'their'} whole life.`;
    cx.rows = codex && codex.ok && Array.isArray(codex.data && codex.data.sessions) ? codex.data.sessions.filter(Boolean).map((x) => codexRow(x, names, now)) : [];
    cx.listReason = codex && !codex.ok ? `Couldn’t list Codex conversations: ${codex.reason}.` : null;
  }
  const idle = orphans && orphans.ok && Array.isArray(orphans.data && orphans.data.orphans)
    ? { count: orphans.data.orphans.length, rows: orphans.data.orphans.filter(Boolean).map((o) => ({ key: `idle:${o.sessionId}`, type: 'claude', main: names[o.sessionId] || (shortProject(o.projectPath) ? `In ${shortProject(o.projectPath)}, idle for ${ago(o.lastTs, now) ? ago(o.lastTs, now).replace(' ago', '') : 'a while'}` : `Idle for ${ago(o.lastTs, now) ? ago(o.lastTs, now).replace(' ago', '') : 'a while'}`), sub: names[o.sessionId] ? `idle for ${ago(o.lastTs, now) ? ago(o.lastTs, now).replace(' ago', '') : 'a while'}` : '', end: `${fmtTokens(o.totalTokens)} tokens`, record: o })) }
    : { count: null, reason: orphans ? `Couldn’t count idle conversations: ${orphans.reason}.` : null };
  return {
    state: 'ok', reason: null, claude: cl, codex: cx, idle,
    // The summary carries the newest event, not a scan time; say that and nothing more.
    newestEvent: cl.newestEventAt ? `newest event ${ago(cl.newestEventAt, now)}` : null,
    note: 'The two lines measure different things and are not added together: Claude counts the events inside the window; a Codex session reports one running total for its whole life, counted when it was active in the window.',
  };
}

// ── Which model does what (routing sheet) ──────────────────────────────────
const LANE_WORDS = { FAST: 'Quick checks', SORT: 'Sorting', JUDGE: 'Judging', WRITE: 'Writing' };
export function laneWord(chain) { return LANE_WORDS[chain] || String(chain || 'Other'); }
/** The routing model from GET /intelligence/routing/chains. */
export function buildRouting(res) {
  if (!res || !res.ok) {
    if (off(res)) return { state: 'off', reason: 'No AI routing is configured on this agent.', lanes: [] };
    return { state: 'failed', reason: `Can’t tell how work is routed: ${res ? res.reason : 'not read'}.`, lanes: [] };
  }
  const d = res.data || {};
  const chains = Array.isArray(d.chains) ? d.chains : null;
  if (!chains) return { state: 'failed', reason: 'The routing map answered without its chains.', lanes: [] };
  const lanes = chains.filter((c) => c && Array.isArray(c.positions)).map((c) => {
    const positions = c.positions.map((p) => ({ word: modelWord(p.modelId || p.label), door: doorWord(p.door), paid: p.doorClass === 'metered', notYet: p.skippedInIncrementA === true }));
    return { key: c.chain, label: laneWord(c.chain), positions, text: positions.map((p) => `${p.word}${p.paid ? ' (pay-per-use)' : ''}`).join(' → ') };
  });
  const fast = lanes.find((l) => l.key === 'FAST');
  const judge = lanes.find((l) => l.key === 'JUDGE');
  const parts = [];
  if (fast && fast.positions.length) parts.push(`Quick checks run on ${fast.positions[0].word}`);
  if (judge && judge.positions.length) parts.push(`judging runs on ${judge.positions[0].word}`);
  if (fast && fast.positions.length > 1) parts.push(`${fast.positions[fast.positions.length - 1].word} is the last fallback`);
  const comps = Array.isArray(d.components) ? d.components : [];
  const jobs = comps.filter((c) => c && c.component).map((c) => ({ component: checkWord(c.component), lane: c.chain ? laneWord(c.chain) : 'not mapped', framework: c.enforcedFramework ? doorWord(c.enforcedFramework) : null }));
  return { state: 'ok', reason: null, lanes, sentence: parts.length ? parts.join('; ') + '.' : 'No routing lanes are defined.', jobs, defaultFramework: d.defaultFramework ? doorWord(d.defaultFramework) : null };
}

// ── the page ───────────────────────────────────────────────────────────────
/**
 * Build the whole page from the reads: { spend, caps, status, metrics, insights, tokens, claude, codex, orphans, chains, names }.
 * Returns { headline, sub, tone, facts, window, recorded, limits, checks, conversations, routing }.
 */
export function buildCostsPage(res, now = Date.now(), { window = DEFAULT_WINDOW } = {}) {
  const r = res || {};
  const w = windowParams(window, now);
  const recorded = buildRecordedCost(r.spend);
  const limits = buildLimits(r.caps, r.status);
  const checks = buildChecks(r.metrics, r.insights, now);
  const conversations = buildConversations(r.tokens, w.phrase, { claude: r.claude, codex: r.codex, orphans: r.orphans, names: r.names || {} }, now);
  const routing = buildRouting(r.chains);

  let headline;
  if (recorded.state === 'ok') headline = `${recorded.costWords} ${w.phrase} on this machine.`;
  else if (recorded.state === 'off') headline = 'Spend figures aren’t available on this agent.';
  else headline = 'Can’t tell what AI use cost on this machine.';
  const subParts = [];
  if (recorded.state === 'ok') {
    if (recorded.howWords) subParts.push(recorded.howWords);
    if (recorded.unpricedTokens > 0) subParts.push(`${fmtTokens(recorded.unpricedTokens)} tokens went through with no price on file for their route, so they are counted but not priced.`);
    if (recorded.subscriptionTokens > 0) subParts.push(`${fmtTokens(recorded.subscriptionTokens)} tokens ran on subscriptions, which are not billed per token.`);
  } else subParts.push(recorded.reason);
  if (limits.controls.sentence && limits.routesSentence) subParts.push(`${limits.controls.sentence.replace(/\.$/, '')}, and ${limits.routesSentence.charAt(0).toLowerCase()}${limits.routesSentence.slice(1)}`);
  else if (limits.controls.sentence) subParts.push(limits.controls.sentence);
  else if (limits.routesSentence) subParts.push(limits.routesSentence);
  if (limits.controls.state === 'failed') subParts.push(limits.controls.reason);
  subParts.push('Figures are this machine’s own ledger.');

  const facts = [];
  if (recorded.state === 'ok') facts.push({ n: fmtUsd(recorded.netUsd), label: `recorded cost${recorded.bases.length ? ' · ' + recorded.bases.join(', ') : ''}`, tone: recorded.netUsd > 0 ? 'attn' : null });
  else facts.push({ n: recorded.state === 'off' ? 'off' : 'Can’t tell', label: 'recorded cost', tone: 'unknown' });
  if (recorded.state === 'ok' && recorded.unpricedTokens > 0) facts.push({ n: fmtTokens(recorded.unpricedTokens), label: 'tokens unpriced', tone: 'unknown' });
  if (checks.state === 'ok') facts.push({ n: checks.real.toLocaleString('en-US'), label: `background checks${checks.errors ? ` · ${checks.errors} failed` : ''}`, tone: checks.errors ? 'attn' : null });
  else facts.push({ n: checks.state === 'off' ? 'off' : 'Can’t tell', label: 'background checks', tone: 'unknown' });
  facts.push({ n: limits.controls.word || 'Can’t tell', label: 'limits', tone: limits.controls.state !== 'ok' ? 'unknown' : limits.controls.anyKeyFrozen ? 'attn' : null });

  const tone = recorded.state === 'failed' ? 'attn' : (limits.controls.anyKeyFrozen || (checks.state === 'ok' && checks.errors > 0)) ? 'attn' : recorded.state === 'off' ? 'muted' : 'ok';
  return { headline, sub: subParts.filter(Boolean).join(' '), tone, facts, window: w, recorded, limits, checks, conversations, routing };
}
