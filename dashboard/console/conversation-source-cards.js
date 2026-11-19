import { el, setKids } from './ui.js';

function stamp(value) {
  if (value === null) return 'empty';
  if (!value || !Number.isSafeInteger(value.physical) || !Number.isSafeInteger(value.logical) || typeof value.node !== 'string') return null;
  return JSON.stringify([value.physical, value.logical, value.node]);
}

/** A small, owner-only projection alongside original history. No inferred card associations. */
export async function mountSourceCards({ host, key, read, current, unlock }) {
  let cards = [], total = 0, nextPage = null, version = null, revision = null, expanded = false, behind = false;
  let loading = false, error = '', stale = false, retryPage = 0, sequence = 0;
  const draw = () => {
    if (!current()) return;
    const content = [el('h2', { class: 'eyebrow section-label', text: 'Cards from this conversation' })];
    if (behind) content.push(el('p', { class: 'need-sub', role: 'status', text: 'This copy is catching up. Some cards may be missing or out of date.' }));
    for (const card of expanded ? cards : cards.slice(0, 3)) {
      content.push(el('a', { class: 'row conversation-row', href: `#/work/board?card=${encodeURIComponent(card.id)}` },
        el('span', { class: 'row-main' }, el('strong', { class: 'row-title', text: card.title }), el('p', { class: 'need-sub', text: card.needLine })),
        el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })));
    }
    if (cards.length && total > 3) content.push(el('button', { type: 'button', class: 'btn-quiet btn-inline',
      text: expanded ? 'Show fewer' : `Show ${Math.min(cards.length, total) - 3} more here`,
      'aria-expanded': String(expanded), onclick: () => { expanded = !expanded; draw(); } }));
    if (cards.length) content.push(el('p', { class: 'need-sub', text: `${expanded ? cards.length : Math.min(3, cards.length)} of ${total} cards shown${stale ? ' · may be out of date' : ''}` }));
    if (!loading && !error && !stale && !cards.length && !behind) content.push(el('p', { class: 'need-sub', text: 'No cards are available from this conversation.' }));
    if (loading) content.push(el('p', { class: 'need-sub', role: 'status', text: 'Loading cards…' }));
    if (stale) content.push(el('p', { class: 'need-sub', role: 'status', text: 'The cards changed while you were reading. Reload to see the current list.' }));
    if (error) content.push(el('p', { class: 'need-sub', role: 'status', text: error }));
    if (!loading && (stale || error)) content.push(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: stale ? 'Reload cards' : 'Try again', onclick: () => load(stale ? 0 : retryPage) }));
    if (!loading && !error && !stale && expanded && nextPage !== null) content.push(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Load more cards', onclick: () => load(nextPage) }));
    setKids(host, ...content);
  };
  const load = async page => {
    const run = ++sequence;
    loading = true; error = ''; retryPage = page; draw();
    const result = await read(`/work-board?sourceConversationKey=${encodeURIComponent(key)}&sourcePage=${page}`);
    if (!current() || run !== sequence) return;
    loading = false;
    if (result.needsUnlock) { unlock(); return; }
    if (!result.ok) {
      if (result.status === 503 && result.data?.error === 'work-board-disabled') { setKids(host); return; }
      error = 'Cards could not be loaded.'; draw(); return;
    }
    const data = result.data;
    const newVersion = stamp(data?.newestHlc);
    const valid = data && Array.isArray(data.cards) && data.cards.length <= 50 && Number.isSafeInteger(data.total) && data.total >= data.cards.length
      && (data.nextPage === null || data.nextPage === page + 1) && newVersion !== null
      && typeof data.sourceRevision === 'string' && /^[a-f0-9]{64}$/.test(data.sourceRevision)
      && data.cards.every(card => card && typeof card.id === 'string' && /^wc_[a-f0-9]{16}$/.test(card.id)
        && typeof card.title === 'string' && typeof card.needLine === 'string' && !card.removed && card.source?.conversationKey === key);
    if (!valid) { error = 'The card list could not be read.'; draw(); return; }
    if (page > 0 && (newVersion !== version || data.sourceRevision !== revision || data.total !== total)) { stale = true; draw(); return; }
    const combined = page === 0 ? data.cards : [...cards, ...data.cards];
    if (new Set(combined.map(card => card.id)).size !== combined.length || combined.length > data.total
      || (data.nextPage !== null && data.cards.length !== 50) || (data.nextPage === null && combined.length !== data.total)) {
      error = 'The card list could not be read.'; draw(); return;
    }
    cards = combined; total = data.total; nextPage = data.nextPage; version = newVersion; revision = data.sourceRevision;
    behind = !!data.behind; stale = false; draw();
  };
  await load(0);
}
