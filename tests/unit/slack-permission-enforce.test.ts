/**
 * Enforce-path wiring (Phase 1): when the permission observer is ENFORCING, a
 * non-allow verdict sends the conversational reply and blocks processing; observe-only
 * never blocks. Dark by default (enforcing=false).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import type { SlackPermissionObserver } from '../../src/permissions/SlackPermissionObserver.js';

function makeVerdict(decision: string, message: string) {
  return {
    decision,
    basis: decision === 'allow' ? 'within-authority' : 'floor-no-grant',
    message,
    principal: { userId: 'u', name: 'U', slackUserId: 'U_TEST', role: 'member', registered: true },
    intent: { action: 'prod-deploy', tier: 4, confidence: 0.9, directed: true },
    evaluatedAt: new Date().toISOString(),
  };
}

function harness(tmp: string, observer: any) {
  const messages: string[] = [];
  const sends: Array<{ ch: string; txt: string }> = [];
  const adapter = new SlackAdapter(
    { botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: ['U_TEST'], workspaceMode: 'dedicated' } as any,
    tmp,
  );
  adapter.onMessage(async (m) => { messages.push(m.content); });
  (adapter as any).sendToChannel = async (ch: string, txt: string) => { sends.push({ ch, txt }); return 'ts'; };
  adapter.setPermissionObserver(observer as SlackPermissionObserver);
  const handle = (adapter as any)._handleMessage.bind(adapter);
  return { handle, messages, sends };
}

describe('SlackAdapter enforce path', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-enforce-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/slack-permission-enforce.test.ts' }); });

  it('enforce + refuse → sends the conversational reply and blocks processing', async () => {
    const observer = { enforcing: true, observe: async () => makeVerdict('refuse', "I can't run a production deploy on a member's request.") };
    const { handle, messages, sends } = harness(tmp, observer);
    await handle({ user: 'U_TEST', text: 'deploy to prod', channel: 'D_TEST', ts: '1.1' });
    expect(sends).toHaveLength(1);
    expect(sends[0].txt).toMatch(/production deploy/);
    expect(messages).toHaveLength(0); // blocked — not handed to the session
  });

  it('enforce + allow → proceeds to the handler, no gate reply', async () => {
    const observer = { enforcing: true, observe: async () => makeVerdict('allow', '') };
    const { handle, messages, sends } = harness(tmp, observer);
    await handle({ user: 'U_TEST', text: 'summarize the thread', channel: 'D_TEST', ts: '2.1' });
    expect(sends).toHaveLength(0);
    expect(messages).toHaveLength(1);
  });

  it('observe-only (enforcing=false) → never blocks, even on a refuse verdict', async () => {
    const observer = { enforcing: false, observe: async () => makeVerdict('refuse', 'would refuse') };
    const { handle, messages, sends } = harness(tmp, observer);
    await handle({ user: 'U_TEST', text: 'deploy to prod', channel: 'D_TEST', ts: '3.1' });
    expect(sends).toHaveLength(0); // observe-only does not send an enforce reply
    expect(messages).toHaveLength(1); // proceeds normally
  });
});
