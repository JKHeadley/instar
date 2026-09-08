import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { PlaywrightProfileRegistry } from '../../../src/core/PlaywrightProfileRegistry.js';
import { commandUsesTelegramProfile, enrollOriginBrowser, type BrowserProfileProcess } from '../../../src/messaging/telegram-origin/OriginBrowserEnrollment.js';
import { temporaryState } from '../../helpers/telegramOriginStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-browser-enrollment:cleanup' }); });
async function fixture() {
  const projectDir = temporaryState(); roots.push(projectDir);
  await mkdir(path.join(projectDir, '.claude'), { recursive: true });
  await writeFile(path.join(projectDir, '.claude/settings.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp'] } } }));
  const registry = new PlaywrightProfileRegistry({ projectDir, stateDir: projectDir, listVaultNames: () => [] });
  registry.createProfile({ id: 'telegram' });
  registry.assignAccount('telegram', { service: 'telegram', identity: 'operator', owner: 'operator', vaultRefs: [] });
  registry.materializeProfileDirectory('telegram');
  registry.writeActivation(registry.computeActivation('telegram'));
  return { registry, profileId: 'telegram', enrollment: { accountId: '123', accountNumber: 1,
    executablePath: '/fixture/chrome', supportedBuilds: [{ buildId: 'fixture', criticalAssets: ['a.js', 'b.js', 'c.js'],
      assetDigests: { 'a.js': 'a'.repeat(64), 'b.js': 'b'.repeat(64), 'c.js': 'c'.repeat(64) } }] } };
}
describe('exclusive Telegram browser enrollment', () => {
  it('matches the dedicated profile exactly and leaves other browser profiles alone', () => {
    const directory = '/agent/profiles/telegram';
    expect(commandUsesTelegramProfile(`Google Chrome --user-data-dir=${directory}`, directory)).toBe(true);
    expect(commandUsesTelegramProfile(`node playwright/mcp --user-data-dir "${directory}"`, directory)).toBe(true);
    expect(commandUsesTelegramProfile(`Google Chrome --user-data-dir=${directory}-personal`, directory)).toBe(false);
    expect(commandUsesTelegramProfile(`node script ${directory}`, directory)).toBe(false);
    expect(commandUsesTelegramProfile('Google Chrome --user-data-dir=/my/personal/profile', directory)).toBe(false);
  });
  it('withdraws generic activation, retires verified process incarnations, and records the empty final census', async () => {
    const input = await fixture();
    let processes: BrowserProfileProcess[] = [{ pid: 912345, started: 'first', commandDigest: 'a'.repeat(64) }];
    const stop = vi.fn(async () => { processes = []; });
    const result = await enrollOriginBrowser({ ...input, inspectProcesses: async () => processes, stopProcess: stop });
    expect(stop).toHaveBeenCalledOnce();
    expect(input.registry.resolvePlaywrightMcpConfig()?.userDataDir).toBeNull();
    expect(result.telegramBroker?.exclusiveEnrollment).toMatchObject({ version: 1, retiredPids: [912345], proofDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(() => input.registry.computeActivation('telegram')).toThrow(/typed broker/);
  });
  it('refuses direct and symlink profile aliases after exclusive enrollment', async () => {
    const input = await fixture();
    const result = await enrollOriginBrowser({ ...input, inspectProcesses: async () => [] });
    expect(input.registry.requireTelegramBrokerProfile('telegram').id).toBe('telegram');
    expect(() => input.registry.createProfile({ id: 'alias', userDataDir: result.userDataDir! })).toThrow(/typed broker/);
    const aliasPath = path.join(path.dirname(result.userDataDir!), 'symlink-alias');
    await symlink(result.userDataDir!, aliasPath);
    expect(() => input.registry.createProfile({ id: 'alias-link', userDataDir: aliasPath })).toThrow(/typed broker/);
    // An old/cached registry alias is checked again immediately before generic activation.
    input.registry.mutate(store => {
      store.profiles.push({ ...result, id: 'old-alias', executionOwner: undefined, telegramBroker: undefined });
      return { next: store, result: undefined };
    });
    expect(() => input.registry.computeActivation('old-alias')).toThrow(/typed broker/);
    expect(() => input.registry.requireTelegramBrokerProfile('telegram')).toThrow(/shared with another profile/);
    const other = input.registry.createProfile({ id: 'unrelated' });
    expect(input.registry.computeActivation(other.id).profileId).toBe('unrelated');
  });
  it('rechecks a profile symlink created after the exclusive enrollment', async () => {
    const input = await fixture();
    const alias = input.registry.createProfile({ id: 'later-symlink' });
    const result = await enrollOriginBrowser({ ...input, inspectProcesses: async () => [] });
    expect(input.registry.requireTelegramBrokerProfile('telegram').id).toBe('telegram');
    await symlink(result.userDataDir!, alias.userDataDir!);
    expect(() => input.registry.requireTelegramBrokerProfile('telegram')).toThrow(/shared with another profile/);
  });
  it('does not signal a reused PID or certify its new process', async () => {
    const input = await fixture(), stop = vi.fn(async () => undefined); let count = 0;
    await expect(enrollOriginBrowser({ ...input, inspectProcesses: async () => [{ pid: 912345, started: count++ ? 'replacement' : 'first', commandDigest: 'a'.repeat(64) }],
      stopProcess: stop })).rejects.toThrow('incarnation-changed');
    expect(stop).not.toHaveBeenCalled();
    expect(input.registry.requireTelegramBrokerProfile('telegram').telegramBroker?.exclusiveEnrollment).toBeUndefined();
  });
  it('leaves enrollment incomplete when process visibility fails', async () => {
    const input = await fixture();
    await expect(enrollOriginBrowser({ ...input, inspectProcesses: async () => { throw new Error('census unavailable'); } })).rejects.toThrow('census unavailable');
    expect(input.registry.requireTelegramBrokerProfile('telegram').telegramBroker?.exclusiveEnrollment).toBeUndefined();
  });
});
