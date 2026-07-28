import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('single-agent cross-machine forward restart dedup wiring', () => {
  it('uses the durable remote receipt verdict before restart-local fallbacks', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
    const start = src.indexOf('recordReceipt: (messageId, session) =>');
    const block = src.slice(start, start + 1400);
    const durable = block.indexOf('return _inboundQueue.recordRemoteReceipt(session, messageId)');
    const optionalLedger = block.indexOf('if (messageLedger)');
    const memoryFallback = block.indexOf('deliverSeenFallback.has(messageId)');
    expect(start).toBeGreaterThan(-1);
    expect(durable).toBeGreaterThan(-1);
    expect(optionalLedger).toBeGreaterThan(durable);
    expect(memoryFallback).toBeGreaterThan(optionalLedger);
  });
});
