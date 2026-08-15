/**
 * THE FORMATTING BOUNDARY — a signature covers BYTES, so any transform between
 * signing and transmission breaks it.
 *
 * Found the hard way. The live round-trip proof for this feature used a
 * PLAIN-TEXT body and reported "sent bytes and recorded bytes are byte-identical,
 * and the recorded copy verifies". Both true — and both guaranteed by the choice
 * of input, because plain text is a FIXED POINT of the Telegram markdown
 * formatter. The control could not have said anything else.
 *
 * A body containing markdown is not a fixed point: `**bold**` becomes `<b>bold</b>`,
 * a link becomes an `<a href>`. The body hash then disagrees and a GENUINE agent
 * message is classified `bad-signature` — a false rejection.
 *
 * These tests pin the boundary so it is enforced rather than remembered, and so
 * anyone wiring automatic outbound signing meets it as a failing test rather
 * than as a mysterious rejection in production.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { signMessage, verifyMessage } from '../../src/core/agentSignatureProvenance.js';
import { formatForTelegram } from '../../src/messaging/TelegramMarkdownFormatter.js';

const AGENT = 'echo';
const TOPIC = 29723;

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(-32),
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).subarray(-32),
  };
}

/** Run text through the real Telegram formatter and return the transmitted text. */
function format(text: string): string {
  const out = formatForTelegram(text as never) as unknown;
  return typeof out === 'string' ? out : ((out as { text?: string }).text ?? String(out));
}

describe('ASP × Telegram formatting — the boundary is real', () => {
  it('a PLAIN-TEXT body survives the formatter and still verifies', () => {
    const { publicKey, privateKey } = keypair();
    const resolvePublicKey = (id: string) => (id === AGENT ? publicKey : null);
    const { text } = signMessage({
      agentId: AGENT, topicId: TOPIC, body: 'a plain sentence with no markup', privateKey,
    });

    const transmitted = format(text);
    expect(transmitted).toBe(text); // plain text is a fixed point
    expect(
      verifyMessage({ raw: transmitted, expectedTopicId: TOPIC, resolvePublicKey }).classification,
    ).toBe('agent-verified');
  });

  it('a MARKDOWN body is rewritten by the formatter and then FAILS verification', () => {
    // This is the defect the plain-text proof could not surface. It is asserted
    // rather than fixed here: the honest position is that signing must happen on
    // the bytes that are actually transmitted, which is a change at the egress
    // boundary, not a tweak to the verifier.
    const { publicKey, privateKey } = keypair();
    const resolvePublicKey = (id: string) => (id === AGENT ? publicKey : null);
    const { text } = signMessage({
      agentId: AGENT,
      topicId: TOPIC,
      body: 'contains **bold** and [a link](https://example.com)',
      privateKey,
    });

    // Before transmission it is valid...
    expect(
      verifyMessage({ raw: text, expectedTopicId: TOPIC, resolvePublicKey }).classification,
    ).toBe('agent-verified');

    // ...and the formatter changes the bytes, so it is no longer valid.
    const transmitted = format(text);
    expect(transmitted).not.toBe(text);
    const verdict = verifyMessage({ raw: transmitted, expectedTopicId: TOPIC, resolvePublicKey });
    expect(verdict.classification).toBe('rejected');
    expect(verdict.classification === 'rejected' && verdict.reason).toBe('bad-signature');
  });

  it('the TAG ITSELF survives the formatter — the damage is confined to the body', () => {
    // Worth pinning separately: if the formatter mangled the tag, the failure
    // would be `malformed`/`human` rather than `bad-signature`, and the fix
    // would be a different one entirely.
    const { privateKey } = keypair();
    const { text, tag } = signMessage({
      agentId: AGENT, topicId: TOPIC, body: '**markdown body**', privateKey,
    });
    const transmitted = format(text);
    const lastLine = transmitted.split('\n').pop() ?? '';
    expect(lastLine).toContain(`a=${AGENT}`);
    expect(lastLine).toContain(`n=${tag.nonce}`);
    expect(lastLine).toContain(`s=${tag.signature}`);
  });

  it('signing the ALREADY-FORMATTED text verifies — naming the correct fix', () => {
    // The resolution is ordering, not cryptography: sign what will actually be
    // sent. Pinned as a test so the fix has a target to satisfy.
    const { publicKey, privateKey } = keypair();
    const resolvePublicKey = (id: string) => (id === AGENT ? publicKey : null);

    const formattedBody = format('contains **bold** and [a link](https://example.com)');
    const { text } = signMessage({ agentId: AGENT, topicId: TOPIC, body: formattedBody, privateKey });

    // The tag is appended AFTER formatting, so nothing further rewrites the body.
    expect(
      verifyMessage({ raw: text, expectedTopicId: TOPIC, resolvePublicKey }).classification,
    ).toBe('agent-verified');
  });
});
