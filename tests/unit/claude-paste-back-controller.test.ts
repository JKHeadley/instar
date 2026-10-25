import { describe, expect, it, vi } from 'vitest';
import { ClaudePasteBackController, validClaudePasteBackCode } from '../../src/core/ClaudePasteBackController.js';
import type { PendingLogin } from '../../src/core/PendingLoginStore.js';

const login: PendingLogin = { id: 'acct-1', label: 'account', provider: 'anthropic', framework: 'claude-code',
  kind: 'url-code-paste', configHome: '/tmp/slot', verificationUrl: 'https://claude.ai/oauth',
  ttlExpiresAt: '2099-01-01T00:00:00Z', status: 'pending', reissueCount: 0,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1 };

function fixture() {
  let ready = false;
  const deps = {
    captureOutput: vi.fn(() => 'Paste code here >'), sendInput: vi.fn(() => true),
    clearHistory: vi.fn(), credentialReady: vi.fn(() => ready),
    sleep: vi.fn(async () => { ready = true; }), now: vi.fn(() => 1_000), waitMs: 2_000, pollMs: 100,
  };
  return { deps, controller: new ClaudePasteBackController(deps) };
}

describe('ClaudePasteBackController', () => {
  it('checks readiness, sends once, clears history, and proves the credential landed', async () => {
    const { deps, controller } = fixture();
    expect(await controller.finish(login, 'single-use-code', new AbortController().signal)).toBe('complete');
    expect(deps.sendInput).toHaveBeenCalledOnce();
    expect(deps.clearHistory).toHaveBeenCalledOnce();
  });

  it('never types into a dead, shell, or non-prompt pane', async () => {
    for (const frame of [null, '$ ', 'Waiting for browser']) {
      const { deps, controller } = fixture(); deps.captureOutput.mockReturnValue(frame);
      expect(await controller.finish(login, 'code', new AbortController().signal))
        .toBe(frame === null ? 'pane-dead' : 'pane-not-ready');
      expect(deps.sendInput).not.toHaveBeenCalled();
    }
  });

  it('rejects URLs, whitespace, control characters, and oversized values', () => {
    expect(validClaudePasteBackCode('valid-code')).toBe(true);
    for (const value of ['https://claude.ai/code', 'two words', 'line\nbreak', `x${'a'.repeat(512)}`])
      expect(validClaudePasteBackCode(value)).toBe(false);
  });

  it('aborts before typing when cancellation already won', async () => {
    const { deps, controller } = fixture(); const abort = new AbortController(); abort.abort();
    await expect(controller.finish(login, 'code', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.sendInput).not.toHaveBeenCalled();
  });
});
