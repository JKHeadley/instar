import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';

/** Opt-in setup for tests of behavior after configuration readiness. Boot can
 * return while a newer config revision invalidates its initial snapshot. This
 * observes the actual display authority; it does not approve dispatch, retry a
 * send, or apply to tests of unavailable startup authorities.
 */
export async function waitForOriginDisplayReady(runtime: TelegramOriginRuntime,
  destination: { chatId: string | null; topicId: string | null }) {
  assert.equal(typeof runtime.options.display, 'function', 'production display authority must be wired');
  const deadline = performance.now() + 12_500;
  for (;;) {
    let projection;
    try {
      projection = runtime.options.display({ accountId: runtime.options.bot.accountId, ...destination });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'origin-display-authority-unavailable' || performance.now() >= deadline) throw error;
      // Real timers preserve lease tests that fake only interval callbacks.
      // vi.waitFor would also advance those unrelated fake timers.
      await delay(50);
      continue;
    }
    assert.ok(projection && typeof projection === 'object', 'display authority must return its projection');
    assert.ok(projection.agent && typeof projection.agent === 'object', 'production agent display settings must be present');
    return projection;
  }
}
