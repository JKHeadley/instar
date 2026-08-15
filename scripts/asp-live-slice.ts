/**
 * ASP live slice — demonstrate agent-signature provenance on the REAL Telegram path.
 *
 * Usage:
 *   npx tsx scripts/asp-live-slice.ts sign   <topicId> <body...>   # print signed text
 *   npx tsx scripts/asp-live-slice.ts verify <topicId> <file>      # classify a file's bytes
 *
 * The private key is read from the agent identity and never printed. `verify`
 * reads real received bytes off disk so the classification is over the message
 * as it actually travelled, not over an in-memory copy.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  signMessage,
  verifyMessage,
  MemorySeenNonceStore,
} from '../src/core/agentSignatureProvenance.js';

const AGENT_HOME = process.env.INSTAR_AGENT_HOME ?? '/Users/justin_instar_1/.instar/agents/echo';
const AGENT_ID = process.env.ASP_AGENT_ID ?? 'echo';

interface IdentityFile {
  publicKey: string;
  privateKey: string;
  privateKeyEncryption: string;
}

function loadIdentity(): { publicKey: Buffer; privateKey: Buffer } {
  const raw = JSON.parse(readFileSync(join(AGENT_HOME, '.instar/identity.json'), 'utf8')) as IdentityFile;
  if (raw.privateKeyEncryption !== 'none') {
    throw new Error(
      `identity private key is encrypted (${raw.privateKeyEncryption}); this slice needs an unlocked key`
    );
  }
  return {
    publicKey: Buffer.from(raw.publicKey, 'base64'),
    privateKey: Buffer.from(raw.privateKey, 'base64'),
  };
}

/** Public-key directory. Real wiring resolves peers; the slice resolves self. */
function makeResolver(publicKey: Buffer) {
  return (agentId: string): Buffer | null => (agentId === AGENT_ID ? publicKey : null);
}

const [, , mode, topicArg, ...rest] = process.argv;
const topicId = Number(topicArg);

if (!mode || !Number.isSafeInteger(topicId)) {
  console.error('usage: asp-live-slice.ts <sign|verify> <topicId> <body...|file>');
  process.exit(2);
}

const { publicKey, privateKey } = loadIdentity();

if (mode === 'sign') {
  const body = rest.join(' ');
  if (!body) {
    console.error('sign: empty body');
    process.exit(2);
  }
  const { text, tag } = signMessage({ agentId: AGENT_ID, topicId, body, privateKey });
  // stderr carries operator-facing detail; stdout is the exact bytes to send.
  console.error(`[asp] signed agent=${tag.agentId} topic=${tag.topicId} ts=${tag.timestamp} nonce=${tag.nonce}`);
  console.error(`[asp] key fingerprint (public): ${publicKey.toString('hex').slice(0, 16)}`);
  process.stdout.write(text);
} else if (mode === 'verify') {
  const file = rest[0];
  if (!file) {
    console.error('verify: need a file of received bytes');
    process.exit(2);
  }
  const raw = readFileSync(file, 'utf8');
  const verdict = verifyMessage({
    raw,
    expectedTopicId: topicId,
    resolvePublicKey: makeResolver(publicKey),
    seenNonces: new MemorySeenNonceStore(),
  });
  console.log(JSON.stringify({
    classification: verdict.classification,
    reason: 'reason' in verdict ? verdict.reason : undefined,
    agentId: 'agentId' in verdict ? verdict.agentId : undefined,
    topicId: 'topicId' in verdict ? verdict.topicId : undefined,
    bodyPreview: verdict.body.slice(0, 80),
    bodyBytes: Buffer.byteLength(verdict.body, 'utf8'),
  }, null, 2));
  process.exit(verdict.classification === 'rejected' ? 1 : 0);
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
