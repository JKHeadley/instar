// This action only builds a navigation reference. The current web card stays open.
import { el } from './ui.js';

export function checkedCardAppLink(data, cardId) {
  if (!/^wc_[0-9a-f]{16}$/.test(cardId) || typeof data?.url !== 'string') return null;
  const match = /^https:\/\/instar\.sh\/a#v=1&i=([0-9a-f]{64})&t=card&r=(wc_[0-9a-f]{16})$/.exec(data.url);
  if (!match || match[2] !== cardId) return null;
  // Rebuild from checked fields; never navigate to an arbitrary response URL.
  return `https://instar.sh/a#v=1&i=${match[1]}&t=card&r=${cardId}`;
}

export function cardAppLinkControl(cardId, send) {
  const status = el('p', { class: 'need-sub', role: 'status' });
  const box = el('div', { class: 'work-app-link' });
  const button = el('button', { type: 'button', class: 'chip', text: 'Open in Instar', onclick: async () => {
    button.disabled = true;
    status.textContent = 'Getting the app link…';
    let result;
    try { result = await send('/agent-links', { target: 'card', ref: cardId }); } catch { result = null; }
    const url = result?.status === 200 ? checkedCardAppLink(result.data, cardId) : null;
    if (!url) {
      status.textContent = 'The app link is unavailable. You can keep reading this card here.';
      button.disabled = false;
      return;
    }
    button.replaceWith(el('a', { class: 'chip', href: url, rel: 'noopener', text: 'Continue in Instar' }));
    status.textContent = 'Open this card in the app, or keep reading it here. You need your own pairing with this agent.';
  } });
  box.append(button, status);
  return box;
}
