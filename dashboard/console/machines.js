// Machines page (docs/specs/console-features/capacity.md, "Machines").
// Reads only; the one frequent write is Rename (bearer). Identity reviews stay in
// the legacy tab until their PIN sheet is rebuilt (the plan's first cut).

import { buildMachinesPage, ropesFor, healthOf, usageOf } from './machines-model.js';
import { guardsNeedingLook } from './shared-counts.js';
import { el, setKids, pageHead, sheet, closeSheet, story, details, note, cantTell } from './ui.js';
import { legacyHref } from './nav-model.js';

const STATE_DOT = { ok: 'dot live', attn: 'dot attn', bad: 'dot bad', stale: 'dot unknown', unknown: 'dot unknown' };

export async function renderMachines(main, ctx) {
  const { get } = ctx;
  if (!main.querySelector('.machine-cards')) setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Capacity · Machines' }), el('h1', { class: 'page-title skeleton', text: 'Loading machines' })));
  const [pool, health, guards, sessions] = await Promise.all([get('/pool'), get('/health'), get('/guards'), get('/sessions?scope=pool', 8000)]);
  const live = sessions.ok && Array.isArray(sessions.data && sessions.data.sessions) ? sessions.data.sessions.filter((s) => s.status === 'running' || s.status === 'starting') : [];
  const byMachine = {};
  const names = {};
  for (const s of live) { byMachine[s.machineId] = (byMachine[s.machineId] || 0) + 1; if (s.id) names[s.id] = s.name; }
  // The "need a look" fact is the shared safety-check count (this machine's list, scope stated).
  const page = buildMachinesPage(pool, health, Date.now(), { sessionsByMachine: sessions.ok ? byMachine : undefined, guards });
  if (!page.ok) { setKids(main, pageHead({ eyebrow: 'Capacity · Machines', headline: 'Machines', tone: 'muted' }), cantTell(page.reason), legacyLink()); return; }

  const cards = el('div', { class: 'machine-cards' }, page.machines.map((m) => {
    const card = el('button', { class: 'machine-card', type: 'button', 'data-state': m.state, 'data-focus-key': `m:${m.id}` },
      el('span', { class: 'mc-top' },
        el('span', { class: STATE_DOT[m.state] || 'dot' }),
        el('span', { class: 'mc-name', text: m.name }),
        m.isSelf ? el('span', { class: 'mc-tag', text: 'this one' }) : null,
        m.leading ? el('span', { class: 'mc-tag', text: 'leading' }) : null,
        el('span', { class: 'mc-state', text: m.label })),
      el('span', { class: 'mc-line', text: [m.loadWords, typeof m.sessions === 'number' ? `${m.sessions} ${m.sessions === 1 ? 'session' : 'sessions'}` : null].filter(Boolean).join(' · ') }),
      el('span', { class: 'mc-evidence', text: m.age ? `last evidence ${m.age}${m.estimated && !page.single ? ' (estimated)' : ''}` : 'no evidence since this server started' }),
    );
    card.addEventListener('click', () => openMachine(m, { get, health, guards, names }));
    return card;
  }));
  setKids(main, 
    pageHead({ eyebrow: 'Capacity · Machines', headline: page.headline, sub: page.sub, tone: page.tone, facts: page.facts }),
    !sessions.ok ? note(`Couldn't count sessions: ${sessions.reason}.`) : null,
    cards,
    legacyLink(),
  );
  // #/capacity/machines?this=1 (the Health and Resource usage tiles) opens This machine once;
  // the query is dropped so a refresh or a closed sheet never re-opens it.
  if (new URLSearchParams(location.hash.split('?')[1] || '').get('this') === '1') {
    history.replaceState(null, '', '#/capacity/machines');
    const self = page.machines.find((m) => m.isSelf);
    if (self) openMachine(self, { get, health, guards, names });
  }
}

function legacyLink() {
  return el('p', { class: 'foot-note' }, el('a', { href: legacyHref('machines'), text: 'Identity reviews and SSH pairing are in the legacy Machines tab' }));
}

function block(title, ...kids) {
  return el('section', { class: 'sheet-block' }, el('h3', { class: 'eyebrow', text: title }), ...kids);
}

function rowsList(rows) {
  return el('div', { class: 'rows' }, rows.map((r) => el('div', { class: 'row' },
    el('span', { class: r.tone === 'attn' ? 'dot attn' : r.tone === 'bad' ? 'dot bad' : r.tone === 'unknown' ? 'dot unknown' : 'dot' }),
    el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: r.main }), r.sub ? el('span', { class: 'row-sub', text: r.sub }) : null),
    el('span', { class: 'row-end', text: r.end || '' }))));
}

async function openMachine(m, { get, health, guards, names }) {
  const hw = m.hardware || {};
  const lines = [
    { label: 'State', text: `${m.label}${m.estimated ? ' (estimated from heartbeat age and load)' : ''}` },
    { label: 'Last evidence', text: m.age || 'none since this server started' },
    { label: 'Load', text: typeof m.perCore === 'number' ? `${m.perCore.toFixed(2)} per core (${m.verdict}${m.load && m.load.estimated ? ', estimated from the load average' : ''})` : 'no reading' },
  ];
  if (hw.cpuModel) lines.push({ label: 'Hardware', text: `${hw.cpuModel}, ${hw.cpuCores} cores, ${Math.round((hw.totalMemBytes || 0) / 2 ** 30)} GB` });
  if (hw.instarVersion) lines.push({ label: 'Instar', text: hw.instarVersion });
  const body = [block('How it’s doing', story(lines))];
  if (!m.isSelf) {
    const ropes = ropesFor(m.id, health);
    body.push(block('Connections', ropes === null ? note('Can’t tell: this machine’s connection checks did not answer.') : ropes.length ? rowsList(ropes.map((r) => ({ main: r.kind, sub: r.label, tone: r.state === 'ok' ? null : r.state }))) : note('No connection checks recorded to this machine yet.')));
    body.push(note('Its parts and what is using it are read on that machine; open its own console to see them.'));
  }
  const panel = sheet({ title: m.name }, ...body, details(m.record, ['machineId', 'nickname', 'online', 'routerReceivedAt', 'selfReportedLastSeen', 'loadAvg', 'ropeCondition', 'clockSkewStatus', 'pollingActive']));
  if (m.isSelf) {
    const sb = panel.querySelector('.sheet-body');
    const [sys, res] = await Promise.all([get('/systems/status'), get('/resources/summary?sinceHours=1')]);
    // The parts list names a failing probe (from /health) and reads the safety-check count
    // from the same shared source as the page's own fact; usage names its CPU basis and
    // never shows an ended session's last sample as "now".
    const h = healthOf(sys, { health, guards });
    const u = usageOf(res, names, { running: new Set(Object.keys(names)), cores: hw.cpuCores });
    const look = guardsNeedingLook(guards, { scope: 'local' });
    const after = sb.querySelector('.raw');
    sb.insertBefore(block('My parts here', h.ok ? el('p', { class: 'card-line', text: h.summary }) : note(`Can’t tell: ${h.reason}.`), h.ok ? rowsList(h.rows.slice(0, 12)) : null), after);
    sb.insertBefore(block('What’s using it', u.ok ? el('p', { class: 'card-line', text: u.summary }) : note(`Can’t tell: ${u.reason}.`), u.ok ? rowsList(u.rows) : null), after);
    sb.insertBefore(block('Safety checks', !look.ok ? note(`Can’t tell: ${look.reason}`) : look.count ? el('p', { class: 'card-line', text: `${look.count} need a look ${look.scopeWords}: ${look.breakdownWords}.` }) : el('p', { class: 'card-line', text: `Every safety check that should be on is on ${look.scopeWords}.` }), look.ok && look.count ? rowsList(look.rows.map((x) => ({ main: x.main, sub: x.record.criticalPath ? x.guardKey : '', end: x.word, tone: 'attn' }))) : null), after);
  }
  if (m.id !== 'self') panel.querySelector('.sheet-body').append(renameBlock(m, get));
}

function renameBlock(m) {
  const input = el('input', { class: 'reason-input', value: m.name, 'aria-label': 'Machine name', maxlength: '40' });
  const status = el('p', { class: 'action-status', role: 'status' });
  const save = el('button', { class: 'btn-quiet', type: 'button', text: 'Rename' });
  save.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name || name === m.name) { status.textContent = 'Type a new name first.'; return; }
    save.disabled = true; status.textContent = 'Saving…';
    const token = (() => { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } })();
    try {
      const r = await fetch(`/pool/machines/${encodeURIComponent(m.id)}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: name }) });
      const d = await r.json().catch(() => ({}));
      status.textContent = r.ok ? 'Renamed. It shows everywhere within a minute.' : (d.error || `The server answered ${r.status}.`);
    } catch { status.textContent = 'The server could not be reached.'; }
    save.disabled = false;
  });
  return block('Name', el('div', { class: 'rename-row' }, input, save), status);
}

export { closeSheet };
