/**
 * PasskeyWebAuthnFixture — a tiny local WebAuthn relying party
 * (spec docs/specs/agent-held-google-passkey.md §2 "Chrome version gate", §8).
 *
 * Two plain HTTP servers on `localhost` (a secure context for WebAuthn) stand in
 * for Google: the HOLDER origin plays accounts.google.com, the OTHER origin plays
 * a different google.com subdomain. Pages call `navigator.credentials.create()` /
 * `.get()` with relying-party id `localhost`, so a browser's virtual authenticator
 * can be exercised end to end with no network and no real account:
 *
 *   - mint a resident credential, export it, inject it into a fresh browser and
 *     assert with it (the portability the whole design depends on);
 *   - prove request-time removal: a top-level move to the OTHER origin, a 302
 *     redirect there, a subframe there, and a popup all lose the credential
 *     before the document request leaves;
 *   - prove attach-before-navigate on popups (the popup's authenticator holds the
 *     credential when its opener did).
 *
 * The same fixture backs the runtime Chrome-version self-check, which is why it
 * lives in src/ rather than tests/.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OriginPolicy } from './PasskeyBrowserPolicy.js';

export interface PasskeyFixture {
  /** Plays accounts.google.com. */
  holderOrigin: string;
  /** Plays another google.com subdomain (same RP apex `localhost`, different port). */
  otherOrigin: string;
  policy: OriginPolicy;
  close(): Promise<void>;
}

const RP_ID = 'localhost';

function page(body: string, title = 'passkey fixture'): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}
<script>
  const enc = (s) => new TextEncoder().encode(s);
  // Standard base64 WITH padding — the exact encoding CDP's WebAuthn domain uses for credentialId.
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  window.__create = async (userName) => {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: ${JSON.stringify(RP_ID)}, name: 'passkey fixture' },
      user: { id: enc(userName), name: userName, displayName: userName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      timeout: 20000,
    }});
    return b64url(cred.rawId);
  };
  window.__get = async () => {
    const a = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: ${JSON.stringify(RP_ID)},
      userVerification: 'required',
      timeout: 20000,
    }});
    return b64url(a.rawId);
  };
</script></body></html>`;
}

function handler(selfOrigin: () => string, otherOrigin: () => string): http.RequestListener {
  return (req, res) => {
    const url = new URL(req.url ?? '/', selfOrigin());
    const send = (status: number, html: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(html);
    };
    switch (url.pathname) {
      case '/':
        return send(200, page(`<h1>holder</h1>
          <button id="btn" onclick="document.getElementById('clicked').textContent='yes'">Click me</button>
          <span id="clicked">no</span>
          <ul><li id="item" onclick="document.getElementById('item-clicked').textContent='yes'">Choose account</li></ul>
          <span id="item-clicked">no</span>`));
      case '/other':
        return send(200, page('<h1>other</h1>'));
      case '/redirect':
        return send(302, '', { location: `${otherOrigin()}/other` });
      case '/with-frame':
        return send(200, page(`<h1>with frame</h1><iframe id="f" src="${otherOrigin()}/other"></iframe>`));
      case '/with-unrelated-frame':
        // 127.0.0.1 is a DIFFERENT host from localhost: outside the RP family.
        return send(200, page(`<h1>unrelated frame</h1><iframe id="f" src="${otherOrigin().replace('localhost', '127.0.0.1')}/other"></iframe>`));
      case '/popup-opener':
        return send(200, page(`<h1>opener</h1><button id="open" onclick="window.open('/popup','pk')">open</button>`));
      case '/popup':
        return send(200, page('<h1>popup</h1>'));
      case '/account': {
        const email = url.searchParams.get('email') ?? '';
        const safe = email.replace(/[<>&"]/g, '');
        return send(200, page(`<h1>account</h1><div data-email="${safe}">${safe}</div>`));
      }
      default:
        return send(404, page('<h1>not found</h1>'));
    }
  };
}

/** Start the two fixture origins on ephemeral ports. */
export async function startPasskeyFixture(): Promise<PasskeyFixture> {
  let holderOrigin = '';
  let otherOrigin = '';
  const holder = http.createServer(handler(() => holderOrigin, () => otherOrigin));
  const other = http.createServer(handler(() => otherOrigin, () => holderOrigin));
  await Promise.all([
    new Promise<void>((r) => holder.listen(0, '127.0.0.1', () => r())),
    new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r())),
  ]);
  holderOrigin = `http://localhost:${(holder.address() as AddressInfo).port}`;
  otherOrigin = `http://localhost:${(other.address() as AddressInfo).port}`;
  return {
    holderOrigin,
    otherOrigin,
    policy: { holderOrigin, apexHost: RP_ID, allowInsecure: true },
    close: async () => {
      await Promise.all([
        new Promise<void>((r) => holder.close(() => r())),
        new Promise<void>((r) => other.close(() => r())),
      ]);
    },
  };
}
