// Promises page (docs/specs/console-features/work.md, "Commitments → Promises").
// Read with Home's rules; actions use the bearer token only (no PIN on these routes).

import { buildPromisesPage, storyOf, backstoryOf, updateQuestionOf, nextStepOf, actionsFor } from './promises-model.js';
import { isInternalFollowUp } from './home-model.js';
import { promiseActionLinks } from './promise-actions.js';
import { el, setKids, pageHead, section, sheet, closeSheet, sheetIsOpen, story, actionButton, note, cantTell } from './ui.js';
import { legacyHref } from './nav-model.js';

/** Telegram link to a topic in the agent's main group, when we know the group. */
export function topicLink(chatId, topicId) {
  if (!chatId || !Number.isFinite(Number(topicId)) || Number(topicId) <= 1 || Number(topicId) >= 1e10) return null;
  const c = String(chatId).replace(/^-100/, '');
  return /^\d+$/.test(c) ? `https://t.me/c/${c}/${Number(topicId)}` : null;
}

export async function renderPromises(main, ctx) {
  if (main.dataset.promisesLoading === '1') return;
  main.dataset.promisesLoading = '1';
  const { get, post } = ctx;
  setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Work · Promises' }), el('h1', { class: 'page-title skeleton', text: 'Loading promises' })));
  const slow = setTimeout(() => {
    const title = main.querySelector('.page-title.skeleton');
    if (title) title.textContent = 'Still checking promises…';
  }, 3000);
  let res, pool;
  try {
    [res, pool] = await Promise.all([ctx.getCommitments ? ctx.getCommitments() : get('/commitments?scope=mesh', 25000), get('/pool')]);
  } finally {
    clearTimeout(slow);
    main.dataset.promisesLoading = '0';
  }
  const machines = pool.ok && Array.isArray(pool.data && pool.data.machines) ? pool.data.machines : [];
  const names = Object.fromEntries(machines.map((m) => [m.machineId, m.nickname && m.nickname !== m.machineId ? m.nickname : 'another machine']));
  const selfId = pool.ok && pool.data ? pool.data.selfMachineId : null;
  const self = machines.find((m) => m.isSelf || (selfId && m.machineId === selfId)) || {};
  const chatId = self.servesChannels && self.servesChannels.telegram && (self.servesChannels.telegram.chatIds || [])[0];
  const peers = pool.ok ? machines.filter((m) => !(m.isSelf || (selfId && m.machineId === selfId))).length : null;
  const page = buildPromisesPage(res, Date.now(), { expectedPeers: peers, names });

  if (!page.ok) {
    const retrying = !res.ok && !['not signed in', 'switched off on this agent'].includes(res.reason);
    setKids(main, pageHead({ eyebrow: 'Work · Promises', headline: retrying ? 'Still checking promises' : 'Promises',
      sub: retrying ? 'Trying again automatically while this page is open.' : '', tone: 'muted' }), cantTell(page.reason), legacyLink());
    return;
  }
  const { sections: s, counts: n } = page;

  const open = (r) => openPromise(r, { post, chatId, names, refresh: () => renderPromises(main, ctx) });
  setKids(main, 
    pageHead({
      eyebrow: 'Work · Promises', headline: page.headline, sub: page.sub, tone: page.tone,
      facts: n.waiting ? [{ n: n.waiting, label: 'waiting on you', tone: 'attn', href: '#/work/promises?s=waiting' }] : [],
    }),
    page.coverage ? note(page.coverage) : null,
    el('div', { class: 'page-sections' },
      section({ id: 'waiting', title: 'Waiting on you', rows: s.waiting.map((r) => ({ ...r, tone: 'attn' })), empty: 'Nothing is waiting on you.', onRow: open }),
      section({ id: 'carrying', title: 'Echo is handling', rows: s.carrying, collapsed: true, onRow: open }),
      section({ id: 'handled', title: 'Older, still open', rows: s.handled.map((r) => ({ ...r, tone: 'unknown' })), collapsed: true, onRow: open }),
      section({ id: 'closed', title: 'Closed this week', rows: s.closed, collapsed: true, onRow: open }),
    ),
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
  // Home links to a specific request. Open its action sheet on arrival, so a
  // tap never strands the operator at the top of a long promise list.
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  const id = params.get('id');
  const origin = params.get('origin');
  if (id) {
    // Home deep links are action handoffs. A completed request can still appear
    // in Closed this week, but must never reopen as another request for help.
    const request = s.waiting.find((r) => r.id === id && (!origin || r.origin === origin));
    if (request) open(request);
    else clearPromiseDeepLink(id, origin);
  }
}

function clearPromiseDeepLink(id, origin) {
  const [route, query = ''] = location.hash.split('?');
  if (route !== '#/work/promises') return;
  const params = new URLSearchParams(query);
  if (params.get('id') !== id || (params.has('origin') && params.get('origin') !== origin)) return;
  params.delete('id');
  params.delete('origin');
  const rest = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${location.search}${route}${rest ? `?${rest}` : ''}`);
}

function legacyLink() {
  return el('p', { class: 'foot-note' }, el('a', { href: legacyHref('commitments'), text: 'Open promises in the legacy dashboard' }));
}

function openPromise(r, { post, chatId, names, refresh }) {
  const c = r.record;
  const internal = isInternalFollowUp(c);
  const waitsOnYou = c.owner === 'user' || c.blockedOn === 'user-input' || c.blockedOn === 'user-authorization';
  const acts = waitsOnYou ? actionsFor(c) : [];
  const link = topicLink(chatId, c.topicId);
  const now = Date.now();
  const missed = Number.isFinite(Date.parse(c.hardDeadlineAt)) && Date.parse(c.hardDeadlineAt) < now;
  const review = c.status === 'violated' && !missed;
  const blocks = [story(storyOf(c, now, names)),
    el('p', { class: 'sheet-next-step', text: nextStepOf(c, now) })];
  const history = el('details', { class: 'promise-backstory' },
    el('summary', { text: 'How this came about' }),
    story(backstoryOf(c, now)),
    el('p', { class: 'promise-backstory-note', text: link
      ? 'This is the history saved with this promise. The conversation may have more context.'
      : 'This is the history saved with this promise. No source conversation link was recorded.' }),
    link ? el('a', { href: link, target: '_blank', rel: 'noopener', text: 'Read the full conversation' }) : null);
  blocks.push(history);
  const row = el('div', { class: 'sheet-actions' });
  const actionLinks = waitsOnYou ? promiseActionLinks(c) : [];
  for (const action of actionLinks) row.append(el('a', {
    class: `${action.primary ? 'btn-primary' : 'btn-quiet'} btn-inline`, href: action.href,
    target: '_blank', rel: 'noopener', text: action.label,
  }));
  if (link) {
    const question = !waitsOnYou && !internal ? updateQuestionOf(c, now) : null;
    const fallback = question ? el('div', { class: 'promise-question-wrap', hidden: true },
      el('p', { class: 'promise-backstory-note', text: 'Copy this question and paste it in the conversation:' }),
      el('textarea', { class: 'promise-question', readonly: true }, question)) : null;
    if (fallback) blocks.push(fallback);
    row.append(el('a', { class: `${actionLinks.length || !waitsOnYou ? 'btn-quiet' : 'btn-primary'} btn-inline`, href: link,
      target: '_blank', rel: 'noopener', text: waitsOnYou ? 'Reply in the conversation' : internal ? 'View source conversation' : 'Optional: copy a question and open chat',
      onclick: question ? () => {
        // Topic links open the right chat; Telegram does not document a draft
        // parameter for private forum topics. Copy the text for one paste.
        if (fallback) fallback.hidden = false;
        if (window.navigator.clipboard?.writeText) void window.navigator.clipboard.writeText(question).catch(() => {
          if (fallback) fallback.querySelector('p').textContent = 'Copying was blocked. Select this question and paste it in the conversation:';
        });
        else if (fallback) fallback.querySelector('p').textContent = 'Copying is unavailable here. Select this question and paste it in the conversation:';
      } : undefined }));
  }
  const q = r.replica && r.origin ? `?origin=${encodeURIComponent(r.origin)}` : '';
  const id = encodeURIComponent(c.id);
  const result = async (path, body) => {
    const x = await post(`/commitments/${id}/${path}${q}`, body);
    if (x.ok) return { ok: true, message: path === 'deliver' ? 'Marked as done.' : path === 'withdraw' ? 'Dropped.' : 'Reminders resumed.' };
    return { ok: false, message: x.reason };
  };
  if (acts.includes('deliver')) row.append(actionButton({ label: waitsOnYou ? 'I handled this' : 'Mark as done', kind: link ? 'quiet' : 'primary',
    confirm: waitsOnYou ? 'Close this reminder? This does not send a reply or perform the requested approval.' : 'Mark this promise as done?',
    run: () => result('deliver', {}), done: () => setTimeout(() => { closeSheet(); refresh(); }, 700) }));
  if (acts.includes('resume')) row.append(actionButton({ label: 'Resume reminders', kind: 'quiet', run: () => result('resume', {}), done: refresh }));
  blocks.push(row);
  if (acts.includes('withdraw')) {
    blocks.push(el('div', { class: 'sheet-danger' }, actionButton({
      label: 'Drop this promise', kind: 'danger-quiet', confirm: 'Drop this promise? It closes without being done, and the reason is kept with it.',
      reason: 'Why it no longer matters', run: (why) => result('withdraw', { reason: why }), done: () => setTimeout(() => { closeSheet(); refresh(); }, 700),
    })));
  }
  sheet({ title: waitsOnYou ? 'Your response is needed' : 'Echo follow-up',
    onClose: () => clearPromiseDeepLink(c.id, r.origin) }, ...blocks);
}

export { sheetIsOpen };
