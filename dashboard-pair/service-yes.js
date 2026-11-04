// A recommended service's confirm page (docs/specs/recommended-services.md, Yes). The person reads
// what the service involves and confirms with their PIN. Nothing is stored in the browser.

const root = document.getElementById('pair-root');
const service = new URLSearchParams(location.search).get('service') || '';

const REFUSED = {
  'unknown-service': 'I don’t know that service.',
  'not-available': 'I can’t set this up yet, because I haven’t proven its setup works. Nothing changed.',
  'no-owner': 'I can’t tell who the owner of this agent is yet, so I can’t take a yes here. Nothing changed. Send me a message first, then open this page again.',
  'token-refused': 'This page has expired or was already used. Nothing changed. Open it again to confirm.',
  'text-changed': 'What this service involves has changed since this page opened. Nothing changed. Open it again to read the new version.',
  'no-since-open': 'You said no to this after this page opened, so I haven’t changed anything. Open it again if you’ve changed your mind.',
  'insecure-connection': 'This connection isn’t secure enough to take your PIN. Nothing changed. Open this page through your agent’s secure address.',
  'wrong-owner': 'The owner of this agent changed since this page opened. Nothing changed. Open it again.',
  'wrong-machine': 'This page belongs to a different machine. Nothing changed. Open it again.',
  'recommended-services-unavailable': 'I can’t save a choice on this machine right now. Nothing changed.',
};

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = v;
    else if (k === 'class') n.className = v;
    else if (k === 'onclick') n.addEventListener('click', v);
    else if (k === 'onsubmit') n.addEventListener('submit', v);
    else n.setAttribute(k, v);
  }
  n.append(...kids.filter(Boolean));
  return n;
}

function show(...kids) { root.replaceChildren(...kids); }
function message(title, text) { show(el('div', { class: 'pair-head' }, el('h1', { text: title })), el('p', { text })); }
function line(label, text) { return text ? el('section', {}, el('h2', { text: label }), el('p', { text })) : null; }

function page(d) {
  const error = el('p', { class: 'pair-error', role: 'alert' });
  const pin = el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', 'aria-label': 'Your PIN', placeholder: 'Your PIN' });
  const button = el('button', { class: 'pair-button', type: 'submit', text: `Yes, set up ${d.name}` });
  const form = el('form', { class: 'pair-pin', onsubmit: async (e) => {
    e.preventDefault();
    error.textContent = '';
    button.disabled = true;
    try {
      const r = await fetch(`/recommended-services/${encodeURIComponent(service)}/confirm`, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Instar-Request': '1' },
        body: JSON.stringify({ token: d.token, pin: pin.value }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) {
        message('Thank you', `I’ll set up ${d.name} from here and tell you when it’s working. I’ll only come back to you for a decision or a credential.`);
        return;
      }
      if ((r.status === 403 && body.error !== 'insecure-connection') || r.status === 429) {
        error.textContent = r.status === 429 ? 'Too many tries. Wait a while, then try again.' : 'That PIN didn’t work. Try again.';
        pin.value = '';
        pin.focus();
        return;
      }
      message('That didn’t go through', REFUSED[body.error] || 'Something went wrong on my side. Nothing changed.');
    } catch {
      error.textContent = 'I couldn’t reach your agent. Nothing changed. Try again.';
    } finally {
      button.disabled = false;
    }
  } }, pin, error, button);
  show(
    el('div', { class: 'pair-head' }, el('h1', { text: `Set up ${d.name}?` })),
    line('What you get', d.benefit),
    line('What leaves this machine', d.dataLeaves),
    line('Cost', d.cost),
    line('Account', d.account),
    el('section', {}, el('h2', { text: 'Whose accounts' }), el('p', { text: 'I can fully manage your own accounts, use accounts of my own, or both. That’s your choice, and you can tell me in chat.' })),
    line('If you say no', d.backup || 'There’s no backup yet.'),
    el('section', {}, el('h2', { text: 'After you say yes' }), el('p', { text: 'Setup is my job. I’ll only ask you for a decision, such as a payment, or a credential.' })),
    form,
    el('p', { class: 'pair-hint', text: 'If you’d rather not, just close this page. Nothing changes.' }),
  );
}

async function start() {
  try {
    const r = await fetch(`/recommended-services/${encodeURIComponent(service)}/confirm`, { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.token) { page(d); return; }
    message('This can’t be set up right now', REFUSED[d.error] || 'Something went wrong on my side. Nothing changed.');
  } catch {
    message('This can’t be set up right now', 'I couldn’t reach your agent. Nothing changed.');
  }
}

start();
