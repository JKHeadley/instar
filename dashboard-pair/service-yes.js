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
  'too-many-pages': 'This page has been opened too many times in a short while. Nothing changed. Wait a minute, then open it again.',
  'recommended-services-unavailable': 'I can’t save a choice on this machine right now. Nothing changed.',
  'cannot-reach-you': 'This machine can’t message you right now, so it can’t take a yes: setting up means talking to you. Nothing changed. A no still works here. Try again in a little while, or from the machine that answers your messages.',
};

const REASONS = [['none', 'No particular reason'], ['cost', 'The cost'], ['privacy', 'Privacy'], ['not-needed', 'I don’t need it'], ['have-another', 'I use something else'], ['other', 'Something else']];

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = v;
    else if (k === 'class') n.className = v;
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
  const button = el('button', { class: 'pair-button', type: 'button', text: `Yes, set up ${d.name}` });
  const reason = el('select', { 'aria-label': 'Why not? This is optional.' },
    ...REASONS.map(([value, text]) => el('option', { value, text })));
  const noButton = el('button', { class: 'pair-link-button', type: 'button', text: d.workingHere ? `No, I don’t want ${d.name}` : `No, don’t set up ${d.name}` });
  // Only where this machine's own setup made the service work: a no can also switch it off here. Unticked by
  // default, so a no alone changes nothing that runs. A service the person already had is theirs to switch off.
  const switchOff = d.switchOffHere ? el('input', { type: 'checkbox', id: 'switch-off' }) : null;
  const send = async (answer) => {
    error.textContent = '';
    button.disabled = true;
    noButton.disabled = true;
    try {
      const r = await fetch(`/recommended-services/${encodeURIComponent(service)}/confirm`, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Instar-Request': '1' },
        body: JSON.stringify({ token: d.token, pin: pin.value, answer, reason: answer === 'no' ? reason.value : 'none', shutdown: answer === 'no' && !!(switchOff && switchOff.checked) }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok && answer === 'no') {
        const again = `I won’t set up ${d.name} or bring it up again, unless a real problem comes up that it would help with, something changes that matters to you, or a long time has passed and there’s good reason to think you’d answer differently.`;
        message('Got it', body.switchingOff
          ? `${again} I’m switching it off on this machine now, and I’ll tell you when that’s done.`
          : `${again} ${d.switchOffHere ? 'It stays on here, since you didn’t ask me to switch it off.' : d.workingHere ? `I’ll stop relying on ${d.name} here; it stays on, as it was yours before.` : 'If it’s already running, it stays on until you ask me to stop it.'}`);
        return;
      }
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
      noButton.disabled = false;
    }
  };
  noButton.addEventListener('click', () => send('no'));
  button.addEventListener('click', () => send('yes'));
  // Enter does nothing: someone typing their PIN to say no must never record a yes by pressing Go.
  // Where this machine can't message the person, the yes button is replaced by the reason, and the no still works.
  const form = el('form', { class: 'pair-pin', onsubmit: (e) => e.preventDefault() }, pin, error,
    d.canSetUp === false ? el('p', { class: 'pair-hint', role: 'status', text: REFUSED['cannot-reach-you'] }) : button);
  show(
    el('div', { class: 'pair-head' }, el('h1', { text: `Set up ${d.name}?` })),
    line('What you get', d.benefit),
    line('What leaves this machine', d.dataLeaves),
    line('Cost', d.cost),
    line('Account', d.account),
    el('section', {}, el('h2', { text: 'Whose accounts' }), el('p', { text: 'I can fully manage your own accounts, use accounts of my own, or both. That’s your choice, and you can tell me in chat.' })),
    line('If you say no', d.backup || 'There’s no backup yet.'),
    // A service that keeps a copy of the agent's secrets names what it would copy. Names only; values never reach a page.
    Array.isArray(d.copies) ? el('section', {}, el('h2', { text: 'What gets copied' }), el('p', { text: d.copies.length
      ? `A copy of ${d.copies.length} stored secret${d.copies.length === 1 ? '' : 's'}, by name: ${d.copies.join(', ')}. Only the names are shown here; the values go straight from this machine to your vault.`
      : 'Nothing yet: this agent has no stored secrets to copy. New ones are copied as they appear.' })) : null,
    el('section', {}, el('h2', { text: 'After you say yes' }), el('p', { text: 'Setup is my job. I’ll only ask you for a decision, such as a payment, or a credential.' })),
    form,
    el('section', {}, el('h2', { text: d.canSetUp === false ? 'Say no' : 'Or say no' }),
      el('p', { class: 'pair-hint', text: d.switchOffHere
        ? `Type your PIN above first. The reason is optional. Saying no stops me offering this. ${d.name} is working on this machine; it stays on unless you also tick the box.`
        : d.workingHere
          ? `Type your PIN above first. The reason is optional. Saying no stops me offering this, and I’ll stop relying on ${d.name} here. It was already yours before I set anything up, so switching it off is yours to do.`
          : 'Type your PIN above first. The reason is optional. Saying no stops me setting this up or offering it. If it’s already running, it stays on until you ask me to stop it.' }),
      reason,
      switchOff ? el('label', { class: 'pair-hint', for: 'switch-off' }, switchOff, el('span', { text: ` Also switch ${d.name} off on this machine` })) : null,
      noButton),
    el('p', { class: 'pair-hint', text: 'If you’re not sure yet, just close this page. Nothing changes.' }),
  );
}

async function start() {
  try {
    const r = await fetch(`/recommended-services/${encodeURIComponent(service)}/confirm`, { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.token) { page(d); return; }
    // Without a token nothing can be confirmed. "cannot-reach-you" never comes from opening the page: the page is still served so a no can be given.
    message('This can’t be set up right now', REFUSED[d.error] || 'Something went wrong on my side. Nothing changed.');
  } catch {
    message('This can’t be set up right now', 'I couldn’t reach your agent. Nothing changed.');
  }
}

start();
