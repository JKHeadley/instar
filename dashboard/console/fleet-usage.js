import { el, askPin, forgetOperatorSession, setKids } from './ui.js';
import { fmtTokens } from './costs-model.js';

export function fleetUsageSection() {
  const result = el('div', { role: 'status', 'aria-live': 'polite' });
  const button = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Show fleet token usage' });
  const host = el('section', { class: 'usage-section', 'aria-label': 'Fleet token usage' },
    el('h2', { class: 'eyebrow', text: 'Fleet token usage' }), button, result);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const unlock = await askPin({ title: 'Unlock fleet token usage', adapter: 'session', isCurrent: () => host.isConnected });
      if (!host.isConnected || !unlock?.session) return;
      result.textContent = 'Reading token usage from your agents…';
      const response = await fetch('/usage/fleet', {
        headers: { Authorization: `Bearer ${localStorage.getItem('instar_token') || ''}`, 'X-Instar-Operator-Session': unlock.session },
        cache: 'no-store',
      });
      if (response.status === 401 || response.status === 403) {
        forgetOperatorSession();
        result.textContent = 'Your unlock expired. Try again.';
        return;
      }
      if (!response.ok) throw new Error('fleet read failed');
      const data = await response.json();
      setKids(result,
        el('p', { text: data.tokens === null ? 'No agent usage could be read.'
          : `${fmtTokens(data.tokens)} tokens since ${data.since.slice(0, 10)} (UTC)${data.complete ? '' : ' (partial total)'}` }),
        el('ul', {}, ...data.agents.map(row => el('li', { text: row.tokens === null
          ? `${row.label} · Usage unavailable`
          : `${row.label} · ${fmtTokens(row.tokens)} tokens${row.coverage === 'partial' ? ' (partial)' : ''}` }))),
      );
      button.textContent = 'Refresh fleet token usage';
    } catch {
      result.textContent = 'Fleet token usage is temporarily unavailable.';
    } finally {
      button.disabled = false;
    }
  });
  return host;
}
