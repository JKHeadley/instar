// Ecosystem ideas page (docs/specs/ecosystem-idea-pipeline.md §9). Advice only: it builds nothing.
// Every value is written with textContent via el(). Decisions go through the PIN plan and commit.

import { el, pageHead, cantTell, askPin, note } from './ui.js';
import { BANDS, ideasInBand, headline, funnelLine, admissionLine, classWords, projectLine, planRequest } from './ideas-model.js';

let probeResult = null;

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

async function send(path, body) {
  const headers = { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json', 'X-Instar-Request': '1' };
  try {
    const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch { return { status: 0, data: {} }; }
}

/** Render the server's own wording, then spend the PIN on exactly that. */
async function decide(request, status, refresh) {
  status.textContent = 'Working…';
  const planned = await send('/ecosystem-ideas/plan', request);
  if (planned.status !== 200) { status.textContent = planned.data.detail || planned.data.error || 'That could not be prepared.'; return; }
  const pin = await askPin({ title: 'Confirm', explain: planned.data.renderedText });
  if (!pin) { status.textContent = ''; return; }
  const done = await send('/ecosystem-ideas/commit', { pin: pin.pin, planId: planned.data.planId, nonce: planned.data.nonce });
  pin.pin = '';
  status.textContent = done.status === 200 ? 'Done.' : (done.data.error || 'That did not go through.');
  if (done.status === 200) setTimeout(refresh, 600);
}

function ideaCard(idea, refresh) {
  const status = el('p', { class: 'card-note', role: 'status' });
  const button = (label, action, extra) => {
    const b = el('button', { class: 'btn-inline', type: 'button', text: label });
    b.addEventListener('click', () => decide(planRequest(action, idea, extra), status, refresh));
    return b;
  };
  const actions = idea.band === 'stopped' && idea.declined ? [] : [button('Start a spec', 'start-spec'), button('Decline', 'decline'), button('Later', 'later')];
  return el('div', { class: 'need-card' },
    el('span', { class: 'need-title', text: idea.claim }),
    el('p', { class: 'card-note', text: `From ${idea.project}. ${idea.bandReason}.` }),
    el('p', { class: 'card-note', text: classWords(idea.effectClass) }),
    idea.goal ? el('p', { class: 'card-note', text: `A model's reading, not a measurement. Cost of not adopting: ${idea.goal.costOfNotAdopting}` }) : null,
    el('div', { class: 'need-actions' }, actions),
    status);
}

export async function renderIdeas(main, api) {
  const refresh = () => renderIdeas(main, api);
  const r = await api.get('/ecosystem-ideas?scope=pool', 12_000);
  if (!r.ok) {
    main.replaceChildren(r.reason === 'switched off on this agent'
      ? el('section', {}, el('div', { class: 'eyebrow', text: 'Ideas' }), el('h1', { text: 'The idea review is not switched on for this agent.' }))
      : cantTell(r.reason));
    return;
  }
  const s = r.data;
  const parts = [
    pageHead({ eyebrow: 'Ideas', headline: headline(s), sub: 'A weekly look at similar projects. Advice only: nothing here changes any agent.' }),
    el('p', { text: funnelLine(s.funnel) }),
    el('p', { class: 'card-note', text: admissionLine(s.admission) }),
  ];
  for (const band of BANDS) {
    const ideas = ideasInBand(s.ideas, band.id);
    if (!ideas.length) continue;
    parts.push(el('h2', { class: 'eyebrow section-label', text: `${band.label} (${ideas.length})` }), el('p', { class: 'card-note', text: band.note }), ...ideas.map((i) => ideaCard(i, refresh)));
  }
  parts.push(el('h2', { class: 'eyebrow section-label', text: 'Projects we review' }));
  for (const w of s.watchlist) {
    const status = el('p', { class: 'card-note', role: 'status' });
    const row = [el('span', { class: 'need-title', text: w.repo }), el('p', { class: 'card-note', text: projectLine(w) })];
    if (w.stalled) {
      const retry = el('button', { class: 'btn-inline', type: 'button', text: 'Try again' });
      retry.addEventListener('click', async () => { const d = await send('/ecosystem-ideas/projects/retry', { repo: w.repo }); status.textContent = d.status === 200 ? 'It will try at the next round.' : 'That did not go through.'; });
      row.push(retry);
    }
    parts.push(el('div', { class: 'need-card' }, row, status));
  }
  for (const p of s.proposals) {
    const status = el('p', { class: 'card-note', role: 'status' });
    const add = el('button', { class: 'btn-inline', type: 'button', text: 'Add to the list' });
    add.addEventListener('click', () => decide({ action: 'watchlist-add', repo: p.repo, reason: p.reason }, status, refresh));
    parts.push(el('div', { class: 'need-card' }, el('span', { class: 'need-title', text: `Suggested: ${p.repo}` }), el('p', { class: 'card-note', text: p.reason }), add, status));
  }
  if (s.lastTickError) parts.push(note(`The last round had a problem: ${s.lastTickError}`));
  main.replaceChildren(...parts);
}

export function ideasTile(get) {
  const a = el('a', { class: 'tile', href: '#/work/ideas' },
    el('span', { class: 't-icon', icon: 'layers' }),
    el('span', {}, el('span', { class: 't-name', text: 'Ideas from other projects' }),
      el('span', { class: 't-desc', text: 'What a weekly look at similar projects found, ranked.' })));
  const host = el('div', { class: 'tiles', hidden: true }, a);
  if (!probeResult) probeResult = get('/ecosystem-ideas').then((r) => r.ok).catch(() => false);
  probeResult.then((ok) => { host.hidden = !ok; });
  return host;
}
