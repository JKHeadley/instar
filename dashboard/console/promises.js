// Promises page (docs/specs/console-features/work.md, "Commitments → Promises").
// Read with Home's rules; actions use the bearer token only (no PIN on these routes).

import { buildPromisesPage, storyOf, actionsFor } from './promises-model.js';
import { el, setKids, pageHead, section, sheet, closeSheet, sheetIsOpen, story, details, actionButton, note, cantTell, fold } from './ui.js';
import { legacyHref } from './nav-model.js';

const RAW_KEYS = ['id', 'status', 'owner', 'blockedOn', 'actionClass', 'topicId', 'createdAt', 'nextUpdateDueAt', 'hardDeadlineAt', 'checkInAt', 'lastHeartbeatAt', 'heartbeatCount', 'cadenceMs', 'beaconEnabled', 'beaconPaused', 'beaconPausedReason', 'resolvedAt', 'resolution', 'originMachineId', 'viewSource', 'stalenessMs'];

/** Telegram link to a topic in the agent's main group, when we know the group. */
export function topicLink(chatId, topicId) {
  if (!chatId || !Number.isFinite(Number(topicId)) || Number(topicId) <= 1 || Number(topicId) >= 1e10) return null;
  const c = String(chatId).replace(/^-100/, '');
  return /^\d+$/.test(c) ? `https://t.me/c/${c}/${Number(topicId)}` : null;
}

export async function renderPromises(main, ctx) {
  const { get, post } = ctx;
  setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Work · Promises' }), el('h1', { class: 'page-title skeleton', text: 'Loading promises' })));
  const [res, pool] = await Promise.all([get('/commitments?scope=mesh', 8000), get('/pool')]);
  const machines = pool.ok && Array.isArray(pool.data && pool.data.machines) ? pool.data.machines : [];
  const names = Object.fromEntries(machines.map((m) => [m.machineId, m.nickname || m.machineId]));
  const selfId = pool.ok && pool.data ? pool.data.selfMachineId : null;
  const self = machines.find((m) => m.isSelf || (selfId && m.machineId === selfId)) || {};
  const chatId = self.servesChannels && self.servesChannels.telegram && (self.servesChannels.telegram.chatIds || [])[0];
  const peers = pool.ok ? machines.filter((m) => !(m.isSelf || (selfId && m.machineId === selfId))).length : null;
  const page = buildPromisesPage(res, Date.now(), { expectedPeers: peers, names });

  if (!page.ok) { setKids(main, pageHead({ eyebrow: 'Work · Promises', headline: 'Promises', tone: 'muted' }), cantTell(page.reason), legacyLink()); return; }
  const { sections: s, counts: n } = page;

  const open = (r) => openPromise(r, { post, chatId, names, refresh: () => renderPromises(main, ctx) });
  setKids(main, 
    pageHead({
      eyebrow: 'Work · Promises', headline: page.headline, sub: page.sub, tone: page.tone,
      facts: [
        { n: n.waiting, label: 'waiting on you', tone: n.waiting ? 'attn' : null, href: '#/work/promises?s=waiting' },
        { n: n.missed, label: 'missed', tone: n.missed ? 'bad' : null, href: '#/work/promises?s=missed' },
        { n: n.dueSoon, label: 'due within a day', href: '#/work/promises?s=dueSoon' },
        { n: n.carrying + n.dueSoon, label: 'I’m carrying', href: '#/work/promises?s=carrying' },
      ],
    }),
    el('div', { class: 'page-sections' },
      section({ id: 'waiting', title: 'Waiting on you', rows: s.waiting.map((r) => ({ ...r, tone: 'attn' })), empty: 'Nothing is waiting on you.', onRow: open }),
      n.missed ? section({ id: 'missed', title: 'Missed', rows: s.missed.map((r) => ({ ...r, tone: 'bad' })), onRow: open }) : null,
      section({ id: 'dueSoon', title: 'Due within a day', rows: s.dueSoon, empty: 'Nothing is due in the next day.', onRow: open }),
      section({ id: 'carrying', title: 'I’m carrying', rows: s.carrying, collapsed: true, onRow: open }),
      section({ id: 'handled', title: 'Older, still open', rows: s.handled.map((r) => ({ ...r, tone: 'unknown' })), collapsed: true, onRow: open }),
      section({ id: 'closed', title: 'Closed this week', rows: s.closed, collapsed: true, onRow: open }),
    ),
    // Which machines this view covers is housekeeping: one tap deeper, never on the face.
    page.coverage ? fold('Details', note(page.coverage)) : null,
    legacyLink(),
  );
  // A fact links to its section: open it and scroll there.
  const want = new URLSearchParams((location.hash.split('?')[1] || '')).get('s');
  if (want) {
    const sec = main.querySelector(`#sec-${want}`);
    const head = sec && sec.querySelector('button.list-head[aria-expanded="false"]');
    if (head) head.click();
    if (sec) sec.scrollIntoView({ block: 'start' });
  }
}

function legacyLink() {
  return el('p', { class: 'foot-note' }, el('a', { href: legacyHref('commitments'), text: 'Open promises in the legacy dashboard' }));
}

function openPromise(r, { post, chatId, names, refresh }) {
  const c = r.record;
  const acts = actionsFor(c);
  const link = topicLink(chatId, c.topicId);
  const blocks = [story(storyOf(c, Date.now(), names))];
  const row = el('div', { class: 'sheet-actions' });
  if (link) row.append(el('a', { class: 'btn-primary btn-inline', href: link, target: '_blank', rel: 'noopener', text: 'Open the conversation' }));
  const q = r.replica && r.origin ? `?origin=${encodeURIComponent(r.origin)}` : '';
  const id = encodeURIComponent(c.id);
  const result = async (path, body) => {
    const x = await post(`/commitments/${id}/${path}${q}`, body);
    if (x.ok) return { ok: true, message: path === 'deliver' ? 'Marked as done.' : path === 'withdraw' ? 'Dropped.' : 'Reminders resumed.' };
    return { ok: false, message: x.reason };
  };
  if (acts.includes('deliver')) row.append(actionButton({ label: 'Mark as done', kind: link ? 'quiet' : 'primary', confirm: 'Mark this promise as done?', run: () => result('deliver', {}), done: () => setTimeout(() => { closeSheet(); refresh(); }, 700) }));
  if (acts.includes('resume')) row.append(actionButton({ label: 'Resume reminders', kind: 'quiet', run: () => result('resume', {}), done: refresh }));
  blocks.push(row);
  if (acts.includes('withdraw')) {
    blocks.push(el('div', { class: 'sheet-danger' }, actionButton({
      label: 'Drop this promise', kind: 'danger-quiet', confirm: 'Drop this promise? It closes without being done, and the reason is kept with it.',
      reason: 'Why it no longer matters', run: (why) => result('withdraw', { reason: why }), done: () => setTimeout(() => { closeSheet(); refresh(); }, 700),
    })));
  }
  blocks.push(details(c, RAW_KEYS));
  sheet({ title: r.main.length > 70 ? r.main.slice(0, 68) + '…' : r.main }, ...blocks);
}

export { sheetIsOpen };
