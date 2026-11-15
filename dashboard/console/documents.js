// Documents list (docs/specs/instar-document-viewer.md §3.6). The console never renders document
// content: each row links out to the document's own page at /docs/<id>. Text is set with textContent via el().

import { el, pageHead, cantTell, setKids } from './ui.js';

/** "telegram:123" → "Telegram topic 123"; "app:<uuid>" → "App conversation". */
export function conversationWords(ref) {
  if (typeof ref !== 'string') return 'No conversation';
  if (ref.startsWith('telegram:')) return `Telegram topic ${ref.slice(9)}`;
  if (ref.startsWith('app:')) return 'App conversation';
  return 'Conversation';
}

export function rowWords(d) {
  const title = d.title || 'A shared document (only its conversation can read it)';
  const bits = [];
  if (d.version) bits.push(`version ${d.version}`);
  bits.push(d.openComments === 1 ? '1 open comment' : `${d.openComments} open comments`);
  return { title, sub: `${bits.join(', ')} · ${conversationWords(d.primary)}` };
}

export async function renderDocuments(main, api) {
  const r = await api.get('/docs', 12_000);
  if (!r.ok) {
    setKids(main, r.reason === 'switched off on this agent'
      ? el('section', {}, el('div', { class: 'eyebrow', text: 'Documents' }), el('h1', { text: 'Documents are not switched on for this agent.' }))
      : cantTell(r.reason));
    return;
  }
  const docs = Array.isArray(r.data?.documents) ? r.data.documents : [];
  const open = docs.reduce((n, d) => n + (d.openComments || 0), 0);
  const head = pageHead({
    eyebrow: 'Documents',
    headline: docs.length === 0 ? 'No documents yet.' : open > 0 ? `${open} open ${open === 1 ? 'comment' : 'comments'} across ${docs.length} ${docs.length === 1 ? 'document' : 'documents'}.` : `${docs.length} ${docs.length === 1 ? 'document' : 'documents'}, no open comments.`,
    sub: 'Longer writing people comment on. Each opens on its own page, where comments are signed by the person’s own phone or computer.',
  });
  const list = el('div', { class: 'need-list' }, ...docs.map((d) => {
    const w = rowWords(d);
    return el('a', { class: 'need-card', href: `/docs/${encodeURIComponent(d.id)}`, target: '_blank', rel: 'noopener noreferrer' },
      el('span', { class: 'need-title', text: w.title }),
      el('p', { class: 'need-sub', text: w.sub }));
  }));
  setKids(main, head, list);
}
