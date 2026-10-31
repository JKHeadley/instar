// Message footer settings (docs/specs/console-features/people-settings.md).
// Delivery holds belong to the recovery pipeline, not the dashboard.

import { displayModel } from './messages-model.js';
import { el, setKids, pageHead, sheet, closeSheet, note, askPin, operatorSession, forgetOperatorSession } from './ui.js';
import { verifiedDisplayName, uniqueNamedChoices } from './display-identity.js';

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
  const first = !main.querySelector('.msg-page');
  if (first) setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'People · Message settings' }), el('h1', { class: 'page-title skeleton', text: 'Loading' })));
  // A locked page is not re-polled against the PIN-gated route every 30 s.
  const locked = !first && !operatorSession() && main.querySelector('.need-card');
  const denied = { ok: false, status: 403, reason: 'needs your PIN', needsUnlock: true };
  const display = locked ? denied : await opFetch('/telegram/origin-display');
  const dm = displayModel(display);
  const refresh = () => renderMessages(main, ctx);

  if (!dm.ok) {
    const unlock = dm.needsUnlock ? el('div', { class: 'need-card' },
      el('span', { class: 'need-title', text: 'Unlock message settings' }),
      el('span', { class: 'need-sub', text: 'Use your dashboard PIN to change what appears under messages.' }),
      el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Unlock', onclick: async () => { const a = await askPin({ title: 'Message settings', explain: 'Unlock message settings. Your PIN is not kept; the unlock lives in this page until it expires.', adapter: 'session' }); if (a) refresh(); } })) : null;
    setKids(main, el('div', { class: 'msg-page' },
      pageHead({ eyebrow: 'People · Message settings', headline: 'Choose what appears under messages.', tone: 'muted' }),
      unlock || el('div', { class: 'need-card' },
        el('span', { class: 'need-title', text: 'Settings are unavailable right now.' }),
        el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Retry', onclick: refresh }))));
    return;
  }

  const settingsRow = el('button', { class: 'acct-row', type: 'button', onclick: () => openSettings(dm, refresh) },
    el('span', { class: 'acct-name', text: 'Show who wrote each message' }),
    el('span', { class: 'acct-pct', text: dm.defaults.enabled ? 'shown' : 'hidden' }),
    el('span', { class: 'acct-line', text: [dm.defaults.machine && 'machine', dm.defaults.harness && 'app', dm.defaults.model && 'model'].filter(Boolean).join(' · ') || 'nothing' }));

  setKids(main, el('div', { class: 'msg-page' },
    pageHead({ eyebrow: 'People · Message settings', headline: 'Choose what appears under messages.', tone: 'muted' }),
    el('div', { class: 'page-sections' },
      el('section', { class: 'list-section' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Settings' })), el('div', { class: 'list-rows' }, settingsRow)))));
}

function openSettings(dm, refresh) {
  if (!dm.ok) return;
  const scope = el('select', { class: 'reason-input', 'aria-label': 'Which conversations' },
    el('option', { value: '', text: 'Every conversation (the default)' }),
    uniqueNamedChoices(dm.topics, (t) => t.id, (t) => t.name).map((t) => el('option', { value: String(t.id), text: verifiedDisplayName(t.name, t.id) })));
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
