// What thinking costs (docs/specs/console-features/capacity.md: Spend + Tokens +
// LLM activity + Routing map). READ-ONLY: freeze, limits, arming and the money-layer
// switch stay in the legacy Spend tab until their native sheets ship. Every value
// reaches the DOM through textContent; the model (costs-model.js) decides everything.

import { buildCostsPage, WINDOWS, DEFAULT_WINDOW, GRAINS, windowParams, spendQuery, committedLine, basisWord, fmtTokens, fmtUsd, modelWord, doorWord } from './costs-model.js';
import { el, setKids, pageHead, section, sheet, story, details, note, cantTell } from './ui.js';
import { legacyHref } from './nav-model.js';
import { sessionLabel } from './home-model.js';

const EYEBROW = 'Capacity · What thinking costs';
const COST_KEYS = ['door', 'modelId', 'doorClass', 'priceBasis', 'costBasis', 'tokensIn', 'tokensOut', 'tokensCached', 'grossUsd', 'subsidyUsd', 'netUsd', 'committedUsd', 'providerReportedUsd', 'providerDriftPct', 'unpricedTokensIn', 'unpricedTokensOut', 'priceStale', 'notLiveYet'];
const CAP_KEYS = ['keyRef', 'provider', 'door', 'lifetimeCapUsd', 'dailyCapUsd', 'committedLifetimeUsd', 'committedDayUsd', 'frozen', 'goLiveState', 'meteredLeaseHolder'];
const CHECK_KEYS = ['feature', 'calls', 'realCalls', 'fired', 'noop', 'unclassified', 'shed', 'errors', 'tokensIn', 'tokensOut', 'tokensCached', 'p50LatencyMs', 'p95LatencyMs', 'frameworks', 'models'];
const SESSION_KEYS = ['sessionId', 'projectPath', 'model', 'totalTokens', 'eventCount', 'firstTs', 'lastTs'];

// One time control for the whole page, and the grain under "More detail"; both kept across refreshes.
const view = { window: DEFAULT_WINDOW, grain: 'day' };

export async function renderCosts(main, ctx) {
  const { get } = ctx;
  if (!main.querySelector('.costs-page')) setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: EYEBROW }), el('h1', { class: 'page-title skeleton', text: 'Loading what thinking costs' })));
  const w = windowParams(view.window);
  const [spend, caps, status, metrics, insights, tokens, claude, codex, orphans, chains, sessions] = await Promise.all([
    get(`/routing-spend/summary?${spendQuery(view.grain, w.sinceHours)}`), get('/routing-spend/caps'), get('/routing-spend/enable-status'),
    get(`/metrics/features?sinceHours=${w.sinceHours}`), get('/insights/llm-activity'),
    get(`/tokens/summary?since=${w.sinceMs}`), get(`/tokens/sessions?since=${w.sinceMs}&limit=20`), get(`/tokens/codex-sessions?since=${w.sinceMs}&limit=20`), get('/tokens/orphans?idleMs=1800000'),
    get('/intelligence/routing/chains'), get('/sessions'),
  ]);
  // Conversation names: the session list carries each live session's Claude conversation id.
  const names = {};
  if (sessions.ok && Array.isArray(sessions.data && sessions.data.sessions)) for (const s of sessions.data.sessions) if (s && s.claudeSessionId) names[s.claudeSessionId] = sessionLabel(s);
  const page = buildCostsPage({ spend, caps, status, metrics, insights, tokens, claude, codex, orphans, chains, names }, Date.now(), { window: view.window });
  const repaint = () => renderCosts(main, ctx);

  const chipRow = (items, current, pick, label) => el('div', { class: 'filter-chips', role: 'group', 'aria-label': label }, items.map((c) => el('button', {
    class: 'fchip', type: 'button', 'aria-pressed': c.key === current ? 'true' : 'false', 'data-focus-key': `${label}:${c.key}`, onclick: () => { if (c.key !== current) { pick(c.key); repaint(); } },
  }, el('span', { text: c.label }))));
  const timeControl = chipRow(Object.entries(WINDOWS).map(([key, v]) => ({ key, label: v.label })), page.window.key, (k) => { view.window = k; }, 'Time window');
  const routingLink = el('button', { class: 'link-btn head-link', type: 'button', text: 'Model routing & fallbacks ›', onclick: () => openRouting(page.routing, page.checks) });
  // The one time control sits directly under the headline, before the facts.
  const hero = pageHead({ eyebrow: EYEBROW, headline: page.headline, sub: page.sub, tone: page.tone, facts: page.facts });
  timeControl.classList.add('time-control');
  hero.insertBefore(timeControl, hero.querySelector('.facts'));
  if (page.explain.length) hero.append(el('details', { class: 'raw more-detail' }, el('summary', { text: 'How these figures work' }), page.explain.map((t) => el('p', { class: 'card-note', text: t }))));

  setKids(main, el('div', { class: 'costs-page' },
    hero,
    el('div', { class: 'page-controls' }, routingLink),
    el('div', { class: 'page-sections' },
      recordedSection(page, repaint),
      checksSection(page.checks),
      conversationsSection(page.conversations),
      controlsSection(page.limits),
    ),
    el('p', { class: 'foot-note' }, el('a', { href: legacyHref('spend'), text: 'Freeze, limits and the spending switch are in the legacy Spend tab' }), document.createTextNode(' · '), el('a', { href: legacyHref('tokens'), text: 'tokens' }), document.createTextNode(' · '), el('a', { href: legacyHref('llm-activity'), text: 'LLM activity' })),
  ));
}

function head(title, source) {
  return el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: title }), source ? el('span', { class: 'list-source', text: source }) : null);
}
function block(title, ...kids) { return el('section', { class: 'sheet-block' }, el('h3', { class: 'eyebrow', text: title }), ...kids); }

// ── 1. Recorded cost + paid routes (committed) ─────────────────────────────
function recordedSection(page, repaint) {
  const r = page.recorded;
  const L = page.limits;
  const wrap = el('section', { class: 'list-section', id: 'sec-recorded' }, head('Recorded cost', 'this machine’s ledger'));
  if (r.state !== 'ok') wrap.append(note(r.reason));
  else {
    wrap.append(el('p', { class: 'card-line', text: r.rows.length ? `${fmtUsd(r.netUsd)} pay-per-use across ${r.rows.length} ${r.rows.length === 1 ? 'model' : 'models'}${r.unpricedTokens ? `; ${fmtTokens(r.unpricedTokens)} tokens could not be priced` : ''}.` : 'Nothing recorded in this window.' }));
    if (r.hiddenEmpty) wrap.append(el('p', { class: 'card-note', text: `${r.hiddenEmpty} ${r.hiddenEmpty === 1 ? 'row' : 'rows'} with no tokens and no cost ${r.hiddenEmpty === 1 ? 'is' : 'are'} not shown.` }));
    if (r.rows.length) wrap.append(rowsOf(r.rows, (row) => openCost(row)));
    if (r.amortized !== null) wrap.append(note(`Declared subscriptions amortize to ${fmtUsd(r.amortized)} over this window (reporting only, never cap-enforced).`));
    const grainChips = el('div', { class: 'filter-chips', role: 'group', 'aria-label': 'Grain' }, GRAINS.map((g) => el('button', { class: 'fchip', type: 'button', 'aria-pressed': g.key === view.grain ? 'true' : 'false', 'data-focus-key': `grain:${g.key}`, onclick: () => { if (g.key !== view.grain) { view.grain = g.key; repaint(); } } }, el('span', { text: g.label }))));
    const more = el('details', { class: 'raw more-detail' }, el('summary', { text: 'More detail' }),
      el('p', { class: 'card-line', text: 'How the ledger is grouped. By hour and by day follow the time window above; by month and all time cover every retained day.' }), grainChips,
      r.horizonNote ? el('p', { class: 'card-note', text: r.horizonNote }) : null,
      el('p', { class: 'card-note', text: `Source: ${r.source || 'the feature-metrics ledger'}${r.lastReconcileAt ? `, reconciled ${new Date(r.lastReconcileAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}${r.rollupMaintained ? '' : ' · rollup not maintained'}. Reporting figures are recomputed at current prices; the committed figures below are what a limit enforces.` }));
    wrap.append(more);
  }
  // Paid routes: committed limits and committed spend, visibly apart from the reporting rows.
  const paid = el('section', { class: 'list-section committed', id: 'sec-paid' }, head('Paid routes', 'committed limits'));
  if (L.caps.state !== 'ok') paid.append(note(L.caps.reason));
  else {
    paid.append(el('p', { class: 'card-line', text: L.routesSentence }));
    if (L.caps.storeError) paid.append(note(`The limits store could not be read: ${L.caps.storeError}`));
    if (L.caps.rows.length) paid.append(rowsOf(L.caps.rows, (row) => sheet({ title: row.main }, story([{ label: 'Status', text: row.word }, { label: 'Committed', text: committedLine(row.record) }, row.record.meteredLeaseHolder ? { label: 'Held by', text: row.record.meteredLeaseHolder } : null].filter(Boolean)), note('Committed figures are booked at the time of use and are what the limit enforces; they are not the reporting rows above.'), details(row.record, CAP_KEYS))));
  }
  return el('div', { class: 'way-group' }, wrap, paid);
}

function rowsOf(rows, onRow) {
  return el('div', { class: 'rows list-rows' }, rows.map((r) => {
    const b = el('button', { class: 'row', type: 'button', 'data-focus-key': r.key },
      el('span', { class: r.tone === 'bad' ? 'dot bad' : r.tone === 'attn' ? 'dot attn' : r.tone === 'unknown' ? 'dot unknown' : 'dot' }),
      el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: r.main }), r.sub ? el('span', { class: 'row-sub', text: r.sub }) : null),
      el('span', { class: 'row-end' }, document.createTextNode(r.end || ''), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })));
    b.addEventListener('click', () => onRow(r));
    return b;
  }));
}

function openCost(row) {
  const r = row.record;
  const how = row.basis === 'unpriced' ? 'No price is on file for this model on this route, so its tokens are counted but not priced.'
    : row.basis === 'subscription' ? 'Covered by a subscription: it is not billed per token, so it is recorded as $0.'
      : row.basis === 'provider-reported' ? 'The provider reported this amount; it replaces the token-based estimate.'
        : 'Estimated from the token counts and the reviewed price list, at the price in force for each day.';
  const lines = [
    { label: 'Model', text: modelWord(r.modelId) }, { label: 'Reached through', text: doorWord(r.door) },
    { label: 'Cost', text: row.basis === 'unpriced' ? 'unpriced' : `${fmtUsd(row.usd)} (${basisWord(r)})` }, { label: 'How it was worked out', text: how },
    { label: 'Tokens', text: `${fmtTokens(r.tokensIn)} in · ${fmtTokens(r.tokensOut)} out${r.tokensCached ? ` · ${fmtTokens(r.tokensCached)} from cache` : ''}` },
    row.unpriced && row.basis !== 'unpriced' ? { label: 'Unpriced', text: `${fmtTokens(row.unpriced)} tokens had no price` } : null,
    r.priceStale ? { label: 'Price', text: 'may be out of date — the newest price on file is older than its freshness limit' } : null,
    typeof r.providerDriftPct === 'number' ? { label: 'Provider drift', text: `${r.providerDriftPct > 0 ? '+' : ''}${r.providerDriftPct}% against the estimate` } : null,
    r.amortizationDerivation ? { label: 'Subscription', text: r.amortizationDerivation } : null,
  ].filter(Boolean);
  sheet({ title: row.main }, story(lines), details(r, COST_KEYS));
}

// ── 2. Background checks ───────────────────────────────────────────────────
function checksSection(c) {
  // Behind a tap: the counts of automatic checks are housekeeping, not something to read on arrival.
  const wrap = el('section', { class: 'list-section', id: 'sec-checks' });
  const headBtn = el('button', { class: 'list-head', type: 'button', 'aria-expanded': 'false' }, el('h2', { class: 'eyebrow', text: 'Background checks' }), el('span', { class: 'list-source', text: 'AI calls on this machine' }), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
  const fold = el('div', { class: 'list-rows', hidden: true });
  headBtn.addEventListener('click', () => { fold.hidden = !fold.hidden; headBtn.setAttribute('aria-expanded', fold.hidden ? 'false' : 'true'); });
  wrap.append(headBtn, fold);
  if (c.state !== 'ok') { fold.append(note(c.reason)); return wrap; }
  fold.append(el('p', { class: 'card-line', text: c.sentence }));
  if (c.insight.state === 'ok') fold.append(el('p', { class: 'insight-line' }, el('span', { text: c.insight.text }), el('span', { class: 'insight-stamp', text: c.insight.stamp })));
  else if (c.insight.state === 'paused') fold.append(el('p', { class: 'card-note', text: c.insight.text }));
  if (!c.rows.length) return wrap;
  const body = el('div', { class: 'rows list-rows' });
  const limit = 5;
  let shown = 0;
  const more = el('button', { class: 'link-btn show-more', type: 'button' });
  const renderMore = () => {
    for (const r of c.rows.slice(shown, shown + limit)) body.insertBefore(checkRowEl(r, c.note), more);
    shown = Math.min(c.rows.length, shown + limit);
    more.hidden = shown >= c.rows.length;
    more.textContent = `Show ${Math.min(limit, c.rows.length - shown)} more`;
  };
  more.addEventListener('click', renderMore);
  body.append(more);
  renderMore();
  fold.append(body, el('p', { class: 'card-note', text: c.note }));
  return wrap;
}

function checkRowEl(r, costNote) {
  const total = r.segments.reduce((a, [, n]) => a + n, 0) || 1;
  const bar = el('span', { class: 'meter check-bar', role: 'img', 'aria-label': `${r.fired} acted, ${r.noop} found nothing, ${r.shed} skipped, ${r.errors} failed` });
  for (const [kind, n] of r.segments) { const s = el('span', { class: `m-${kind}` }); s.style.width = `${(n / total) * 100}%`; bar.append(s); }
  const b = el('button', { class: 'row check-row', type: 'button', 'data-focus-key': r.key },
    el('span', { class: r.tone === 'bad' ? 'dot bad' : r.tone === 'unknown' ? 'dot unknown' : 'dot' }),
    el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: r.main }), bar, el('span', { class: 'row-sub', text: r.sub })),
    el('span', { class: 'row-end' }, document.createTextNode(r.end), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })));
  b.addEventListener('click', () => {
    const lines = [
      { label: 'Calls', text: `${r.real} real · ${r.fired} acted · ${r.noop} found nothing${r.unclassified ? ` · ${r.unclassified} unclassified` : ''}` },
      { label: 'Skipped', text: r.shed ? `${r.shed} (${Math.round(r.skipShare * 100)}% of all attempts) to save limits` : 'none' },
      { label: 'Failed', text: String(r.errors) }, { label: 'Tokens', text: r.tokens ? fmtTokens(r.tokens) : 'none recorded' },
      { label: 'Latency', text: r.latency.p50 || r.latency.p95 ? `typical ${Math.round(r.latency.p50)} ms · slowest 5% over ${Math.round(r.latency.p95)} ms` : 'not recorded' },
    ];
    const body = [story(lines)];
    if (r.byModel.length) body.push(block('By model', el('div', { class: 'rows' }, r.byModel.map((m) => el('div', { class: 'row' }, el('span', { class: m.errors ? 'dot bad' : 'dot' }), el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: `${m.model} · ${m.framework}` }), el('span', { class: 'row-sub', text: `${m.calls} calls${m.errors ? ` · ${m.errors} failed` : ''}` })), el('span', { class: 'row-end', text: m.tokens ? `${fmtTokens(m.tokens)} tokens` : '' }))))));
    body.push(note(costNote), details(r.record, CHECK_KEYS));
    sheet({ title: r.main }, ...body);
  });
  return b;
}

// ── 3. Your conversations ──────────────────────────────────────────────────
function conversationsSection(c) {
  const wrap = el('section', { class: 'list-section', id: 'sec-conversations' }, head('Your conversations', 'transcripts on this machine'));
  if (c.state !== 'ok') { wrap.append(note(c.reason)); return wrap; }
  const openSession = (row) => sheet({ title: row.main }, story([{ label: 'Tokens', text: row.end }, row.type === 'codex' ? { label: 'Counted as', text: 'this session’s whole-life total, because a Codex session reports one running total' } : { label: 'Counted as', text: 'the events inside the selected window' }, row.record.projectPath ? { label: 'Project', text: String(row.record.projectPath) } : null].filter(Boolean)), details(row.record, SESSION_KEYS));
  const claude = el('div', { class: 'conv-group', 'data-kind': 'claude' }, el('p', { class: 'conv-line', text: c.claude.line }));
  if (c.claude.listReason) claude.append(note(c.claude.listReason));
  else if (c.claude.rows.length) claude.append(section({ id: 'claude-rows', title: 'Heaviest Claude conversations', rows: c.claude.rows, limit: 5, onRow: openSession }));
  wrap.append(claude);
  if (c.codex) {
    const codex = el('div', { class: 'conv-group', 'data-kind': 'codex' }, el('p', { class: 'conv-line', text: c.codex.line }));
    if (c.codex.listReason) codex.append(note(c.codex.listReason));
    else if (c.codex.rows.length) codex.append(section({ id: 'codex-rows', title: 'Heaviest Codex conversations (lifetime totals)', rows: c.codex.rows, limit: 5, onRow: openSession }));
    wrap.append(codex);
  }
  wrap.append(el('p', { class: 'card-note', text: c.note }));
  if (c.idle.count === null) { if (c.idle.reason) wrap.append(note(c.idle.reason)); }
  else if (c.idle.count > 0) wrap.append(section({ id: 'idle-rows', title: 'Idle for 30 min or more', rows: c.idle.rows, collapsed: true, limit: 5, onRow: openSession }));
  if (c.newestEvent) wrap.append(el('p', { class: 'card-age', text: c.newestEvent }));
  return wrap;
}

// ── 4. Spending controls (collapsed; read-only — actions live in the legacy tab) ──
function controlsSection(L) {
  const needsYou = L.controls.state === 'ok' && (L.controls.anyKeyFrozen || L.controls.word === 'waiting' || L.controls.word === 'failing');
  const wrap = el('section', { class: 'list-section', id: 'sec-controls' });
  const headBtn = el('button', { class: 'list-head', type: 'button', 'aria-expanded': needsYou ? 'true' : 'false' }, el('h2', { class: 'eyebrow', text: 'Spending controls' }), el('span', { class: 'list-source', text: L.controls.state === 'ok' ? L.controls.word : 'read-only here' }), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
  const body = el('div', { class: 'list-rows controls-body', hidden: !needsYou });
  if (L.controls.state !== 'ok') body.append(note(L.controls.reason));
  else {
    body.append(el('p', { class: 'card-line', text: L.controls.sentence }));
    if (L.controls.configEnabled) body.append(el('p', { class: 'card-note', text: 'The layer is turned on through the config file, so turning it off from the switch would not stop spending; Freeze is what stops it.' }));
  }
  body.append(el('p', { class: 'card-line' }, document.createTextNode('Freeze, limit changes, opening a route and the on/off switch are not built here yet. '), el('a', { href: legacyHref('spend'), text: 'Do this in the classic dashboard ↗' })));
  headBtn.addEventListener('click', () => { body.hidden = !body.hidden; headBtn.setAttribute('aria-expanded', body.hidden ? 'false' : 'true'); });
  wrap.append(headBtn, body);
  return wrap;
}

// ── Which model does what (sheet) ──────────────────────────────────────────
function openRouting(routing, checks) {
  const body = [];
  if (routing.state !== 'ok') body.push(note(routing.reason));
  else {
    body.push(el('p', { class: 'card-line', text: routing.sentence }));
    const laneEl = (l) => {
      const chain = l.positions.flatMap((p, i) => [
        i ? el('span', { class: 'lane-arrow', 'aria-hidden': 'true', text: '→' }) : null,
        el('span', { class: `lane-pos${p.paid ? ' paid' : ''}`, text: p.word }, p.paid ? el('span', { class: 'lane-tag', text: p.notYet ? 'pay-per-use · not open' : 'pay-per-use' }) : null),
      ]);
      return el('div', { class: 'lane' }, el('span', { class: 'lane-name', text: l.label }), el('span', { class: 'lane-chain' }, chain));
    };
    body.push(block('Lanes', el('div', { class: 'lanes' }, routing.lanes.map(laneEl))));
    if (routing.jobs.length) {
      const d = el('details', { class: 'raw' }, el('summary', { text: `${routing.jobs.length} background jobs and their lanes` }));
      d.append(el('dl', { class: 'raw-fields' }, routing.jobs.flatMap((j) => [el('dt', { text: j.component }), el('dd', { text: `${j.lane}${j.framework ? ` · currently ${j.framework}` : ''}` })])));
      body.push(d);
    }
  }
  if (checks.state === 'ok' && checks.usedLately.length) body.push(block('Models used by background checks lately', el('p', { class: 'card-line', text: checks.usedLately.slice(0, 5).map((m) => `${m.model} ${m.pct}%`).join(', ') }), note('All background checks together: the ledger cannot say which lane a call belonged to, so this is not shown per lane.')));
  body.push(note('Routing is changed in the agent’s settings, not here. The time window above does not apply to this sheet.'));
  sheet({ title: 'Which model does what' }, ...body);
}
