/**
 * Last-resort model for the sign-in repair (spec relogin-last-resort-model): config resolution,
 * the one-shot call shape (key as the adapter credential, a dedicated empty config home, the
 * lightweight tier regardless of the caller's ask), the per-drive and per-day caps, live
 * availability from the vault, and the primary-first wrapper.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  RELOGIN_LAST_RESORT_DEFAULT_KEY_NAME, RELOGIN_LAST_RESORT_DEFAULT_MODEL,
  ReloginLastResortProvider, createReloginLastResort, resolveReloginLastResortConfig, withLastResort,
} from '../../src/core/ReloginLastResortProvider.js';
import type { AnthropicHeadlessConfig } from '../../src/providers/adapters/anthropic-headless/config.js';
import type { OneShotCompletion } from '../../src/providers/primitives/transport/oneShotCompletion.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'relogin-last-resort test cleanup' }); });

function provider(opts: { key?: unknown; config?: Parameters<typeof resolveReloginLastResortConfig>[0]; answer?: () => Promise<string>; now?: () => number } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-last-resort-')); dirs.push(stateDir);
  const vault = new Map<string, unknown>();
  if (opts.key !== undefined) vault.set(RELOGIN_LAST_RESORT_DEFAULT_KEY_NAME, opts.key);
  const configs: AnthropicHeadlessConfig[] = [];
  const evaluate = vi.fn(async () => ({ text: await (opts.answer ?? (async () => ' next \n'))(), usage: null }));
  const createCompletion = vi.fn((config: AnthropicHeadlessConfig): OneShotCompletion => {
    configs.push(config);
    return { capability: 'one-shot-completion', evaluate } as unknown as OneShotCompletion;
  });
  const p = new ReloginLastResortProvider({ config: opts.config, readSecret: (name) => vault.get(name),
    claudePath: '/usr/local/bin/claude', tmuxPath: '/usr/local/bin/tmux', stateDir, createCompletion, now: opts.now });
  return { p, vault, configs, evaluate, createCompletion, stateDir };
}

describe('resolveReloginLastResortConfig', () => {
  it('absent ⇒ on, the repair-specific key name, the fast (haiku) tier, 60 per drive, 300 per day', () => {
    expect(resolveReloginLastResortConfig(undefined)).toEqual({ enabled: true, keyName: RELOGIN_LAST_RESORT_DEFAULT_KEY_NAME,
      model: RELOGIN_LAST_RESORT_DEFAULT_MODEL, maxCallsPerDrive: 60, maxCallsPerDay: 300 });
    expect(RELOGIN_LAST_RESORT_DEFAULT_MODEL).toBe('fast');
  });
  it('honors enabled:false, a valid key name / tier, and positive integer caps; rejects junk by falling back', () => {
    expect(resolveReloginLastResortConfig({ enabled: false }).enabled).toBe(false);
    expect(resolveReloginLastResortConfig({ keyName: 'my_key_2', model: 'balanced', maxCallsPerDrive: 5, maxCallsPerDay: 9 }))
      .toMatchObject({ keyName: 'my_key_2', model: 'balanced', maxCallsPerDrive: 5, maxCallsPerDay: 9 });
    expect(resolveReloginLastResortConfig({ keyName: 'Bad Name!', model: 'claude-opus-4-8', maxCallsPerDrive: 0, maxCallsPerDay: -1 }))
      .toMatchObject({ keyName: RELOGIN_LAST_RESORT_DEFAULT_KEY_NAME, model: 'fast', maxCallsPerDrive: 60, maxCallsPerDay: 300 });
  });
  it('createReloginLastResort returns null only for enabled:false; a missing key still constructs (picked up live)', () => {
    const base = { readSecret: () => undefined, claudePath: 'claude', tmuxPath: 'tmux', stateDir: os.tmpdir(),
      createCompletion: () => { throw new Error('not called'); } };
    expect(createReloginLastResort({ ...base, config: { enabled: false }, readSecret: () => 'k' })).toBeNull();
    const p = createReloginLastResort({ ...base, config: undefined });
    expect(p).not.toBeNull();
    expect(p!.available()).toBe(false);
  });
});

describe('ReloginLastResortProvider', () => {
  it('available() is live from the vault: false without a key, true once a string key is present, false again when removed', () => {
    const { p, vault } = provider();
    expect(p.available()).toBe(false);
    vault.set(RELOGIN_LAST_RESORT_DEFAULT_KEY_NAME, 'sk-ant-test');
    expect(p.available()).toBe(true);
    vault.set(RELOGIN_LAST_RESORT_DEFAULT_KEY_NAME, { not: 'a string' });
    expect(p.available()).toBe(false);
  });

  it('runs the one-shot with the key as the adapter credential, its OWN lightweight tier (never the caller\'s), a dedicated empty config home; returns the trimmed text', async () => {
    const { p, configs, evaluate, stateDir } = provider({ key: 'sk-ant-test' });
    const answer = await p.evaluate('page=... offered=["next"]', { model: 'balanced', maxTokens: 20, temperature: 0, timeoutMs: 5_000 });
    expect(answer).toBe('next');
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ claudePath: '/usr/local/bin/claude', credential: 'sk-ant-test', defaultModel: 'fast',
      defaultOneShotTimeoutMs: 5_000, configDir: path.join(stateDir, 'relogin-last-resort-claude-home') });
    expect(fs.statSync(configs[0]!.configDir!).isDirectory()).toBe(true);
    expect(evaluate).toHaveBeenCalledWith('page=... offered=["next"]', expect.objectContaining({ model: 'fast', maxTokens: 20, temperature: 0 }));
    expect(JSON.stringify(p.status())).not.toContain('sk-ant-test');
    expect(p.status()).toMatchObject({ available: true, callsToday: 1, lastError: null, model: 'fast' });
  });

  it('a one-shot failure or an empty answer throws a named error carrying only the error class, never the key', async () => {
    const down = provider({ key: 'sk-ant-test', answer: async () => { const e = new Error('claude exited 1'); e.name = 'ProviderError'; throw e; } });
    await expect(down.p.evaluate('x')).rejects.toThrow('relogin-last-resort-call-failed:ProviderError');
    expect(down.p.status().lastError).toBe('ProviderError');
    expect(JSON.stringify(down.p.status())).not.toContain('sk-ant-test');
    const empty = provider({ key: 'sk-ant-test', answer: async () => '  ' });
    await expect(empty.p.evaluate('x')).rejects.toThrow('relogin-last-resort-empty-answer');
    expect(empty.p.status().lastError).toBe('empty-answer');
  });

  it('refuses without a key or when disabled, before any one-shot is built', async () => {
    const { p, createCompletion } = provider();
    await expect(p.evaluate('x')).rejects.toThrow('relogin-last-resort-key-missing');
    const off = provider({ key: 'sk', config: { enabled: false } });
    await expect(off.p.evaluate('x')).rejects.toThrow('relogin-last-resort-disabled');
    expect(createCompletion).not.toHaveBeenCalled();
    expect(off.createCompletion).not.toHaveBeenCalled();
  });

  it('caps calls per drive (reset by endDrive/beginDrive) and per UTC day (reset at the day boundary)', async () => {
    let now = Date.parse('2026-10-22T23:59:00.000Z');
    const { p, evaluate } = provider({ key: 'sk', config: { maxCallsPerDrive: 2, maxCallsPerDay: 3 }, now: () => now });
    p.beginDrive('ep-1');
    await p.evaluate('a'); await p.evaluate('b');
    await expect(p.evaluate('c')).rejects.toThrow('relogin-last-resort-drive-cap-reached');
    expect(p.status()).toMatchObject({ callsThisDrive: 2, callsToday: 2, capRefusals: 1, driveEpisodeId: 'ep-1' });
    p.endDrive('ep-1');
    p.beginDrive('ep-2');
    await p.evaluate('d'); // third call of the day
    await expect(p.evaluate('e')).rejects.toThrow('relogin-last-resort-daily-cap-reached');
    expect(evaluate).toHaveBeenCalledTimes(3);
    now += 2 * 60_000; // past midnight UTC
    await p.evaluate('f');
    expect(p.status()).toMatchObject({ callsToday: 1, callsThisDrive: 2, capRefusals: 2 });
    // endDrive for a different episode never clears the live drive.
    p.endDrive('ep-1');
    expect(p.status().driveEpisodeId).toBe('ep-2');
  });
});

describe('withLastResort', () => {
  it('answers from the primary when it works; the last resort is never touched', async () => {
    const lastResort = { available: vi.fn(() => true), evaluate: vi.fn(async () => 'fallback') };
    const w = withLastResort(async () => 'primary', lastResort);
    expect(await w.evaluate('p')).toBe('primary');
    expect(lastResort.evaluate).not.toHaveBeenCalled();
    expect(w.stats()).toEqual({ primaryAnswered: 1, lastResortAnswered: 0, lastResortFailed: 0, primarySkipped: 0 });
  });

  it('falls to the last resort when the primary throws, naming the primary failure to the callback', async () => {
    const lastResort = { available: vi.fn(() => true), evaluate: vi.fn(async () => 'fallback') };
    const onFallback = vi.fn();
    const w = withLastResort(async () => { throw new Error('claude -p: Login expired'); }, lastResort, onFallback);
    expect(await w.evaluate('p', { maxTokens: 20 })).toBe('fallback');
    expect(onFallback).toHaveBeenCalledWith('claude -p: Login expired');
    expect(lastResort.evaluate).toHaveBeenCalledWith('p', { maxTokens: 20 });
    expect(w.stats()).toMatchObject({ lastResortAnswered: 1 });
  });

  it('with no primary at all, the last resort answers directly', async () => {
    const lastResort = { available: () => true, evaluate: async () => 'fallback' };
    expect(await withLastResort(null, lastResort).evaluate('p')).toBe('fallback');
  });

  it('rethrows the PRIMARY failure when the last resort is absent or unavailable (the driver sees the same error as before)', async () => {
    const primary = async () => { throw new Error('primary-down'); };
    await expect(withLastResort(primary, null).evaluate('p')).rejects.toThrow('primary-down');
    const unavailable = { available: () => false, evaluate: vi.fn(async () => 'never') };
    await expect(withLastResort(primary, unavailable).evaluate('p')).rejects.toThrow('primary-down');
    expect(unavailable.evaluate).not.toHaveBeenCalled();
  });

  it('a last-resort failure (cap, provider) is surfaced as its own error and counted', async () => {
    const lastResort = { available: () => true, evaluate: async () => { throw new Error('relogin-last-resort-daily-cap-reached'); } };
    const w = withLastResort(async () => { throw new Error('primary-down'); }, lastResort);
    await expect(w.evaluate('p')).rejects.toThrow('relogin-last-resort-daily-cap-reached');
    expect(w.stats()).toMatchObject({ lastResortFailed: 1 });
  });

  it('an aborted primary call is not retried on the last resort', async () => {
    const controller = new AbortController();
    const lastResort = { available: () => true, evaluate: vi.fn(async () => 'never') };
    const w = withLastResort(async () => { controller.abort(); throw new Error('aborted'); }, lastResort);
    await expect(w.evaluate('p', { signal: controller.signal })).rejects.toThrow('aborted');
    expect(lastResort.evaluate).not.toHaveBeenCalled();
  });

  it('applies primaryTimeoutMs to the PRIMARY call only; the last resort keeps the caller\'s options', async () => {
    const primary = vi.fn(async () => { throw new Error('primary-down'); });
    const lastResort = { available: () => true, evaluate: vi.fn(async () => 'fallback') };
    const w = withLastResort(primary, lastResort, undefined, { primaryTimeoutMs: 15_000 });
    await w.evaluate('p', { maxTokens: 20, timeoutMs: 60_000 });
    expect(primary).toHaveBeenCalledWith('p', { maxTokens: 20, timeoutMs: 15_000 });
    expect(lastResort.evaluate).toHaveBeenCalledWith('p', { maxTokens: 20, timeoutMs: 60_000 });
  });

  it('sticky within a drive: once the last resort is preferred, the primary is skipped (no per-step timeout) and counted', async () => {
    let preferred = false;
    const primary = vi.fn(async () => { throw new Error('primary-hangs-then-times-out'); });
    const lastResort = { available: () => true, preferred: () => preferred, evaluate: vi.fn(async () => { preferred = true; return 'fallback'; }) };
    const onFallback = vi.fn();
    const w = withLastResort(primary, lastResort, onFallback);
    expect(await w.evaluate('step-1')).toBe('fallback');
    expect(await w.evaluate('step-2')).toBe('fallback');
    expect(await w.evaluate('step-3')).toBe('fallback');
    expect(primary).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledTimes(1); // one warning per drive, not per step
    expect(w.stats()).toMatchObject({ lastResortAnswered: 3, primarySkipped: 2 });
  });
});

describe('ReloginLastResortProvider sticky preference + metering', () => {
  it('preferred() is true only inside a drive, after a successful answer, while the key is present; reset by endDrive', async () => {
    const { p, vault } = provider({ key: 'sk' });
    expect(p.preferred()).toBe(false);
    await p.evaluate('outside-a-drive');
    expect(p.preferred()).toBe(false); // no drive open: every call still tries the primary first
    p.beginDrive('ep-1');
    expect(p.preferred()).toBe(false);
    await p.evaluate('step');
    expect(p.preferred()).toBe(true);
    expect(p.status()).toMatchObject({ preferredThisDrive: true });
    vault.delete(RELOGIN_LAST_RESORT_DEFAULT_KEY_NAME);
    expect(p.preferred()).toBe(false); // key removed live ⇒ never preferred
    vault.set(RELOGIN_LAST_RESORT_DEFAULT_KEY_NAME, 'sk');
    p.endDrive('ep-1');
    expect(p.preferred()).toBe(false);
  });

  it('a failed answer does not make the provider preferred', async () => {
    const { p } = provider({ key: 'sk', answer: async () => { throw new Error('boom'); } });
    p.beginDrive('ep-1');
    await expect(p.evaluate('step')).rejects.toThrow('relogin-last-resort-call-failed');
    expect(p.preferred()).toBe(false);
  });

  it('records every call on the feature-metrics ledger under the caller\'s attribution, framework anthropic-api-key, never the key or the prompt', async () => {
    const { setFeatureMetricsRecorder } = await import('../../src/core/CircuitBreakingIntelligenceProvider.js');
    const record = vi.fn();
    setFeatureMetricsRecorder({ record });
    try {
      const ok = provider({ key: 'sk-ant-test' });
      await ok.p.evaluate('page=secret-looking-prompt', { attribution: { component: 'subscription-relogin-supervisor' } });
      const failing = provider({ key: 'sk-ant-test', answer: async () => { throw new Error('boom'); } });
      await expect(failing.p.evaluate('x')).rejects.toThrow();
      expect(record).toHaveBeenCalledTimes(2);
      expect(record.mock.calls[0]![0]).toMatchObject({ feature: 'subscription-relogin-supervisor', kind: 'llm', outcome: 'unclassified', model: 'fast', framework: 'anthropic-api-key' });
      expect(record.mock.calls[1]![0]).toMatchObject({ feature: 'subscription-relogin-last-resort', outcome: 'error', framework: 'anthropic-api-key' });
      const serialized = JSON.stringify(record.mock.calls);
      expect(serialized).not.toContain('sk-ant-test');
      expect(serialized).not.toContain('secret-looking-prompt');
    } finally {
      setFeatureMetricsRecorder(null);
    }
  });
});
