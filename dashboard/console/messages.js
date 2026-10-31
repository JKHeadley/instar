// Messages to you (docs/specs/console-features/people-settings.md, "Messages to you").
// Message records need an operator session (PIN adapter b); the held count on Home
// comes from /health and needs none.

import { buildMessagesPage, displayModel, heldHeadline } from './messages-model.js';
import { el, setKids, pageHead, section, sheet, closeSheet, story, note, cantTell, askPin, operatorSession, forgetOperatorSession } from './ui.js';
import { legacyHref } from './nav-model.js';
import { topicNameMap, isRealTopicName } from './topic-names.js';

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

async function opFetch(path, opts = {}) {
  const session = operatorSession();
  const headers = { Authorization: `Bearer ${bearer()}`, ...(session ? { 'X-Instar-Operator-Session': session } : {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) };
  try {
    const r = await fetch(path, { ...opts, headers, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) { if (session) forgetOperatorSession(); return { ok: false, status: r.status, reason: 'needs your PIN', needsUnlock: true }; }
    if (!r.ok) return { ok: false, status: r.status, reason: data.error || `the server answered ${r.status}` };
    return { ok: true, status: r.status, data };
  } catch { return { ok: false, reason: 'the server could not be reached' }; }
}

export async function renderMessages(main, ctx) {
  const { get } = ctx;
  const first = !main.querySelector('.msg-page');
  if (first) setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'People · Messages to you' }), el('h1', { class: 'page-title skeleton', text: 'Loading' })));
  // A locked page is not re-polled against the PIN-gated routes every 30 s: only the
  // first render (and a render after an unlock) asks for the records.
  const locked = !first && !operatorSession() && main.querySelector('.need-card');
  const denied = { ok: false, status: 403, reason: 'needs your PIN', needsUnlock: true };
  const [status, health, display, topics] = await Promise.all([locked ? denied : opFetch('/telegram/origins/status'), get('/health'), locked ? denied : opFetch('/telegram/origin-display'), get('/telegram/topics?scope=pool')]);
  const dm = displayModel(display);
  const names = { ...(dm.ok ? Object.fromEntries(dm.topics.filter((t) => isRealTopicName(t.name, t.id)).map((t) => [String(t.id), t.name])) : {}), ...topicNameMap(topics) };
  const page = buildMessagesPage(status, health, Date.now(), names);
  const refresh = () => renderMessages(main, ctx);

  if (!page.ok) {
    const hf = page.heldForward;
    const unlock = status.needsUnlock ? el('div', { class: 'need-card' },
      el('span', { class: 'need-title', text: 'Message records need your PIN' }),
      el('span', { class: 'need-sub', text: 'Who wrote each message is private to you. One unlock lasts about 15 minutes in this page.' }),
      el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Unlock', onclick: async () => { const a = await askPin({ title: 'Message records', explain: 'Unlock message records. Your PIN is not kept; the unlock lives in this page until it expires.', adapter: 'session' }); if (a) refresh(); } })) : null;
    setKids(main, el('div', { class: 'msg-page' },
      pageHead({ eyebrow: 'People · Messages to you', headline: hf ? heldHeadline(hf.count, hf.sessionReplies, hf.automaticMessages, hf.otherMessages) : 'Messages to you', sub: hf ? 'Echo is handling delivery. Unlock to see the individual records.' : '', tone: hf && hf.count ? 'attn' : 'muted' }),
      unlock || cantTell(page.reason), legacyLink()));
    return;
  }

  const settingsRow = el('button', { class: 'acct-row', type: 'button', onclick: () => openSettings(dm, refresh, names) },
    el('span', { class: 'acct-name', text: 'Who-wrote-this footer on messages' }),
    el('span', { class: 'acct-pct', text: dm.ok ? (dm.defaults.enabled ? 'shown' : 'hidden') : 'can’t tell' }),
    el('span', { class: 'acct-line', text: dm.ok ? [dm.defaults.machine && 'machine', dm.defaults.harness && 'app', dm.defaults.model && 'model'].filter(Boolean).join(' · ') || 'nothing' : `Couldn't read the settings: ${dm.reason}.` }));

  setKids(main, el('div', { class: 'msg-page' },
    pageHead({ eyebrow: 'People · Messages to you', headline: page.headline, sub: page.sub, tone: page.tone, facts: page.facts }),
    el('div', { class: 'page-sections' },
      page.rows.length ? section({ id: 'held', title: 'Where delivery is delayed', rows: page.rows, onRow: (r) => sheet({ title: r.main },
        story([{ label: 'What happened', text: r.sub }, { label: 'Affected replies', text: String(r.count) },
          { label: 'Oldest delay', text: r.end || 'Time unavailable' },
          { label: 'Who handles it', text: 'Echo needs to restore delivery. You do not need to resend these replies.' }])) }) : null,
      el('section', { class: 'list-section' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Settings' })), el('div', { class: 'list-rows' }, settingsRow)),
      page.notReady.length ? section({ id: 'recording', title: 'Recording details', rows: page.notReady, collapsed: true, empty: 'Every part of message recording is ready.' }) : null,
    ),
    el('p', { class: 'foot-note' }, el('a', { href: legacyHref('origins'), text: 'The full message log (who wrote each message) is in the legacy Message origins tab' }))));
}

function legacyLink() {
  return el('p', { class: 'foot-note' }, el('a', { href: legacyHref('origins'), text: 'Open message origins in the legacy dashboard' }));
}

function openSettings(dm, refresh, names = {}) {
  if (!dm.ok) { sheet({ title: 'Message footer' }, note(`Can’t tell: ${dm.reason}.`)); return; }
  const scope = el('select', { class: 'reason-input', 'aria-label': 'Which conversations' },
    el('option', { value: '', text: 'Every conversation (the default)' }),
    dm.topics.map((t) => el('option', { value: String(t.id), text: names[String(t.id)] || 'Conversation name unavailable' })));
  const box = (key, label) => {
    const i = el('input', { type: 'checkbox', id: `od-${key}` });
    i.checked = Boolean(dm.defaults[key]);
    return { input: i, row: el('label', { class: 'switch-row', for: `od-${key}` }, i, el('span', { text: label })) };
  };
  const master = box('enabled', 'Show who wrote each message');
  const parts = [box('machine', 'Which machine'), box('harness', 'Which app (Claude Code, Codex…)'), box('model', 'Which model')];
  const status = el('p', { class: 'action-status', role: 'status' });
  const load = () => {
    const t = dm.topics.find((x) => String(x.id) === scope.value);
    const v = (t && t.display) || dm.defaults;
    master.input.checked = Boolean(v.enabled);
    parts.forEach((p, i) => { p.input.checked = Boolean(v[['machine', 'harness', 'model'][i]]); });
  };
  scope.addEventListener('change', load);
  const save = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Save' });
  save.addEventListener('click', async () => {
    const t = dm.topics.find((x) => String(x.id) === scope.value);
    const display = { enabled: master.input.checked, machine: parts[0].input.checked, harness: parts[1].input.checked, model: parts[2].input.checked };
    save.disabled = true; status.textContent = 'Saving…';
    let r = await opFetch('/telegram/origin-display', { method: 'POST', body: JSON.stringify({ ...(t ? { topicId: t.id } : {}), display, revision: t ? t.revision : dm.revision }) });
    if (r.needsUnlock && await askPin({ title: 'Message footer', explain: 'Saving this needs a recent PIN unlock.', adapter: 'session' })) {
      r = await opFetch('/telegram/origin-display', { method: 'POST', body: JSON.stringify({ ...(t ? { topicId: t.id } : {}), display, revision: t ? t.revision : dm.revision }) });
    }
    if (r.ok) { status.textContent = 'Saved. New messages use it; nothing already sent changes.'; setTimeout(() => { closeSheet(); refresh(); }, 1000); }
    else { status.textContent = r.status === 409 ? 'This was changed elsewhere. Close and reopen to see the latest.' : `Not saved: ${r.reason}.`; save.disabled = false; }
  });
  sheet({ title: 'Message footer' },
    el('p', { class: 'confirm-text', text: 'A small line under each message saying which machine, app and model wrote it. Recording happens either way; this only changes what is shown.' }),
    scope, master.row, el('div', { class: 'switch-group' }, parts.map((p) => p.row)),
    dm.incomplete ? note('Some conversations may be missing from this list.') : null,
    save, status);
}
