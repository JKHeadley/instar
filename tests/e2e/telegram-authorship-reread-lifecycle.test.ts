import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { AspInboundClassifier } from '../../src/core/AspInboundClassifier.js';
import { MemorySeenNonceStore, signMessage } from '../../src/core/agentSignatureProvenance.js';

describe('E2E — classification verdict reaches a fresh re-reader', () => {
  it('classifies, persists, then joins through a new adapter instance', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-reread-e2e-'));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(-32);
    const priv = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).subarray(-32);
    const { text } = signMessage({ agentId: 'echo', topicId: 43003, body: 'fresh signed control', privateKey: priv });
    const message = { messageId: 123, topicId: 43003, text, fromUser: true, timestamp: new Date().toISOString(), sessionName: null };
    fs.writeFileSync(path.join(dir, 'telegram-messages.jsonl'), JSON.stringify(message) + '\n');
    new AspInboundClassifier({
      ledgerPath: path.join(dir, 'asp-classifications.jsonl'),
      resolvePublicKey: (id) => id === 'echo' ? pub : null,
      seenNonces: new MemorySeenNonceStore(), onlyRecordTagged: false,
    }).classify(message);

    const fresh = new TelegramAdapter({ token: 'test', chatId: '-1001' }, dir);
    expect(fresh.getTopicHistory(43003, 20)[0]).toMatchObject({ messageId: 123, authorship: 'agent-verified' });
  });
});
