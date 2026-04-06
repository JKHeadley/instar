import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';

/**
 * Wiring integrity tests: Slack session continuity / anti-amnesia.
 *
 * These tests verify the 5 infrastructure fixes that prevent agents from
 * asking "what were we up to?" after session recovery, compaction, or restart.
 *
 * The 5 gaps addressed:
 * 1. INSTAR_SLACK_CHANNEL env var on Slack sessions (compaction recovery needs it)
 * 2. Slack API fallback when ring buffer is empty (race condition on restart)
 * 3. CONTINUATION marker on Slack session bootstrap (matches Telegram behavior)
 * 4. Inline context injection for Slack (not just file reference)
 * 5. Anti-amnesia verification (warn when history is empty)
 */

const SERVER_TS_PATH = 'src/commands/server.ts';
const SESSION_MANAGER_PATH = 'src/core/SessionManager.ts';
const SLACK_ADAPTER_PATH = 'src/messaging/slack/SlackAdapter.ts';
const COMPACTION_HOOK_PATH = 'src/templates/hooks/compaction-recovery.sh';

describe('Slack session continuity (anti-amnesia)', () => {
  const serverSource = fs.readFileSync(SERVER_TS_PATH, 'utf-8');
  const sessionManagerSource = fs.readFileSync(SESSION_MANAGER_PATH, 'utf-8');
  const slackAdapterSource = fs.readFileSync(SLACK_ADAPTER_PATH, 'utf-8');
  const compactionHookSource = fs.readFileSync(COMPACTION_HOOK_PATH, 'utf-8');

  describe('Gap 1: INSTAR_SLACK_CHANNEL env var', () => {
    it('SessionManager accepts slackChannelId option', () => {
      expect(sessionManagerSource).toContain('slackChannelId');
    });

    it('SessionManager sets INSTAR_SLACK_CHANNEL env var on tmux', () => {
      expect(sessionManagerSource).toContain('INSTAR_SLACK_CHANNEL');
    });

    it('Slack channel sessions pass slackChannelId to spawnInteractiveSession', () => {
      expect(serverSource).toContain('slackChannelId: channelId');
    });

    it('Recovery spawn passes slackChannelId', () => {
      expect(serverSource).toContain('slackChannelId: slackChId');
    });

    it('compaction-recovery hook checks INSTAR_SLACK_CHANNEL', () => {
      expect(compactionHookSource).toContain('INSTAR_SLACK_CHANNEL');
    });

    it('compaction-recovery hook fetches Slack channel messages', () => {
      expect(compactionHookSource).toContain('/slack/channels/');
    });

    it('compaction-recovery hook skips Telegram context for Slack sessions', () => {
      // Must not inject lifeline topic context when we already injected Slack context
      expect(compactionHookSource).toContain('SLACK_CHANNEL');
      const slackSkipIdx = compactionHookSource.indexOf('Skip Telegram context if this is a Slack session');
      expect(slackSkipIdx).toBeGreaterThan(-1);
    });

    it('compaction-recovery hook injects CONTINUATION marker for Slack', () => {
      // After compaction, Slack sessions must get CONTINUATION marker
      expect(compactionHookSource).toContain('CONTINUATION');
      expect(compactionHookSource).toContain('resuming an EXISTING Slack conversation');
    });
  });

  describe('Gap 2: Slack API fallback for empty ring buffer', () => {
    it('SlackAdapter has getChannelMessagesWithFallback method', () => {
      expect(slackAdapterSource).toContain('getChannelMessagesWithFallback');
    });

    it('getChannelMessagesWithFallback calls getChannelHistory as fallback', () => {
      // Must call the API when ring buffer is empty
      const methodStart = slackAdapterSource.indexOf('async getChannelMessagesWithFallback');
      expect(methodStart).toBeGreaterThan(-1);
      const methodBlock = slackAdapterSource.slice(methodStart, methodStart + 800);
      expect(methodBlock).toContain('getChannelHistory');
    });

    it('getChannelMessagesWithFallback populates ring buffer from API results', () => {
      const methodStart = slackAdapterSource.indexOf('async getChannelMessagesWithFallback');
      const methodBlock = slackAdapterSource.slice(methodStart, methodStart + 800);
      // Must push API results into ring buffer for future use
      expect(methodBlock).toContain('buffer.push');
    });

    it('normal Slack message handler uses async fallback', () => {
      expect(serverSource).toContain('getChannelMessagesWithFallback(channelId, 30)');
    });

    it('recovery spawn uses async fallback', () => {
      expect(serverSource).toContain('getChannelMessagesWithFallback(slackChId, 30)');
    });
  });

  describe('Gap 3: CONTINUATION marker on Slack bootstrap', () => {
    // Find the Slack message handler block
    const slackMessageHandlerStart = serverSource.indexOf('Build context for the session');
    const slackBlock = serverSource.slice(slackMessageHandlerStart, slackMessageHandlerStart + 2000);

    it('Slack message handler adds CONTINUATION marker when history exists', () => {
      expect(slackBlock).toContain('CONTINUATION');
    });

    it('CONTINUATION marker says "resuming an EXISTING Slack conversation"', () => {
      expect(slackBlock).toContain('resuming an EXISTING Slack conversation');
    });

    it('CONTINUATION marker includes "Do NOT ask what was being discussed"', () => {
      expect(slackBlock).toContain('Do NOT ask what was being discussed');
    });

    it('recovery path also has CONTINUATION marker', () => {
      const recoveryStart = serverSource.indexOf('recovery bootstrap message with thread history');
      const recoveryBlock = serverSource.slice(recoveryStart, recoveryStart + 2000);
      expect(recoveryBlock).toContain('CONTINUATION');
      expect(recoveryBlock).toContain('Do NOT ask what was being discussed');
    });
  });

  describe('Gap 4: Inline context injection', () => {
    it('recovery path injects context inline in bootstrap (not just file reference)', () => {
      // The recovery bootstrap message must contain the actual context, not just a file path
      const recoveryStart = serverSource.indexOf('recovery bootstrap message with thread history');
      const recoveryBlock = serverSource.slice(recoveryStart, recoveryStart + 3000);
      // Must construct bootstrap from context content, not just a pointer to a file
      expect(recoveryBlock).toContain('`[slack:${slackChId}] ${contextData}`');
    });

    it('normal spawn writes inline context to message file for long messages', () => {
      const slackBlock = serverSource.slice(
        serverSource.indexOf('Build context for the session'),
        serverSource.indexOf('Build context for the session') + 5000,
      );
      // When message is long, the file must include the context data too
      expect(slackBlock).toContain('fullContent');
      expect(slackBlock).toContain('contextData');
    });
  });

  describe('Gap 5: Anti-amnesia verification', () => {
    it('normal spawn warns when history is empty', () => {
      const slackBlock = serverSource.slice(
        serverSource.indexOf('Build context for the session'),
        serverSource.indexOf('Build context for the session') + 2000,
      );
      expect(slackBlock).toContain('No history available for channel');
    });

    it('recovery spawn warns when history is empty', () => {
      const recoveryStart = serverSource.indexOf('recovery bootstrap message with thread history');
      const recoveryBlock = serverSource.slice(recoveryStart, recoveryStart + 3000);
      expect(recoveryBlock).toContain('No history available for channel');
    });

    it('recovery includes fallback notice when history is empty', () => {
      const recoveryStart = serverSource.indexOf('recovery bootstrap message with thread history');
      const recoveryBlock = serverSource.slice(recoveryStart, recoveryStart + 3000);
      // Must tell the agent that history is unavailable so it knows to check
      expect(recoveryBlock).toContain('Thread history unavailable');
    });
  });
});
