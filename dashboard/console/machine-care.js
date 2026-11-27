// Machine care page (docs/specs/machine-self-maintenance.md, Part F surfaces, CMT-1203).
// One sentence per machine, and for THIS machine: Sign up, Skip once (or Undo skip), Change
// window and Restart now. Skip and window need a recent PIN unlock; Sign up and Restart now
// only send the owner a Telegram card, and nothing happens until the owner taps it there.

import { buildMachineCarePage, controlAnswer } from './machine-care-model.js';
import { el, setKids, pageHead, note, cantTell, firstPaint, askPin, operatorSession, forgetOperatorSession, actionButton } from './ui.js';

const EYEBROW = 'Capacity · Machine care';

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

async function post(path, body, session) {
  try {
    const headers = { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json', ...(session ? { 'X-Instar-Operator-Session': session } : {}) };
    const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}), cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (session && r.status === 401) forgetOperatorSession();
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: { error: 'The server could not be reached.' } }; }
}

/** A control that needs the PIN unlock: asks once, then reuses it while it lasts. */
async function withPin(title, run) {
  const got = operatorSession() ? { session: operatorSession() } : await askPin({ title, explain: 'This needs your dashboard PIN.', adapter: 'session' });
  if (!got || !got.session) return { ok: false, message: 'Not changed: no PIN entered.' };
  return run(got.session);
}

function button(label, kind, onClick) {
  const b = el('button', { class: kind === 'primary' ? 'btn-primary btn-inline' : 'btn-quiet', type: 'button', text: label });
  b.addEventListener('click', onClick);
  return b;
}

export async function renderMachineCare(main, ctx) {
  const { get } = ctx;
  firstPaint(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: EYEBROW }), el('h1', { class: 'page-title skeleton', text: 'Loading machine care' })));
  const res = await get('/machine-maintenance?scope=pool', 10000);
  const page = buildMachineCarePage(res);
  if (!page.ok) { setKids(main, pageHead({ eyebrow: EYEBROW, headline: 'Machine care', tone: 'muted' }), cantTell(page.reason)); return; }

  const again = () => renderMachineCare(main, ctx);
  const cards = page.rows.map((row) => {
    const status = el('p', { class: 'action-status care-status', role: 'status' });
    const show = (r) => { status.textContent = r.message; if (r.ok) setTimeout(again, 2500); };
    const c = row.controls;
    const buttons = [];
    if (c && c.signUp) buttons.push(button('Sign up this machine', 'primary', async () => { status.textContent = 'Sending…'; show(controlAnswer('sign-up', await post('/machine-maintenance/enrol/offer'))); }));
    if (c && c.restartNow) buttons.push(button('Restart now', 'primary', async () => { status.textContent = 'Sending…'; show(controlAnswer('restart', await post('/machine-maintenance/restart-now/offer'))); }));
    if (c && c.skip) buttons.push(button('Skip once', 'quiet', async () => show(await withPin('Skip once', async (s) => controlAnswer('skip', await post('/machine-maintenance/skip', {}, s))))));
    if (c && c.unskip) buttons.push(button('Undo skip', 'quiet', async () => show(await withPin('Undo skip', async (s) => controlAnswer('unskip', await post('/machine-maintenance/unskip', {}, s))))));

    const off = c && c.off ? actionButton({
      label: 'Turn off', kind: 'quiet',
      confirm: `Stop restarting ${row.name}? Nothing restarts it after this, including a countdown already running. You can sign it up again later.`,
      run: () => withPin('Turn off machine care', async (s) => controlAnswer('off', await post('/machine-maintenance/remove', {}, s))),
      done: () => setTimeout(again, 2500),
    }) : null;
    let windowBox = null;
    if (c && c.window) {
      const start = el('input', { class: 'reason-input', type: 'time', value: (row.window && row.window.start) || '03:00', 'aria-label': 'Window start' });
      const end = el('input', { class: 'reason-input', type: 'time', value: (row.window && row.window.end) || '06:00', 'aria-label': 'Window end' });
      const save = button('Save window', 'quiet', async () => show(await withPin('Change window', async (s) => controlAnswer('window', await post('/machine-maintenance/window', { window: { start: start.value, end: end.value } }, s)))));
      const reset = row.ownWindow ? button('Back to the usual window', 'quiet', async () => show(await withPin('Change window', async (s) => controlAnswer('window', await post('/machine-maintenance/window', { reset: true }, s))))) : null;
      windowBox = el('details', { class: 'care-window' },
        el('summary', { text: 'Change window' }),
        el('p', { class: 'card-note', text: 'Restarts happen only between these times, at least 2 hours apart. It applies from the next night.' }),
        el('div', { class: 'rename-row' }, start, end, save), reset);
    }
    return el('section', { class: 'need-card machine-care-card', 'data-self': row.self ? '1' : '0' },
      el('h2', { class: 'need-title', text: row.self ? `${row.name} (this machine)` : row.name }),
      el('p', { class: 'need-line', text: row.sentence }),
      buttons.length ? el('div', { class: 'confirm-row' }, ...buttons) : null,
      windowBox,
      off,
      !row.self ? el('p', { class: 'card-note', text: `To change ${row.name}, open its own dashboard.` }) : null,
      status);
  });

  setKids(main,
    pageHead({ eyebrow: EYEBROW, headline: page.headline, sub: 'A clean restart about once a week in the small hours keeps a machine healthy. Running work pauses first and picks up afterward.' }),
    el('div', { class: 'detail-card-grid' }, cards),
    ...page.missing.map((m) => note(m)),
  );
}
