import type { ClientHttp2Session } from 'node:http2';
import { normalizeHostedRelayHostname } from './clientHello.js';
import type { createHostedRelayVerifiedDialer } from './verifiedDialer.js';

const maxReceiptBytes = 512;

export interface HostedRelaySetupReceipt {
  readonly kind: 'relay-locator';
  readonly hostname: string;
  readonly origin: string;
}

function readLocator(session: ClientHttp2Session, code: string, domain: string, signal: AbortSignal):
  Promise<HostedRelaySetupReceipt | undefined> {
  return new Promise(resolve => {
    if (signal.aborted || session.closed || session.destroyed) { resolve(undefined); return; }
    const stream = session.request({ ':method': 'POST', ':path': '/relay/v1/rendezvous/redeem',
      'content-type': 'application/json' }, { endStream: false });
    const chunks: Buffer[] = [];
    let length = 0, accepted = false, finished = false;
    function finish(receipt?: HostedRelaySetupReceipt) {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      for (const chunk of chunks) chunk.fill(0);
      if (!stream.closed && !stream.destroyed) stream.destroy();
      resolve(receipt);
    }
    function abort() { finish(); }
    signal.addEventListener('abort', abort, { once: true });
    stream.on('error', abort);
    stream.once('close', abort);
    stream.once('response', headers => {
      accepted = headers[':status'] === 200 && headers['content-type'] === 'application/json'
        && headers['cache-control'] === 'no-store';
      if (!accepted) finish();
    });
    stream.on('data', (chunk: Buffer) => {
      if (finished) return;
      if (!accepted || length + chunk.length > maxReceiptBytes) { finish(); return; }
      length += chunk.length;
      chunks.push(chunk);
    });
    stream.once('end', () => {
      if (finished || !accepted) { finish(); return; }
      const body = Buffer.concat(chunks, length);
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
          || !Object.hasOwn(value, 'hostname') || typeof value.hostname !== 'string' || normalizeHostedRelayHostname(value.hostname) !== value.hostname
          || !value.hostname.endsWith('.' + domain)) { finish(); return; }
        const label = value.hostname.slice(0, -(domain.length + 1));
        if (!label || label.includes('.')) { finish(); return; }
        finish(Object.freeze({ kind: 'relay-locator', hostname: value.hostname, origin: 'https://' + value.hostname }));
      } catch { finish(); } // @silent-fallback-ok — malformed locators never reach pairing
      finally { body.fill(0); }
    });
    stream.end(JSON.stringify({ code }));
  });
}

/** Redeem one locator over a verified, dedicated relay connection. The returned
 * origin is a candidate for independent owner and agent identity verification. */
export async function redeemHostedRelaySetupCode(options: {
  code: string;
  routingDomain: string;
  connectVerified: ReturnType<typeof createHostedRelayVerifiedDialer>;
  signal: AbortSignal;
}): Promise<HostedRelaySetupReceipt | undefined> {
  const { code, routingDomain, signal } = options;
  if (signal.aborted || typeof code !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(code)
    || typeof routingDomain !== 'string' || normalizeHostedRelayHostname(routingDomain) !== routingDomain) return undefined;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  let connection: Awaited<ReturnType<typeof options.connectVerified>> | undefined;
  try {
    connection = await options.connectVerified(deadline);
    return await readLocator(connection.session, code, routingDomain, deadline);
  } catch { return undefined; } // @silent-fallback-ok — failed redemption has no setup authority
  finally {
    connection?.session.destroy();
    await connection?.closed;
  }
}
