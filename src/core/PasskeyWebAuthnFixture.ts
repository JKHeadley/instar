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
      // ── Redacted page-class fixtures (spec §3.6 / §8 "page-class ordering fixtures").
      // Each page carries the STRUCTURE of one closed Google page AND prose the parent
      // text-regex chain would classify differently, so a match here proves the
      // structural layer runs first. No identities, no real copy beyond the markers.
      case '/parent-chain':
        // No structural class here: the parent prose/selector chain must answer (`email`).
        return send(200, page(`<input type="email" autocomplete="username"><button>Next</button>`));
      case '/v3/signin/identifier':
        return send(200, page(`<p>enter a verification code</p><input type="text" id="identifierId" name="identifier"><button>Next</button>`));
      case '/v3/signin/challenge/pk/presend': {
        const v = url.searchParams.get('v') ?? '';
        const rejected = v === 'alert' || v === 'throttled';
        // The rejection states show the alert and LOSE the prompt's own Continue control.
        const alert = rejected ? '<div role="alert">something went wrong</div>' : '';
        const again = v === 'throttled' ? '<button>Try again later</button>' : '';
        const cont = rejected ? '' : '<button id="continue" onclick="document.getElementById(\'picked\').textContent=\'continue\'">Continue</button>';
        // A HIDDEN dialog + a hidden "Not now": present in the DOM, never rendered — must not count.
        return send(200, page(`<p>use your passkey, or enter your password or a verification code</p>${alert}
          <div role="dialog" style="display:none"><button>Not now</button></div>
          ${cont}${again}
          <a href="#" onclick="document.getElementById('picked').textContent='another'">Try another way</a><span id="picked">none</span>`));
      }
      case '/v3/signin/challenge/totp':
        return send(200, page(`<p>choose an account</p><input type="tel" id="totpPin" name="totpPin"><button>Next</button>`));
      case '/v3/signin/challenge/bc':
        return send(200, page(`<p>choose an account</p><input type="tel" id="backupCodePin" name="backupCodePin"><button>Next</button>`));
      case '/v3/signin/challenge/recaptcha':
        return send(200, page(`<div class="g-recaptcha" data-sitekey="fixture"></div><input type="password"><button>Next</button>`));
      case '/speedbump/passkeyenrollment': {
        const confirm = url.searchParams.get('v') === 'confirm';
        return send(200, page(`<p>enter your password</p>${confirm ? '<div role="dialog"><button>Continue</button></div>' : ''}
          <button onclick="document.getElementById('picked').textContent='create'">Create a passkey</button>
          <button onclick="document.getElementById('picked').textContent='not-now'">Not now</button><span id="picked">none</span>`));
      }
      case '/signinoptions/passkeys': {
        const v = url.searchParams.get('v') ?? 'list';
        const body = v === 'create' ? '<button>Create a passkey</button>'
          : v === 'confirm' ? '<div role="dialog"><button>Continue</button></div><button>Create a passkey</button>'
          : v === 'done' ? '<div role="dialog"><button>Done</button></div>'
          : v === 'blocked' ? '<div role="alert">passkeys are not enabled here</div><a href="https://support.google.com/a/answer/0">Learn more</a>'
          : '<ul><li>a passkey</li></ul>';
        return send(200, page(`<p>enter your password</p>${body}`));
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
    policy: { holderOrigin, apexHost: RP_ID, allowInsecure: true, accountOrigin: otherOrigin },
    close: async () => {
      await Promise.all([
        new Promise<void>((r) => holder.close(() => r())),
        new Promise<void>((r) => other.close(() => r())),
      ]);
    },
  };
}
