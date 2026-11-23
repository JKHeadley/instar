// Review and reminder dismissal only. Owner choices remain exclusively on the phone.
import { el, note } from './ui.js';
import { silentComputerReviewModel } from './silent-computers-model.js';
export { silentComputerReviewModel } from './silent-computers-model.js';

export function silentComputerReview(res, { post, refresh, isCurrent = () => true } = {}) {
  const m = silentComputerReviewModel(res);
  if (m.state === 'off') return null;
  if (m.state === 'unknown') return note('Could not check which computers have been silent.');
  if (m.state === 'hidden') return m.incomplete ? note('Some computers could not be checked.') : null;
  const status = el('p', { class: 'card-note', role: 'status', 'aria-live': 'polite' });
  let busy = false;
  const dismiss = el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Dismiss for now',
    'aria-label': 'Dismiss this reminder for the computers shown' });
  dismiss.addEventListener('click', async () => {
    if (busy || !isCurrent()) return;
    busy = true; dismiss.disabled = true; status.textContent = 'Dismissing this reminder…';
    try {
      const r = await post('/pin-budget/silent-machines/dismiss', { fingerprint: m.fingerprint });
      if (!isCurrent()) return;
      if (r?.ok && r.data?.ok === true) {
        await refresh('This reminder was dismissed for the current list. It returns if the situation changes.');
      } else if (r?.reason === 'list-changed' || r?.data?.error === 'list-changed') {
        await refresh('The list changed. Review the current computers before dismissing it.');
      } else {
        status.textContent = 'The reminder could not be dismissed. Try again.';
      }
    } catch {
      if (isCurrent()) status.textContent = 'The reminder could not be dismissed. Try again.';
    } finally {
      busy = false;
      if (isCurrent()) dismiss.disabled = false;
    }
  });
  return el('section', { class: 'need-card silent-computer-review', id: 'silent-computer-review', tabindex: '-1', 'data-operator-need': 'machine-retirement' },
    el('h2', { class: 'need-title', text: 'Review computers that have been silent' }),
    el('p', { class: 'need-sub', text: 'Open Needs you in the Instar app on your phone to retire a computer or confirm it gone.' }),
    el('p', { class: 'need-sub', text: `${m.rows.length === 1 ? 'This computer is' : 'These computers are'} keeping the PIN guess limit lower.` }),
    m.heldBack ? el('p', { class: 'need-sub', text: `A change to how the limit is split is waiting on ${m.rows.length === 1 ? 'it' : 'them'}.` }) : null,
    m.incomplete ? el('p', { class: 'need-sub', text: 'Some computers could not be checked.' }) : null,
    el('div', { class: 'confirm-row' }, dismiss), status,
    el('ul', { class: 'silent-computer-list' }, m.rows.map(r => el('li', {},
      el('strong', { text: r.name }), ' ',
      r.confirmedGone ? el('span', { class: 'mchip', text: 'Confirmed gone for good' }) : null,
      el('p', { class: 'row-sub', text: r.confirmedGone ? 'Use your phone if you want to retire it.' : 'Finish your choice on your phone.' }),
      el('p', { class: 'row-sub', text: r.silentSince
        ? `Last contact: ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(r.silentSince))}`
        : 'Last contact time is unavailable.' })))));
}

