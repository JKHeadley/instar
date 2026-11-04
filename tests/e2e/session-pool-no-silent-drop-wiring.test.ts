/** Wiring integrity: production must pass the check, and it must mirror the silent returns. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const server = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

describe('deliver handler wiring in server.ts', () => {
  const start = server.indexOf('canServe: (cmd) => {');
  const block = server.slice(start, start + 1100);
  it('passes canServe to the handler', () => expect(start).toBeGreaterThan(-1));
  it('exempts a dashboard start, which needs no channel', () => expect(block).toContain('dashboard-create:'));
  it('the duplicate guard reads every receipt tier', () => {
    expect(block).toContain('alreadyReceived');
    expect(block).toContain('hasRemoteReceipt');
    expect(block).toContain('messageLedger.get(messageId)');
    expect(block).toContain('deliverSeenFallback.has(messageId)');
  });
  it('refuses on a dark pool and with no channel', () => {
    expect(block).toContain("_sessionPoolStage() === 'dark'");
    expect(block).toContain('!!_slackInboundDispatch');
    expect(block).toContain('!!telegram');
  });
  it('those are still the silent returns in onAccepted, so the two cannot drift apart unseen', () => {
    const accepted = server.slice(server.indexOf('onAccepted: (cmd) => {'));
    expect(accepted).toContain("if (_sessionPoolStage() === 'dark') return;");
    expect(accepted).toContain('if (!_slackInboundDispatch) return;');
    expect(accepted).toContain('if (!telegram) return;');
  });
});
