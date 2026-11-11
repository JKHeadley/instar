// Agent token usage on "What thinking costs" (docs/specs/unified-usage-ledger.md, Slice 5).
// Pure model: turns the /usage/* answers into what the view draws. The view (usage.js)
// decides nothing; every word and number comes from here.
//
// Order on the page (spec): 1 headline · 2 usage over time · 3 drill-down ·
// 4 top topics/jobs/features · 5 cache hit rate + machine comparison · 6 coverage strip.

import { fmtTokens, fmtUsd, modelWord } from './costs-model.js';

/** Categorical series colours, fixed order (validated against the console's dark and light surfaces). */
export const SERIES_COLORS = {
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'],
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6'],
};
/** Six named series at most; the rest fold into "Other" (never a generated hue). */
export const MAX_SERIES = 6;

export const SPLITS = [{ key: 'model', label: 'By model' }, { key: 'framework', label: 'By engine' }];
const ENGINE_WORDS = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex', 'gemini-cli': 'Gemini', 'grok-build': 'Grok', 'pi-cli': 'Pi', api: 'Direct API' };
const DIM_WORDS = { machine: 'Machine', framework: 'Engine', model: 'Model', topic: 'Conversation', job: 'Job', feature: 'Check', session: 'Session', other: 'Others' };

export function engineWord(f) { return ENGINE_WORDS[f] || (f ? String(f) : 'Unknown'); }
export function dimWord(d) { return DIM_WORDS[d] || String(d); }

/** A series key as a person reads it. */
export function seriesLabel(split, key) {
  if (key === 'Other') return 'Other';
  return split === 'framework' ? engineWord(key) : modelWord(key);
}

/** Grain for a window: hourly bars for a day, daily otherwise. */
export function grainFor(windowKey) { return windowKey === 'today' ? 'hour' : 'day'; }

/** True when the ledger is switched off here (503) or this server predates it (404): the section is not drawn at all. */
export function ledgerOff(res) { return Boolean(res && !res.ok && /switched off|answered 404/.test(res.reason || '')); }

function pct(x) { return x > 0 && x < 0.01 ? 'under 1%' : x < 1 && x > 0.99 ? 'over 99%' : `${Math.round(x * 100)}%`; }

/** 1. Headline: tokens and equivalent cost for the window, unpriced share and missing machines beside it. */
export function buildHeadline(summaryRes, phrase) {
  if (!summaryRes || !summaryRes.ok) return { ok: false, line: 'I could not read the usage totals', why: summaryRes ? summaryRes.reason : 'no answer' };
  const s = summaryRes.data;
  const t = s.total;
  const facts = [
    { label: 'Tokens', value: fmtTokens(t.tokens.total) },
    { label: 'At API list prices', value: fmtUsd(t.equivUsd) },
    { label: 'Requests', value: fmtTokens(t.calls) },
  ];
  const caveats = [];
  if (t.unpricedTokens > 0) caveats.push(`${fmtTokens(t.unpricedTokens)} tokens (${pct(s.unpricedShare)}) have no published price and are not in the cost`);
  if (s.notReached && s.notReached.length) caveats.push(`${s.notReached.length === 1 ? 'one machine was' : `${s.notReached.length} machines were`} not reached, so the totals leave ${s.notReached.length === 1 ? 'it' : 'them'} out`);
  if (s.warming && s.warming.length) caveats.push(`${s.warming.length === 1 ? 'one machine is' : `${s.warming.length} machines are`} still catching up`);
  if (s.scope === 'this-machine-only') caveats.push('this is this machine only: the machine that combines all of them did not answer');
  if (t.partialCalls > 0) caveats.push(`${fmtTokens(t.partialCalls)} requests did not report every count, so those totals are partial`);
  return {
    ok: true,
    line: t.tokens.total === 0 ? `No token use recorded ${phrase}` : `${fmtTokens(t.tokens.total)} tokens ${phrase}, about ${fmtUsd(t.equivUsd)} at API list prices`,
    facts,
    caveats,
    basis: 'Cost is what these tokens would have cost bought by the token, at each provider\'s published price on that day. It is not what you were billed.',
  };
}

/**
 * 2. Usage over time as stacked bars. Series beyond the top six (by tokens over the window)
 * fold into "Other"; colour follows the series key, never its rank in one bucket.
 */
export function buildSeries(seriesRes, split) {
  if (!seriesRes || !seriesRes.ok) return { ok: false, why: seriesRes ? seriesRes.reason : 'no answer' };
  const pts = seriesRes.data.points || [];
  const totals = new Map();
  for (const p of pts) for (const [k, v] of Object.entries(p.series)) totals.set(k, (totals.get(k) || 0) + v.tokens);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const named = ranked.slice(0, ranked.length > MAX_SERIES ? MAX_SERIES - 1 : MAX_SERIES);
  const keys = ranked.length > named.length ? [...named, 'Other'] : named;
  const bars = pts.map((p) => {
    const parts = keys.map((k) => ({ key: k, tokens: 0, usd: 0 }));
    for (const [k, v] of Object.entries(p.series)) {
      const slot = parts.find((x) => x.key === (named.includes(k) ? k : 'Other'));
      if (slot) { slot.tokens += v.tokens; slot.usd += v.equivUsd; }
    }
    return { bucket: p.bucket, parts, tokens: parts.reduce((a, x) => a + x.tokens, 0), usd: parts.reduce((a, x) => a + x.usd, 0) };
  });
  const max = Math.max(0, ...bars.map((b) => b.tokens));
  return {
    ok: true, split, grain: seriesRes.data.grain, max,
    legend: keys.map((k, i) => ({ key: k, label: seriesLabel(split, k), slot: i })),
    bars,
    empty: bars.length === 0 || max === 0,
  };
}

/** Bucket label for an axis tick or a tooltip. */
export function bucketWord(iso, grain) {
  const d = new Date(iso);
  return grain === 'hour'
    ? d.toLocaleTimeString(undefined, { hour: 'numeric' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** 3. Drill-down: the current node's children as bars, with a breadcrumb back up. */
export function buildDrill(treeRes, path) {
  if (!treeRes || !treeRes.ok) return { ok: false, why: treeRes ? treeRes.reason : 'no answer' };
  let node = treeRes.data.root;
  const crumbs = [{ label: 'Agent', depth: 0 }];
  // The tree answer starts at the requested parent; its first level is the next dimension.
  const kids = (node.children || []).map((c) => ({
    dim: c.dim, key: c.key, label: c.dim === 'other' ? c.label : labelFor(c.dim, c.key), tokens: c.figure.tokens.total,
    usd: c.figure.equivUsd, unpriced: c.figure.unpricedTokens, canOpen: c.dim !== 'other' && c.key != null,
  }));
  path.forEach((p, i) => crumbs.push({ label: `${dimWord(p.dim)}: ${labelFor(p.dim, p.key)}`, depth: i + 1 }));
  const max = Math.max(0, ...kids.map((k) => k.tokens));
  return { ok: true, crumbs, children: kids, max, total: { tokens: node.figure.tokens.total, usd: node.figure.equivUsd }, atSessions: kids.some((k) => k.dim === 'session') };
}

function labelFor(dim, key) {
  if (key == null) return dim === 'topic' || dim === 'job' || dim === 'feature' ? 'Not attributed' : 'Unknown';
  if (dim === 'framework') return engineWord(key);
  if (dim === 'model') return modelWord(key);
  if (dim === 'session') return `${String(key).slice(0, 8)}…`;
  return String(key);
}

/** The drill order: agent → machine → engine → model → conversation/job/check → session. */
export const DRILL_ORDER = ['machine', 'framework', 'model', 'topic', 'session'];

/** Query for the next level beneath a drill path. */
export function drillQuery(path, sinceMs) {
  const parent = path.map((p) => `${p.dim}:${encodeURIComponent(p.key)}`).join('/');
  const next = DRILL_ORDER[path.length] || 'session';
  const q = new URLSearchParams({ since: String(Math.floor(sinceMs)), by: next });
  if (parent) q.set('parent', parent);
  return `/usage/tree?${q.toString()}`;
}

/** 4. Top lists by equivalent cost. */
export function buildTop(res, dim, namesOf = (k) => k) {
  if (!res || !res.ok) return { ok: false, why: res ? res.reason : 'no answer' };
  const items = (res.data.items || []).map((i) => ({
    key: i.key, label: dim === 'topic' ? namesOf(i.key) : i.key, tokens: i.tokens.total, usd: i.equivUsd, unpriced: i.unpricedTokens,
    line: `${fmtTokens(i.tokens.total)} tokens · ${fmtUsd(i.equivUsd)}${i.unpricedTokens ? ` · ${fmtTokens(i.unpricedTokens)} unpriced` : ''}`,
  }));
  return { ok: true, dim, title: { topic: 'Conversations that cost most', job: 'Jobs that cost most', feature: 'Checks that cost most' }[dim], items };
}

/**
 * 5a. Cache hit rate per bucket: the share of input that was read from cache,
 * cache_read / (input + cache_read + cache_write). A bucket with no input has no rate.
 */
export function buildCacheRate(seriesRes) {
  if (!seriesRes || !seriesRes.ok) return { ok: false, why: seriesRes ? seriesRes.reason : 'no answer' };
  const points = (seriesRes.data.points || []).map((p) => {
    let read = 0, all = 0;
    for (const v of Object.values(p.series)) { read += v.cacheRead || 0; all += (v.input || 0) + (v.cacheRead || 0) + (v.cacheWrite || 0); }
    return { bucket: p.bucket, rate: all > 0 ? read / all : null };
  });
  const known = points.filter((p) => p.rate !== null);
  const latest = known.length ? known[known.length - 1].rate : null;
  return { ok: true, grain: seriesRes.data.grain, points, latest, line: latest === null ? 'No input recorded yet' : `${pct(latest)} of input came from cache in the latest ${seriesRes.data.grain === 'hour' ? 'hour' : 'day'}` };
}

/** 5b. Machine comparison from the summary. */
export function buildMachines(summaryRes, nameOf = (id) => id) {
  if (!summaryRes || !summaryRes.ok) return { ok: false, why: summaryRes ? summaryRes.reason : 'no answer' };
  const rows = (summaryRes.data.machines || []).map((m) => ({
    id: m.machineId, label: `${nameOf(m.machineId)}${m.self ? ' (this one)' : ''}`, tokens: m.tokens.total, usd: m.equivUsd,
    state: m.self ? 'ok' : (m.pull ? m.pull.state : 'ok'),
    stateWord: m.self ? '' : m.pull && m.pull.state === 'not-reached' ? 'not reached' : m.pull && m.pull.state === 'warming' ? 'catching up' : '',
  })).sort((a, b) => b.tokens - a.tokens);
  return { ok: true, rows, max: Math.max(0, ...rows.map((r) => r.tokens)) };
}

/** 6. Coverage strip: what share is attributed and priced, and what is not measured. */
export function buildCoverage(res) {
  if (!res || !res.ok) return { ok: false, why: res ? res.reason : 'no answer' };
  const c = res.data;
  const items = [
    { label: 'Attributed to a conversation, job or check', value: pct(1 - (c.shares.unattributed || 0)) },
    { label: 'Priced', value: pct(1 - (c.shares.unpriced || 0)) },
    { label: 'Requests that reported every count', value: pct(1 - (c.shares.nullTokenCalls || 0)) },
  ];
  const unknowns = [];
  for (const n of c.notRead || []) unknowns.push(`Not measured: ${n.source} (${n.reason}).`);
  const disputed = c.pairs && c.pairs.disputedTokens;
  if (disputed) unknowns.push(`${fmtTokens(disputed)} tokens are uncertain: two records of the same work disagree.`);
  const dropped = c.counters && c.counters.invocations_dropped;
  if (dropped) unknowns.push(`${fmtTokens(dropped)} internal calls were not recorded because the queue was full.`);
  const unpriced = Object.entries(c.unpricedModels || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (unpriced.length) unknowns.push(`No published price yet for ${unpriced.map(([m]) => modelWord(m)).join(', ')}.`);
  return { ok: true, items, unknowns };
}

/** Whole section model. */
export function buildUsageSection({ summary, series, tree, topTopic, topJob, topFeature, coverage }, { split, phrase, path, namesOf, machineName } = {}) {
  if (ledgerOff(summary)) return { off: true };
  return {
    off: false,
    headline: buildHeadline(summary, phrase || 'this week'),
    series: buildSeries(series, split || 'model'),
    drill: buildDrill(tree, path || []),
    top: [buildTop(topTopic, 'topic', namesOf), buildTop(topJob, 'job'), buildTop(topFeature, 'feature')],
    cache: buildCacheRate(series),
    machines: buildMachines(summary, machineName),
    coverage: buildCoverage(coverage),
  };
}
