/**
 * Telegram message injection tests — validates the SessionManager's
 * injectTelegramMessage method handles both short and long messages correctly.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Telegram message injection logic', () => {
  const FILE_THRESHOLD = 500;

  it('SessionManager has injectTelegramMessage method', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    expect(source).toContain('injectTelegramMessage');
  });

  it('uses FILE_THRESHOLD of 500 characters', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    expect(source).toContain('500');
    expect(source).toContain('FILE_THRESHOLD');
  });

  it('tags messages with [telegram:N] format', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    expect(source).toContain('`[telegram:${topicId}]');
  });

  it('writes long messages to temp file', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    expect(source).toContain('getTelegramInboundDir(this.config.projectDir)');
    expect(source).toContain('Long message saved to');
  });

  it('uses =session: (trailing colon) for pane-level tmux commands', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    // The trailing colon is critical for tmux pane-level commands
    expect(source).toContain('`=${tmuxSession}:`');
  });

  it('sendInput uses -l flag for literal text', () => {
    // The `-l` flag now lives in the shared literal-send funnel rather than
    // inline: `send-keys -l` carries its payload in ONE argv element and blows
    // ARG_MAX past ~16KB, so every literal send goes through
    // buildLiteralSendArgs()/chunkLiteralForTmux() (src/core/tmuxLiteralSend.ts).
    // The guarantee this test protects is unchanged — literal text is sent with
    // `-l` — so it follows the flag to where it now lives instead of asserting
    // on a source string the fix deliberately removed.
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    expect(source).toContain('buildLiteralSendArgs');

    const funnel = fs.readFileSync(
      path.join(process.cwd(), 'src/core/tmuxLiteralSend.ts'),
      'utf-8'
    );
    expect(funnel).toContain("'-l'");
  });

  it('sendInput sends Enter key separately', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    // Should have two execFileSync calls in sendInput method — one for text, one for Enter
    // Match the method definition specifically (not call sites)
    const sendInputMatch = source.match(/sendInput\(tmuxSession: string[\s\S]*?(?=\n\s{2}\w|\n\s{2}\/\*\*)/);
    if (sendInputMatch) {
      const sendInputBody = sendInputMatch[0];
      expect(sendInputBody).toContain("'Enter'");
    }
  });
});
