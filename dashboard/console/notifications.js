import { renderGlance } from '../glance.js';
import { el, setKids, pageHead, section, note, askPin, operatorSession, arrivalScroll } from './ui.js';

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${localStorage.getItem('instar_token') || ''}`,
    'Content-Type': 'application/json', ...(operatorSession() ? { 'X-Instar-Operator-Session': operatorSession() } : {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Notifications are unavailable. Try again.');
  return data;
}
export function notificationsGlanceSpec(feed, activate = {}) {
  return { headline: feed.unavailable?.length ? 'Some machines did not answer. Open notices to review what is available.'
    : feed.unread > 0 ? 'Quiet reports are waiting for you to review.' : 'No unread reports from the machines that answered.',
    tiles: [
      { key: 'notices', label: 'Unread notices', value: String(feed.unread), onActivate: activate.notices },
      { key: 'preferences', label: 'Push choices', value: 'Review', onActivate: activate.preferences },
    ] };
}
/** All server/peer text is rendered as text, including stored HTML and quoted notices. */
let notificationClick = 0;
let notificationView = { unread: true, cursors: undefined };
export async function renderNotifications(main, ctx, view) {
  if (view) notificationView = view;
  const root = el('section', { class: 'notifications-page', style: 'min-width:0;overflow-wrap:anywhere' });
  const feedback = el('p', { role: 'status', 'aria-live': 'polite' });
  setKids(main, pageHead({ eyebrow: 'People', headline: 'Notifications', sub: 'Quiet reports stay here. Choose the categories you want pushed to you.' }), root);
  root.append(feedback);
  try {
    const query = new URLSearchParams({ scope: 'pool', unread: String(notificationView.unread) });
    if (notificationView.cursors) query.set('cursors', JSON.stringify(notificationView.cursors));
    const [status, feed] = await Promise.all([request('/notifications/selectivity?scope=pool'), request('/notifications/quiet?' + query)]);
    const refresh = () => renderNotifications(main, ctx, { unread: notificationView.unread, cursors: undefined });
    const filter = el('input', { type: 'checkbox', 'aria-label': 'Only unread notices' }); filter.checked = notificationView.unread;
    filter.addEventListener('change', () => renderNotifications(main, ctx, { unread: filter.checked, cursors: undefined }));
    root.append(el('label', { style: 'display:flex;align-items:center;gap:12px;min-height:48px' }, filter, 'Only unread notices'));
    const notices = el('section', {}, el('h2', { text: `${feed.unread} unread notices` }));
    const glance = el('section', { class: 'glance-root' });
    root.append(glance, notices);
    if (feed.unavailable?.length) notices.append(note('Some machines did not answer. Their notices are unknown until they return.'));
    if (!feed.items.length) notices.append(note(notificationView.unread ? 'No unread notices from the machines that answered.' : 'No notices on this page.'));
    for (const item of feed.items) {
      const row = el('article', { class: 'need-card' },
        el('strong', { text: status.categories.find(c => c.id === item.category)?.description || 'Automated notice' }),
        el('p', { text: item.text }), el('small', { text: `${item.count} occurrence${item.count === 1 ? '' : 's'} · ${new Date(item.updatedAt).toLocaleString()}` }));
      row.append(el('button', { class: 'btn-secondary', style: 'min-height:44px', type: 'button', text: 'Mark read', onclick: async () => {
        try { await request(`/notifications/quiet/${encodeURIComponent(item.id)}?machineId=${encodeURIComponent(item.machineId)}`, { method: 'PATCH', body: '{}' }); await refresh(); }
        catch (error) { feedback.textContent = error.message; }
      } }));
      notices.append(row);
    }
    if (feed.hasMore) notices.append(el('button', { class: 'btn-secondary', style: 'min-height:44px', type: 'button', text: 'Older notices', onclick: () => renderNotifications(main, ctx, { unread: notificationView.unread, cursors: feed.nextCursors }) }));
    if (notificationView.cursors) notices.append(el('button', { class: 'btn-secondary', style: 'min-height:44px', type: 'button', text: 'Newest notices', onclick: refresh }));
    if (status.preferences?.pending) notices.append(note(`Your preference is saved here. ${status.preferences.pending} update(s) are waiting for other machines.`));
    const preferences = el('section', {}, el('h2', { text: 'Choose what reaches you' }), note('Replies and critical recovery notices remain automatic.'));
    root.append(preferences);
    renderGlance(document, glance, notificationsGlanceSpec(feed, {
      notices: () => arrivalScroll(notices, { key: `notifications-click:${++notificationClick}` }),
      preferences: () => arrivalScroll(preferences, { key: `notifications-click:${++notificationClick}` }),
    }));
    const choices = [
      ...status.categories.filter(category => category.configurable !== false).map(category => ({ label: category.description, push: category.push,
        route: `/notifications/categories/${encodeURIComponent(category.id)}/push`, done: on => `Routine ${category.description.toLowerCase()} ${on ? 'will be pushed to you' : 'will stay in the feed'}.` })),
      ...(status.jobs || []).filter(job => job.enabled !== false).map(job => ({ label: `Job: ${job.name}`, push: job.push,
        route: `/notifications/jobs/${encodeURIComponent(job.slug)}/push`, done: on => `Reports from ${job.name} ${on ? 'will be pushed to you' : 'will stay in the feed'}.` })),
    ];
    for (const choice of choices) {
      const input = el('input', { type: 'checkbox', 'aria-label': `Push ${choice.label.toLowerCase()}`, style: 'width:22px;height:22px' });
      input.checked = choice.push;
      const row = el('label', { style: 'display:flex;align-items:center;gap:12px;min-height:48px' }, input,
        el('span', { text: choice.label }));
      input.addEventListener('change', async () => {
        const enabled = input.checked; input.disabled = true;
        try {
          if (!operatorSession()) {
            const granted = await askPin({ title: 'Notification preferences', explain: 'Confirm which reports should reach you.', adapter: 'session' });
            if (!granted) { input.checked = !enabled; return; }
          }
          const result = await request(choice.route, {
            method: 'POST', body: JSON.stringify({ enabled, confirmedBy: 'dashboard-pin' }),
          });
          feedback.textContent = result?.message || choice.done(enabled);
        } catch (error) { input.checked = !enabled; feedback.textContent = error.message; }
        finally { input.disabled = false; }
      });
      preferences.append(row);
    }
    if (status.jobsUnavailable?.length) preferences.append(note('Some machines did not answer. Their jobs are not listed until they return.'));
    root.append(note(status.enabled !== true ? 'Quiet by Default is awaiting its operator enable on this machine.' : status.dryRun ? 'Observation mode: reports are still delivered while the gate is measured.' : 'Quiet by Default is enforcing on this machine.'));
  } catch (error) { feedback.textContent = error.message; }
}
