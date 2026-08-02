import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SlackAdapter,
  SLACK_STALL_CONFIRM_PROMPT_ID,
} from '../../src/messaging/slack/SlackAdapter.js';
import {
  TelegramAdapter,
  TELEGRAM_STALL_CONFIRM_PROMPT_ID,
} from '../../src/messaging/TelegramAdapter.js';
import {
  DP_SLACK_STALL_CONFIRM,
  DP_TELEGRAM_STALL_CONFIRM,
} from '../../src/data/provenanceCoverage.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const tempDirs: string[] = [];

function makeTempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/stall-alert-provenance.test.ts:cleanup',
    });
  }
});

const context = {
  type: 'stall' as const,
  sessionName: 'cobalt-lantern-session',
  messageText: 'cobalt-lantern private progress detail',
  minutesElapsed: 23,
  sessionAlive: true,
};

function assertIdentityOnlyProvenance(
  capturedPrompt: string,
  capturedOptions: any,
  decisionPoint: string,
  promptId: string,
): void {
  expect(capturedPrompt).toContain('cobalt-lantern');
  expect(capturedOptions.provenance).toMatchObject({
    decisionPoint,
    optionsPresented: ['yes', 'no'],
    promptId,
  });
  const storedContext = JSON.stringify(capturedOptions.provenance.context);
  expect(storedContext).not.toContain('cobalt-lantern');
  expect(capturedOptions.provenance.context.sessionNameIdentitySha256).toMatch(
    /^sha256:(?:[a-f0-9]{16}:){3}[a-f0-9]{16}$/,
  );
  expect(capturedOptions.provenance.context).toMatchObject({
    alertType: 'stall',
    minutesElapsed: 23,
    sessionAlive: true,
  });
}

describe('fallback stall alert provenance', () => {
  it('enrolls Slack confirmation without storing session or message bodies', async () => {
    let capturedPrompt = '';
    let capturedOptions: any;
    const adapter = new SlackAdapter({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      authorizedUserIds: ['U_TEST'],
      workspaceMode: 'dedicated',
    }, makeTempDir('slack-stall-provenance'));
    adapter.intelligence = {
      evaluate: async (prompt: string, options?: any) => {
        capturedPrompt = prompt;
        capturedOptions = options;
        return 'no';
      },
    };

    expect(await adapter.confirmStallAlert(context)).toBe(false);
    assertIdentityOnlyProvenance(
      capturedPrompt,
      capturedOptions,
      DP_SLACK_STALL_CONFIRM,
      SLACK_STALL_CONFIRM_PROMPT_ID,
    );
  });

  it('enrolls Telegram confirmation without storing session or message bodies', async () => {
    let capturedPrompt = '';
    let capturedOptions: any;
    const adapter = new TelegramAdapter({
      token: 'test-token',
      chatId: '-100123456',
    }, makeTempDir('telegram-stall-provenance'));
    adapter.intelligence = {
      evaluate: async (prompt: string, options?: any) => {
        capturedPrompt = prompt;
        capturedOptions = options;
        return 'no';
      },
    };

    expect(await (adapter as any).confirmStallAlert(context)).toBe(false);
    assertIdentityOnlyProvenance(
      capturedPrompt,
      capturedOptions,
      DP_TELEGRAM_STALL_CONFIRM,
      TELEGRAM_STALL_CONFIRM_PROMPT_ID,
    );
    await adapter.stop();
  });
});
