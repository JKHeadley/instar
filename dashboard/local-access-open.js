// The exchange page script for the one-time local link (docs/specs/identity-security-piece1a-local-link.md §4).
// Served from /local-access/v1/open.js under a strict CSP. Reads the link's fragment into memory,
// clears it from the address bar, redeems the ticket with a fresh non-extractable key, saves the
// credential and goes to the dashboard. A lost response is retried here with the same key; after a
// reload the secret is gone and the person runs `instar dashboard open` again.
import { generateDeviceKey, sha256Hex, signText } from '/dashboard/console/browser-device.js';
import { saveCredential } from '/dashboard/local-access.js';

const PREFIX = '/local-access/v1';
const status = (text) => { const el = document.getElementById('status'); if (el) el.textContent = text; };

async function post(path, body) {
  const r = await fetch(PREFIX + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', body: JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { ok: r.ok, status: r.status, data };
}

async function run() {
  const frag = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const dot = frag.indexOf('.');
  if (dot < 1) { status('This link is incomplete. Run "instar dashboard open" on this computer for a new one.'); return; }
  const ticketId = frag.slice(0, dot);
  const secret = frag.slice(dot + 1);
  const { keyPair, publicKey } = await generateDeviceKey();
  const secretProof = await sha256Hex(`instar-local-challenge-v1\n${secret}`);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const ch = await post('/challenge', { ticketId, secretProof, publicKey });
      if (!ch.ok) {
        const why = ch.data && ch.data.error;
        status(why === 'expired' || why === 'revoked' || why === 'unknown-ticket'
          ? 'This link has expired or was replaced. Run "instar dashboard open" on this computer for a new one.'
          : 'This link could not be used. Run "instar dashboard open" on this computer for a new one.');
        return;
      }
      const name = String(ch.data.agentName || '');
      const text = `instar-local-exchange-v1\n${name}\n${ticketId}\n${ch.data.challenge}\n${location.origin}`;
      const ex = await post('/exchange', { ticketId, secret, publicKey, challenge: ch.data.challenge, signature: await signText(keyPair.privateKey, text) });
      if (!ex.ok) { status('This link could not be used. Run "instar dashboard open" on this computer for a new one.'); return; }
      await saveCredential({ credentialId: ex.data.credentialId, expiresAt: ex.data.expiresAt, privateKey: keyPair.privateKey, publicKey, origin: location.origin, agentName: name });
      status('Done. Opening the dashboard…');
      location.replace('/dashboard/');
      return;
    } catch {
      // A lost response: try again with the same key while this page still holds the secret.
      status('Retrying…');
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  status('The agent did not answer. Run "instar dashboard open" on this computer for a new one.');
}

run();
