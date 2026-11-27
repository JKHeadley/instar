// Machines page (docs/specs/console-features/capacity.md, "Machines").
// Reads only; the one frequent write is Rename (bearer). Identity reviews stay in
// the legacy tab until their PIN sheet is rebuilt (the plan's first cut).

import { buildMachinesPage, ropesFor, healthOf, poolUsageOf, machineCarePool, desktopPermissionFixes } from './machines-model.js';
import { el, setKids, pageHead, sheet, closeSheet, story, note, cantTell, firstPaint, askLink } from './ui.js';
import { legacyHref } from './nav-model.js';

const STATE_DOT = { ok: 'dot live', attn: 'dot attn', bad: 'dot bad', stale: 'dot unknown', unknown: 'dot unknown' };

export async function renderMachines(main, ctx) {
  const { get } = ctx;
  firstPaint(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Capacity · Machines' }), el('h1', { class: 'page-title skeleton', text: 'Loading machines' })));
  const [pool, health, guards, sessions, care, resources, attention] = await Promise.all([get('/pool'), get('/health'), get('/guards'), get('/sessions?scope=pool', 8000), get('/machine-maintenance?scope=pool', 8000), get('/mobile/resources', 8000), get('/attention?scope=pool&status=OPEN', 8000)]);
  const usage = poolUsageOf(resources);
  const live = sessions.ok && Array.isArray(sessions.data && sessions.data.sessions) ? sessions.data.sessions.filter((s) => s.status === 'running' || s.status === 'starting') : [];
  const byMachine = {};
  const names = {};
  for (const s of live) { byMachine[s.machineId] = (byMachine[s.machineId] || 0) + 1; if (s.id) names[s.id] = s.name; }
  const gs = guards.ok && guards.data && guards.data.summary;
  const needsLook = gs ? (Number(gs.offDeviant) || 0) + (Array.isArray(gs.loadBearingGapKeys) ? gs.loadBearingGapKeys.length : 0) : 0;
  const page = buildMachinesPage(pool, health, Date.now(), { sessionsByMachine: sessions.ok ? byMachine : undefined, needsLook });
  if (!page.ok) { setKids(main, pageHead({ eyebrow: 'Capacity · Machines', headline: 'Machines', tone: 'muted' }), cantTell(page.reason), legacyLink()); return; }

  const carePool = machineCarePool(care, { pool });
  const careFor = (m) => (carePool ? (carePool.byMachine[m.id] || (m.isSelf ? carePool.selfLine : null)) : null);
  const cards = el('div', { class: 'machine-cards' }, page.machines.map((m) => {
    // A legacy answer measures only the serving machine, regardless of its display name.
    const reading = usage.pooled ? usage.byName[m.name] : m.isSelf ? usage.self : null;
    const card = el('button', { class: 'machine-card', type: 'button', 'data-state': m.state, 'data-focus-key': `m:${m.id}` },
      el('span', { class: 'mc-top' },
        el('span', { class: STATE_DOT[m.state] || 'dot' }),
        el('span', { class: 'mc-name', text: m.name }),
        m.leading ? el('span', { class: 'mc-tag', text: 'leading' }) : null,
        el('span', { class: 'mc-state', text: m.label })),
      el('span', { class: 'mc-line', text: [m.verdict ? `${m.verdict}${typeof m.perCore === 'number' ? ` · load ${m.perCore.toFixed(1)} per core` : ''}` : 'no load reading', typeof m.sessions === 'number' ? `${m.sessions} ${m.sessions === 1 ? 'session' : 'sessions'}` : null].filter(Boolean).join(' · ') }),
      el('span', { class: 'mc-evidence', text: m.age ? `last evidence ${m.age}${m.estimated && !page.single ? ' (estimated)' : ''}` : 'no evidence since the agent last started' }),
      reading ? el('span', { class: 'mc-evidence', text: `Using ${reading.line}` }) : null,
      careFor(m) ? el('span', { class: 'mc-evidence', text: `Restart care: ${careFor(m)}` }) : null,
    );
    card.addEventListener('click', () => openMachine(m, { get, health, guards, names, usage, reading }));
    return card;
  }));
  // A machine whose remote desktop lost its Mac permission: the problem and its one fix, first.
  const query = new URLSearchParams((location.hash.split('?')[1] || ''));
  const wantFix = query.get('fix') === 'desktop-permission' ? query.get('m') : null;
  const fixes = desktopPermissionFixes(attention, Object.fromEntries(page.machines.map((m) => [m.id, m.name]))) || [];
  fixes.sort((a, b) => Number(b.machineId === wantFix) - Number(a.machineId === wantFix));
  const fixCards = fixes.map((f) => el('section', { class: 'need-card desktop-fix', id: `fix-${f.machineId}`, 'data-operator-need': 'desktop-permission' },
    el('h2', { class: 'need-title', text: f.title }),
    el('p', { class: 'need-sub', text: f.why }),
    f.locked ? el('p', { class: 'need-line', text: f.locked }) : null,
    el('p', { class: 'need-line', text: f.action }),
    el('p', { class: 'need-sub', text: f.ifMissing }),
    el('p', { class: 'confirm-row' }, el('a', { class: 'btn-primary btn-inline', href: f.retryHref, text: `Then open ${f.machine}’s remote desktop` }))));
  const wantedGone = wantFix && !fixes.some((f) => f.machineId === wantFix) && attention && attention.ok;
  setKids(main, 
    pageHead({ eyebrow: 'Capacity · Machines', headline: page.headline, sub: page.sub, tone: page.tone, facts: page.facts }),
    ...fixCards,
    wantedGone ? note('Remote desktop on that Mac no longer reports a permission problem.') : null,
    wantFix && attention && !attention.ok ? note(`Couldn't check the remote desktop permission: ${attention.reason || 'no answer'}.`) : null,
    !sessions.ok ? note(`Couldn't count sessions: ${sessions.reason}.`) : null,
    // warning-path: card click opens the machine, which says what isn't answering
    usage.ok ? note(['Resource use, last hour: ' + usage.summary, usage.busiest].filter(Boolean).join(' · ')) : note(`Can’t tell resource use: ${usage.reason}.`),
    carePool ? note([carePool.header, ...carePool.missing].join(' · ')) : null,
    el('p', { class: 'foot-note' }, el('a', { href: '#/capacity/machine-care', text: 'Machine care: sign up, skip a night, change the hours, or restart now' })),
    cards,
    legacyLink(),
  );
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

async function openMachine(m, { get, health, guards, usage, reading }) {
  const hw = m.hardware || {};
  const lines = [
    { label: 'State', text: `${m.label}${m.estimated ? ' (estimated from heartbeat age and load)' : ''}` },
    { label: 'Last evidence', text: m.age || 'none since the agent last started' },
    { label: 'Load', text: typeof m.perCore === 'number' ? `${m.perCore.toFixed(2)} per core (${m.verdict})` : 'no reading' },
  ];
  if (hw.cpuModel) lines.push({ label: 'Hardware', text: `${hw.cpuModel}, ${hw.cpuCores} cores, ${Math.round((hw.totalMemBytes || 0) / 2 ** 30)} GB` });
  if (hw.instarVersion) lines.push({ label: 'Instar', text: hw.instarVersion });
  const body = [block('How it’s doing', story(lines))];
  if (!m.isSelf) {
    const ropes = ropesFor(m.id, health);
    body.push(block('Connections', ropes && ropes.some((r) => r.state === 'bad') ? askLink(`The connections to ${m.name} are failing`) : null, ropes === null ? note('Can’t tell: the connection checks did not answer.') : ropes.length ? rowsList(ropes.map((r) => ({ main: r.kind, sub: r.label, tone: r.state === 'ok' ? null : r.state }))) : note(`No connection checks recorded to ${m.name} yet.`)));
  }
  // What's using it: a pooled read covers every machine; an older server's read covers only the serving machine.
  body.push(block('What’s using it',
    reading ? el('p', { class: 'card-line', text: reading.state === 'answering' ? reading.line : `${reading.line}.` }) : note(usage && !usage.ok ? `Can’t tell: ${usage.reason}.` : `Can’t tell: ${m.name} has no resource reading here.`),
    reading && reading.state !== 'answering' ? askLink(`${m.name}'s resource use: ${reading.line}`) : null,
    reading && reading.rows.length ? rowsList(reading.rows) : null));
  // Remote desktop for every machine; the desktop page explains a machine that isn't ready and shows its setup steps.
  if (m.id !== 'self') {
    body.push(block('Remote desktop',
      el('p', { class: 'card-line', text: `Enter your dashboard PIN to open ${m.name}’s desktop. If it isn’t set up yet, that page shows the steps.` }),
      el('a', { href: `/dashboard/desktop.html?machineId=${encodeURIComponent(m.id)}`, text: `Open ${m.name}` })));
  }
  const panel = sheet({ title: m.name }, ...body);
  if (m.isSelf) {
    const sb = panel.querySelector('.sheet-body');
    const sys = await get('/systems/status');
    const h = healthOf(sys);
    const g = guards.ok && guards.data && Array.isArray(guards.data.guards) ? guards.data.guards : null;
    const isOn = (e) => e === 'on-confirmed' || e === 'on-unverified' || e === 'on-stale' || e === 'on-blind';
    const wrong = g ? g.filter((x) => x.effective && !isOn(x.effective) && !(x.effective === 'off' && x.offClass === 'dark-default') && x.effective !== 'on-dry-run') : null;
    const after = sb.querySelector('.raw');
    sb.insertBefore(block('My parts here', h.ok ? el('p', { class: 'card-line', text: h.summary }) : note(`Can’t tell: ${h.reason}.`), h.ok && h.rows.some((r) => r.tone === 'attn') ? askLink(`My parts on ${m.name}: ${h.summary}`) : null, h.ok ? rowsList(h.rows.slice(0, 12)) : null), after);
    // warning-path: #/settings/allowed
    sb.insertBefore(block('Safety checks', wrong === null ? note('Can’t tell: the safety checks did not answer.') : wrong.length ? rowsList(wrong.map((x) => ({ main: x.criticalPath || x.key, sub: x.criticalPath ? x.key : '', end: 'off', tone: 'attn' }))) : el('p', { class: 'card-line', text: 'Every safety check that should be on is on.' }), wrong && wrong.length ? el('a', { href: '#/settings/allowed', text: 'Open what I’m allowed to do' }) : null), after);
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
