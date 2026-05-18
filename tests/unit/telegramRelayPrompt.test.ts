/**
 * Unit tests — buildTelegramRelayBlock.
 *
 * Phase-gap fix for v1.0.0: every Telegram-spawned session must see the
 * MANDATORY relay instruction inline in its bootstrap, not via a hook
 * that Codex CLI can't run. These tests pin the wording so a future
 * refactor can't silently weaken the block.
 */

import { describe, it, expect } from 'vitest';
import { buildTelegramRelayBlock } from '../../src/messaging/shared/telegramRelayPrompt.js';

describe('buildTelegramRelayBlock', () => {
  it('emits the MANDATORY directive verbatim for claude-code', () => {
    const block = buildTelegramRelayBlock({ topicId: 9984, framework: 'claude-code' });
    expect(block).toContain('--- Telegram Relay (MANDATORY) ---');
    expect(block).toContain('You MUST run this exact bash command');
  });

  it('emits the MANDATORY directive verbatim for codex-cli', () => {
    const block = buildTelegramRelayBlock({ topicId: 9984, framework: 'codex-cli' });
    expect(block).toContain('--- Telegram Relay (MANDATORY) ---');
    expect(block).toContain('You MUST run this exact bash command');
  });

  it('includes the relay command with the topic id', () => {
    const block = buildTelegramRelayBlock({ topicId: 2525, framework: 'codex-cli' });
    expect(block).toContain("cat <<'EOF' | .claude/scripts/telegram-reply.sh 2525");
    expect(block).toMatch(/EOF\s*$/m);
  });

  it('honors a custom relay script path', () => {
    const block = buildTelegramRelayBlock({
      topicId: 1,
      framework: 'codex-cli',
      relayScriptPath: '.instar/scripts/telegram-reply.sh',
    });
    expect(block).toContain('.instar/scripts/telegram-reply.sh 1');
    expect(block).not.toContain('.claude/scripts/telegram-reply.sh');
  });

  it('instructs the agent to strip the [telegram:N] prefix', () => {
    const block = buildTelegramRelayBlock({ topicId: 42, framework: 'claude-code' });
    expect(block).toContain('Strip the [telegram:42] prefix');
  });

  it('warns about sentinel fallback so the agent understands stakes', () => {
    const block = buildTelegramRelayBlock({ topicId: 1, framework: 'codex-cli' });
    expect(block.toLowerCase()).toContain('sentinel');
  });

  it('demands an ACK before the long reply', () => {
    const block = buildTelegramRelayBlock({ topicId: 1, framework: 'codex-cli' });
    expect(block).toContain('Send a short ACK first');
  });
});
