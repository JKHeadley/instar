/**
 * PresenceProxy context exhaustion detection and auto-recovery — validates that
 * when a session hits "conversation too long" / compaction errors, the proxy
 * auto-recovers instead of showing generic "session stopped" messages.
 *
 * Root cause: PresenceProxy's tier 3 check would classify context-exhausted
 * sessions as "dead" or "stalled" and ask the user to manually recover,
 * even though SessionRecovery can handle this automatically.
 */

import { describe, it, expect } from 'vitest';
import { detectQuotaExhaustion } from '../../src/monitoring/PresenceProxy.js';
import { detectContextExhaustion } from '../../src/monitoring/QuotaExhaustionDetector.js';

describe('Context exhaustion detection in PresenceProxy flow', () => {
  it('detectContextExhaustion catches "conversation too long" that quota detection misses', () => {
    const snapshot = `> /compact
└ Error: Error during compaction: Conversation too long. Press esc twice to go up a few messages and try again.

❯`;
    // Quota detection should NOT match this
    expect(detectQuotaExhaustion(snapshot)).toBeNull();
    // Context exhaustion should match this
    const result = detectContextExhaustion(snapshot);
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('detects plain "conversation too long" error', () => {
    const snapshot = `Error: Conversation too long
❯`;
    expect(detectQuotaExhaustion(snapshot)).toBeNull();
    const result = detectContextExhaustion(snapshot);
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('detects "conversation is too long" variant', () => {
    const snapshot = `The conversation is too long to continue processing.`;
    const result = detectContextExhaustion(snapshot);
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('detects "press esc twice to go up a few messages"', () => {
    const snapshot = `Press esc twice to go up a few messages and try again.`;
    const result = detectContextExhaustion(snapshot);
    expect(result.matched).toBe(true);
  });

  it('does not match normal terminal output', () => {
    const snapshot = `npm test
All 42 tests passed
Building project...
Build successful`;
    const result = detectContextExhaustion(snapshot);
    expect(result.matched).toBe(false);
  });

  it('does not match quota exhaustion messages', () => {
    const snapshot = `You've hit your limit - resets 7pm (America/Los_Angeles)`;
    const result = detectContextExhaustion(snapshot);
    expect(result.matched).toBe(false);
  });

  it('does not treat normal compaction resume banners as context exhaustion', () => {
    const snapshot = `Your session paused for context compaction and has now resumed.

--- IDENTITY RECOVERY (post-compaction) ---
The context below is what you had before the reset.

❯`;
    const result = detectContextExhaustion(snapshot);
    expect(result.matched).toBe(false);
  });

  it('does not treat Conversation compacted prompt banners as context exhaustion', () => {
    const snapshot = `✱ Conversation compacted (ctrl+o for history)

> /compact
  Compacted

❯`;
    const result = detectContextExhaustion(snapshot);
    expect(result.matched).toBe(false);
  });

  it('still detects context exhaustion when a compaction banner includes the real failure text', () => {
    const snapshot = `✱ Conversation compacted (ctrl+o for history)

└ Error: Error during compaction: Conversation too long. Press esc twice to go up a few messages and try again.

❯`;
    const result = detectContextExhaustion(snapshot);
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe('high');
  });
});

describe('PresenceProxy source — context exhaustion integration', () => {
  it('imports detectContextExhaustion', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/monitoring/PresenceProxy.ts'),
      'utf-8'
    );
    expect(source).toContain("import { detectContextExhaustion }");
  });

  it('checks for context exhaustion after quota check in tier 3', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/monitoring/PresenceProxy.ts'),
      'utf-8'
    );
    // Context exhaustion check should appear AFTER quota check but BEFORE process tree check
    const quotaIdx = source.indexOf('Quota exhaustion: check before LLM call');
    const ctxIdx = source.indexOf('Context exhaustion: auto-recover before LLM call');
    const processIdx = source.indexOf('Process tree check (authoritative)');
    expect(quotaIdx).toBeGreaterThan(0);
    expect(ctxIdx).toBeGreaterThan(quotaIdx);
    expect(processIdx).toBeGreaterThan(ctxIdx);
  });

  it('calls recoverContextExhaustion callback when context exhaustion detected', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/monitoring/PresenceProxy.ts'),
      'utf-8'
    );
    expect(source).toContain('recoverContextExhaustion');
    expect(source).toContain('Conversation got too long');
  });

  it('PresenceProxyConfig includes recoverContextExhaustion callback', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/monitoring/PresenceProxy.ts'),
      'utf-8'
    );
    expect(source).toContain('recoverContextExhaustion?: (topicId: number, sessionName: string) => Promise<{ recovered: boolean }>');
  });
});
