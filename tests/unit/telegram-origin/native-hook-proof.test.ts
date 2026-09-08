import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OriginSessionRegistry } from '../../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { RuntimeOriginObserver } from '../../../src/messaging/telegram-origin/RuntimeOriginObserver.js';
import { ORIGIN_HOOK_PROOF_PREFIX } from '../../../src/messaging/telegram-origin/OriginNativeHookProof.js';
import { temporaryState } from '../../helpers/telegramOriginStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
const roots: string[] = [], observers: RuntimeOriginObserver[] = [];
afterEach(async () => {
  for (const observer of observers.splice(0)) observer.stop();
  for (const root of roots.splice(0)) await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:native-hook-proof:cleanup' });
});
async function fixture() {
  const root = temporaryState(); roots.push(root);
  let now = Date.now(), live = true;
  const registry = new OriginSessionRegistry({ stateDir: root, agentId: 'a', machineId: 'm', now: () => now, isSessionLive: () => live });
  await registry.initialize();
  const launch = { sessionId: 's', projectDir: root, harnessId: 'claude-code' as const, nativeSessionId: 'native' };
  const token = await registry.issue(launch), digest = 'a'.repeat(64);
  const challenge = registry.challengeNativeHook(token, 'native', digest)!;
  const observer = new RuntimeOriginObserver({ now: () => now }); observers.push(observer);
  const file = path.join(root, 'native.jsonl'); await writeFile(file, '');
  observer.track(registry.getBinding('s')!, { path: file, nativeSessionId: 'native' });
  const attachment = { type: 'hook_success', hookEvent: 'PreToolUse', command: 'node .instar/hooks/instar/telegram-origin-guard.js',
    toolUseID: 'tool', exitCode: 0, stderr: ORIGIN_HOOK_PROOF_PREFIX + Buffer.from(JSON.stringify(challenge)).toString('base64url') + '\n' };
  const row = { type: 'attachment', sessionId: 'native', timestamp: new Date(now).toISOString(), attachment };
  const append = async (value: object) => { await appendFile(file, JSON.stringify(value) + '\n'); await observer.refresh('s'); };
  return { registry, observer, token, digest, challenge, launch, file, row, attachment, append,
    advance: (ms: number) => { now += ms; }, end: () => { live = false; } };
}
describe('native hook provenance and challenge bounds', () => {
  it('does not accept assistant text, missing native identity, unrelated events, failed hooks or sidechains', async () => {
    const h = await fixture();
    for (const row of [
      { ...h.row, type: 'assistant' }, { ...h.row, sessionId: undefined }, { ...h.row, sessionId: 'foreign' },
      { ...h.row, isSidechain: true }, { ...h.row, attachment: { ...h.attachment, hookEvent: 'PostToolUse' } },
      { ...h.row, attachment: { ...h.attachment, exitCode: 1 } },
    ]) { await h.append(row); expect(h.observer.getNativeHookProof('s')).toBeUndefined(); }
    await h.append(h.row);
    expect(h.registry.verifyNativeHookProof('s', h.observer.getNativeHookProof('s')!, h.digest)).toBe(true);
  });
  it('invalidates stale observer data and retained native output after incarnation replacement', async () => {
    const h = await fixture(); await h.append(h.row);
    const proof = h.observer.getNativeHookProof('s')!;
    h.advance(30_001); expect(h.observer.getNativeHookProof('s')).toBeUndefined();
    await h.observer.refresh('s'); expect(h.observer.getNativeHookProof('s')).toBeDefined();
    await h.registry.issue(h.launch);
    expect(h.registry.verifyNativeHookProof('s', proof, h.digest)).toBe(false);
    h.observer.track(h.registry.getBinding('s')!, { path: h.file, nativeSessionId: 'native' });
    await h.observer.refresh('s'); expect(h.observer.getNativeHookProof('s')).toBeUndefined();
  });
  it('bounds challenge lifetime and refuses digest changes, clock reversal, revoked and restarted credentials', async () => {
    const h = await fixture(); await h.append(h.row);
    const proof = h.observer.getNativeHookProof('s')!;
    expect(h.registry.challengeNativeHook(h.token, 'native', h.digest)?.nonce).toBe(h.challenge.nonce);
    expect(h.registry.verifyNativeHookProof('s', proof, 'b'.repeat(64))).toBe(false);
    h.advance(-1); expect(h.registry.verifyNativeHookProof('s', proof, h.digest)).toBe(false);
    h.advance(3_600_001); expect(h.registry.verifyNativeHookProof('s', proof, h.digest)).toBe(false);
    expect(h.registry.challengeNativeHook(h.token, 'native', h.digest)?.nonce).not.toBe(h.challenge.nonce);
    const restarted = new OriginSessionRegistry({ stateDir: h.launch.projectDir, agentId: 'a', machineId: 'm', isSessionLive: () => true });
    await restarted.initialize(); expect(restarted.verify(h.token).ok).toBe(true);
    expect(restarted.verifyNativeHookProof('s', proof, h.digest)).toBe(false);
    h.end(); expect(h.registry.challengeNativeHook(h.token, 'native', h.digest)).toBeUndefined();
    expect(h.registry.verifyNativeHookProof('s', proof, h.digest)).toBe(false);
  });
});
