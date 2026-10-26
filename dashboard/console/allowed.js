// What I'm allowed to do (docs/specs/console-features/people-settings.md,
// "What I'm allowed to do", legacy tab id `features`).
// The profile, the safety checks (the one home of the guard list), suggestions,
// the feature switches (driven by the server's own state machine) and history.
// Accepting a guard's risk takes the PIN in the request body (adapter c / 'body').

import {
  buildProfile, buildHistory, buildGuards, buildSuggestions, buildFeatures, flattenFeature, profileChanges,
  walkToEnabled, canTurnOff, canUndoOff, needsConsent, facts, PROFILE_LABEL, PROFILE_SENTENCE, STATE_WORD,
} from './allowed-model.js';
import { el, setKids, pageHead, section, sheet, closeSheet, story, details, note, cantTell, actionButton, askPin } from './ui.js';
import { legacyHref } from './nav-model.js';

const featureErrors = new Map(); // feature id → the server's last refusal, shown beside the row

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

/** A request that keeps the status and the server's error object (features answer { error: { code, message } }). */
async function send(method, path, body) {
  try {
    const r = await fetch(path, { method, headers: { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data, reason: r.ok ? null : `the server answered ${r.status}` };
  } catch { return { ok: false, status: 0, data: { error: { message: 'The server could not be reached.' } }, reason: 'the server could not be reached' }; }
}
const errWords = (r) => {
  const e = r.data && r.data.error;
  if (e && typeof e === 'object') return String(e.message || e.code);
  if (typeof e === 'string') return e;
  return r.status ? `The server answered ${r.status}.` : 'The server could not be reached.';
};

export async function renderAllowed(main, ctx) {
  const { get, post } = ctx;
  if (!main.querySelector('.allowed-page')) setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Settings · What I’m allowed to do' }), el('h1', { class: 'page-title skeleton', text: 'Loading' })));
  const [auto, hist, elev, guardsRes, featRes] = await Promise.all([
    get('/autonomy'), get('/autonomy/history'), get('/autonomy/elevation'), get('/guards?scope=pool', 8000), get('/features'),
  ]);
  const profile = buildProfile(auto);
  const history = buildHistory(hist);
  const suggestions = buildSuggestions(elev);
  const guards = buildGuards(guardsRes);
  const features = buildFeatures(featRes);
  const refresh = () => renderAllowed(main, ctx);

  const eyebrow = `Settings · What I’m allowed to do${guards.ok && guards.multi && guards.selfName ? ` · ${guards.selfName}` : ''}`;
  setKids(main, el('div', { class: 'allowed-page' },
    pageHead({ eyebrow, headline: profile.ok ? profile.sentence : 'What I’m allowed to do', sub: profile.ok ? null : profile.reason, tone: guards.ok && guards.counts.look ? 'attn' : profile.ok ? 'ok' : 'muted', facts: facts({ profile, guards, features, suggestions }) }),
    el('div', { class: 'page-sections' },
      profileBlock(profile, post, refresh),
      guardsBlock(guards, refresh),
      suggestionsBlock(suggestions, post, refresh),
      featuresBlock(features, refresh),
      history.ok ? section({ id: 'history', title: 'History', rows: history.rows, collapsed: true, empty: 'The profile has never been changed.' })
        : el('section', { class: 'list-section', id: 'sec-history' }, note(history.reason)),
    ),
    el('p', { class: 'foot-note' }, el('a', { href: legacyHref('features'), text: 'Open features in the legacy dashboard' }))));

  const want = new URLSearchParams((location.hash.split('?')[1] || '')).get('s');
  if (want) {
    const sec = main.querySelector(`#sec-${want}`);
    if (sec) sec.scrollIntoView({ block: 'start' });
  }
}

// ── Profile ───────────────────────────────────────────────────────────────
function profileBlock(profile, post, refresh) {
  const wrap = el('section', { class: 'list-section', id: 'sec-profile' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'How independent I am' })));
  if (!profile.ok) { wrap.append(cantTell(profile.reason)); return wrap; }
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Autonomy profile' });
  for (const s of profile.steps) {
    seg.append(el('button', { class: `seg-step${s.current ? ' current' : ''}`, type: 'button', 'aria-pressed': s.current ? 'true' : 'false',
      onclick: () => { if (!s.current) confirmProfile(profile, s.id, post, refresh); } },
    el('span', { class: 'seg-label', text: s.label }), el('span', { class: 'seg-desc', text: s.desc })));
  }
  wrap.append(seg);
  if (profile.meaning.length) {
    wrap.append(el('h3', { class: 'eyebrow sub-label', text: 'What that means right now' }), story(profile.meaning));
  } else wrap.append(note('Can’t tell what this profile means right now: the answer had no settings.'));
  return wrap;
}

function confirmProfile(profile, target, post, refresh) {
  const changes = profileChanges(profile.resolved, target);
  const why = el('textarea', { class: 'reason-input', rows: '2', placeholder: 'Why (optional)', 'aria-label': 'Why (optional)' });
  const status = el('p', { class: 'action-status', role: 'status' });
  const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Switch' });
  go.addEventListener('click', async () => {
    go.disabled = true; status.textContent = 'Switching…';
    const r = await post('/autonomy/profile', { profile: target, reason: why.value.trim() || 'Changed in the console' });
    if (r.ok) { status.textContent = `Switched to ${PROFILE_LABEL[target]}.`; setTimeout(() => { closeSheet(); refresh(); }, 700); }
    else { status.textContent = r.reason; go.disabled = false; }
  });
  sheet({ title: `Switch to ${PROFILE_LABEL[target]}?` },
    el('p', { class: 'confirm-text', text: PROFILE_SENTENCE[target] }),
    changes.length ? el('ul', { class: 'change-list' }, changes.map((c) => el('li', { text: c }))) : el('p', { class: 'confirm-text', text: 'Nothing on this page changes, though the profile itself does.' }),
    note('A setting your settings file already pins keeps its value. This page re-reads what is in force after the switch.'),
    why, el('div', { class: 'confirm-row' }, el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel', onclick: () => closeSheet() }), go), status);
}

// ── Safety checks ─────────────────────────────────────────────────────────
function guardsBlock(guards, refresh) {
  if (!guards.ok) {
    return el('section', { class: 'list-section', id: 'sec-guards' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Safety checks' })), cantTell(guards.reason));
  }
  const open = (r) => (r.record ? openGuard(r, refresh) : null);
  return el('div', { class: 'guard-block', id: 'sec-guards' },
    section({ id: 'guards-look', title: guards.counts.look ? 'Safety checks · need a look' : 'Safety checks', rows: [...guards.look, ...guards.failed], empty: 'Every safety check is where it should be.', onRow: open, tone: guards.counts.look ? 'attn' : null }),
    section({ id: 'guards-others', title: `${guards.counts.others} others`, rows: guards.others, collapsed: true, onRow: open }));
}

function openGuard(r, refresh) {
  const g = r.record;
  const lines = [
    { label: 'Protects', text: g.criticalPath || r.main },
    { label: 'State', text: r.sub.split(' · ')[0] },
  ];
  if (r.machine) lines.push({ label: 'Machine', text: r.machine });
  if (g.acceptedFallbackReason) lines.push({ label: 'You accepted the risk because', text: g.acceptedFallbackReason });
  const blocks = [story(lines)];
  if (!r.local) blocks.push(note(`This check is on ${r.machine || 'another machine'}. Changes to it are made on that machine.`));
  if (r.actions.includes('accept')) blocks.push(acceptForm(r, refresh));
  if (r.actions.includes('stop-accepting')) {
    blocks.push(el('div', { class: 'sheet-actions' }, el('button', { class: 'btn-quiet', type: 'button', text: 'Stop accepting it',
      onclick: () => guardWrite(r, 'DELETE', {}, `You stopped accepting the risk on ${r.where}. The check shows as a gap again.`, refresh) })));
  }
  blocks.push(details(g, ['key', 'effective', 'offClass', 'configEnabled', 'defaultEnabled', 'divergence', 'process', 'criticalPath', 'loadBearing', 'loadBearingGap', 'loadBearingSoaking', 'loadBearingAccepted']));
  sheet({ title: r.main }, ...blocks);
}

function acceptForm(r, refresh) {
  const reason = el('textarea', { class: 'reason-input', rows: '2', placeholder: 'Why it is fine to run without this check', 'aria-label': 'Why it is fine to run without this check' });
  const owner = el('input', { class: 'reason-input', type: 'text', placeholder: 'Who owns this risk', 'aria-label': 'Who owns this risk' });
  const status = el('p', { class: 'action-status', role: 'status' });
  const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: `Accept this risk on ${r.where}` });
  go.addEventListener('click', () => {
    if (!reason.value.trim() || !owner.value.trim()) { status.textContent = 'Both a reason and an owner are needed.'; return; }
    guardWrite(r, 'POST', { reason: reason.value.trim(), owner: owner.value.trim() }, `Accepted on ${r.where}. The check stays off and shows as an accepted risk.`, refresh);
  });
  return el('div', { class: 'sheet-block' },
    el('p', { class: 'confirm-text', text: 'Nothing guards this right now. Accepting the risk records that you know, and stops the alarm on this machine.' }),
    reason, owner, go, status);
}

async function guardWrite(r, method, body, okText, refresh) {
  const pin = await askPin({ title: r.main, explain: 'This needs your PIN. It is used for this one request and not kept.', adapter: 'body' });
  if (!pin) return;
  const status = el('p', { class: 'action-status', role: 'status', text: 'Working…' });
  sheet({ title: r.main }, status);
  const x = await send(method, `/guards/${encodeURIComponent(r.guardKey)}/accept-fallback`, { ...body, pin: pin.pin });
  pin.pin = '';
  status.textContent = x.ok ? okText : x.status === 403 ? 'That PIN was not accepted.' : errWords(x);
  if (x.ok) setTimeout(() => { closeSheet(); refresh(); }, 1000);
}

// ── Suggestions ───────────────────────────────────────────────────────────
function suggestionsBlock(sg, post, refresh) {
  if (!sg.ok) return sg.hidden ? null : el('section', { class: 'list-section', id: 'sec-suggestions' }, note(sg.reason));
  if (!sg.items.length) return null;
  return el('section', { class: 'list-section', id: 'sec-suggestions' },
    el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: sg.items.length === 1 ? 'Suggestion' : 'Suggestions' }), el('span', { class: 'list-count', text: String(sg.items.length) })),
    sg.items.map((s) => el('div', { class: `suggestion${s.kind === 'rubber-stamp' ? ' muted' : ''}` },
      el('p', { class: 'sugg-text', text: s.text }),
      s.evidence ? el('p', { class: 'sugg-sub', text: s.evidence }) : null,
      s.how ? el('p', { class: 'sugg-sub', text: s.how }) : null,
      actionButton({ label: s.kind === 'rubber-stamp' ? 'Dismiss' : 'Not now', kind: 'quiet', run: async () => {
        const x = s.kind === 'rubber-stamp' ? await post('/autonomy/elevation/dismiss-rubber-stamp', {}) : await post('/autonomy/elevation/dismiss', { type: s.type });
        return x.ok ? { ok: true, message: 'Hidden for now.' } : { ok: false, message: x.reason };
      }, done: () => setTimeout(refresh, 700) }))));
}

// ── Features ──────────────────────────────────────────────────────────────
function featuresBlock(features, refresh) {
  const wrap = el('section', { class: 'list-section', id: 'sec-features' });
  if (!features.ok) { wrap.append(el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Features' })), cantTell(features.reason)); return wrap; }
  wrap.append(el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: `Features · ${features.on} of ${features.total} on` })));
  for (const g of features.groups) {
    wrap.append(el('h3', { class: 'eyebrow sub-label', text: g.label }),
      el('div', { class: 'list-rows feat-rows' }, g.features.map((f) => featureRow(f, refresh))));
  }
  return wrap;
}

function featureRow(f, refresh) {
  const err = featureErrors.get(f.id);
  const sw = el('button', { class: `switch${f.on ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': f.on ? 'true' : 'false', 'aria-label': `${f.name}: ${f.on ? 'on' : 'off'}`, 'data-feature': f.id });
  sw.addEventListener('click', () => (f.on ? turnOff(f, sw, refresh) : openFeature(f, refresh)));
  return el('div', { class: 'feat-row', 'data-focus-key': `feat:${f.id}` },
    el('button', { class: 'feat-main', type: 'button', onclick: () => openFeature(f, refresh) },
      el('span', { class: 'row-title', text: f.name }), f.oneLiner ? el('span', { class: 'row-sub', text: f.oneLiner }) : null,
      err ? el('span', { class: 'feat-err', text: err }) : null),
    el('span', { class: `feat-state${f.on ? ' on' : ''}`, text: STATE_WORD[f.state] || f.state }), sw);
}

async function turnOff(f, sw, refresh) {
  sw.disabled = true;
  const info = await send('GET', `/features/${encodeURIComponent(f.id)}`);
  const cur = info.ok ? flattenFeature(info.data) : f;
  if (!canTurnOff(cur)) { featureErrors.set(f.id, `It can't be turned off from “${STATE_WORD[cur.state] || cur.state}”.`); refresh(); return; }
  const r = await send('POST', `/features/${encodeURIComponent(f.id)}/transition`, { to: 'disabled', trigger: 'explicit-ask', context: 'Turned off from the console' });
  if (!r.ok) { featureErrors.set(f.id, errWords(r)); refresh(); return; }
  featureErrors.delete(f.id);
  toast(`${f.name} is off.`, canUndoOff(f) ? { label: 'Undo', run: async () => {
    const u = await send('POST', `/features/${encodeURIComponent(f.id)}/transition`, { to: 'enabled', trigger: 'explicit-ask', context: 'Undo from the console' });
    if (!u.ok) featureErrors.set(f.id, errWords(u));
    refresh();
  } } : null);
  refresh();
}

function openFeature(f, refresh) {
  const lines = [{ label: 'What it does', text: f.fullDescription || f.oneLiner || f.name }, { label: 'State now', text: STATE_WORD[f.state] || f.state }];
  const blocks = [story(lines)];
  if (f.dataImplications.length) {
    blocks.push(el('h3', { class: 'eyebrow sub-label', text: 'Your data' }),
      el('ul', { class: 'change-list' }, f.dataImplications.map((d) => el('li', { text: `${d.description || d.dataType}${d.destination && d.destination !== 'local' ? ` (goes to ${d.destination})` : ''}` }))));
  }
  if (f.reversibilityNote) blocks.push(el('h3', { class: 'eyebrow sub-label', text: 'How to undo' }), el('p', { class: 'confirm-text', text: f.reversibilityNote }));
  const status = el('p', { class: 'action-status', role: 'status', text: featureErrors.get(f.id) || '' });
  const confirmBox = el('div', { class: 'sheet-block' });
  const row = el('div', { class: 'sheet-actions' });
  if (f.on) {
    row.append(el('button', { class: 'btn-quiet', type: 'button', text: 'Turn off', onclick: (e) => { closeSheet(); turnOff(f, e.currentTarget, refresh); } }));
  } else {
    const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Turn on' });
    go.addEventListener('click', async () => {
      go.disabled = true; status.textContent = 'Working…';
      const res = await walkToEnabled(f, {
        getInfo: (id) => send('GET', `/features/${encodeURIComponent(id)}`),
        transition: (id, body) => send('POST', `/features/${encodeURIComponent(id)}/transition`, body),
        confirmChallenge: () => challenge(confirmBox),
        onStep: (s) => { status.textContent = `Now “${STATE_WORD[s] || s}”…`; },
      });
      if (res.ok) { featureErrors.delete(f.id); status.textContent = `${f.name} is on.`; setTimeout(() => { closeSheet(); refresh(); }, 800); }
      else { if (!res.cancelled) featureErrors.set(f.id, res.message); status.textContent = res.message; go.disabled = false; }
    });
    row.append(go);
    if (needsConsent(f.tier) && f.dataImplications.length) blocks.push(note('Turning this on records that you agreed to what is listed under “Your data”.'));
  }
  blocks.push(confirmBox, row, status, details({ id: f.id, tier: f.tier, state: f.state }, ['id', 'tier', 'state']));
  sheet({ title: f.name }, ...blocks);
}

/** The self-governing activation step: the operator confirms in the sheet. */
function challenge(box) {
  return new Promise((resolve) => {
    const yes = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Confirm' });
    const no = el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel' });
    const done = (v) => { setKids(box); resolve(v); };
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    setKids(box, el('div', { class: 'confirm' }, el('p', { class: 'confirm-text', text: 'Confirm: let the agent act without asking for this.' }), el('div', { class: 'confirm-row' }, no, yes)));
  });
}

function toast(text, action) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = el('div', { class: 'toast', role: 'status' }, el('span', { text }));
  if (action) t.append(el('button', { class: 'link-btn', type: 'button', text: action.label, onclick: () => { t.remove(); action.run(); } }));
  document.body.append(t);
  setTimeout(() => t.remove(), 6000);
}
