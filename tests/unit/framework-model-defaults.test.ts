import { describe, expect, it, vi } from 'vitest';
import { newestCodexFamilyModel, resolveFrameworkModelDefault, validFrameworkModelDefaults } from '../../src/core/frameworkModelDefaults.js';

describe('framework model defaults', () => {
  it('resolves a family from the packaged registry', () => {
    expect(resolveFrameworkModelDefault('codex-cli', 'latest:sol')).toBe('gpt-6.2-sol');
    expect(resolveFrameworkModelDefault('codex-cli', 'latest:astra')).toBe('gpt-6.2-astra');
  });

  it('sorts versions numerically and keeps model families separate', () => {
    const models = ['gpt-6.2-sol', 'gpt-6.10-sol', 'gpt-7-astra', 'gpt-7.1-sol-preview'];
    expect(newestCodexFamilyModel('sol', models)).toBe('gpt-6.10-sol');
    expect(newestCodexFamilyModel('astra', models)).toBe('gpt-7-astra');
    expect(newestCodexFamilyModel('luna', models)).toBeUndefined();
  });

  it('keeps pins and unset defaults valid', () => {
    expect(resolveFrameworkModelDefault('codex-cli', 'gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(resolveFrameworkModelDefault('claude-code', undefined)).toBeUndefined();
  });

  it('rejects malformed edits and uses the built-in balanced model for an invalid saved selector', () => {
    expect(validFrameworkModelDefaults({ 'codex-cli': 'latest:sol', 'pi-cli': 'openai/gpt-5.5' })).toBe(true);
    expect(validFrameworkModelDefaults({ 'codex-cli': 'latest:luna' })).toBe(false);
    expect(validFrameworkModelDefaults({ 'codex-cli': 42 })).toBe(false);
    expect(resolveFrameworkModelDefault('codex-cli', 'latest:unsupported')).toBe('gpt-6.2-sol');
    expect(resolveFrameworkModelDefault('pi-cli', 'latest:vendor-model')).toBe('latest:vendor-model');
  });

  it('uses the balanced model for an inherited selector when the catalog is unavailable', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      const readFileSync = vi.fn(actual.readFileSync).mockImplementationOnce(() => {
        throw new Error('Packaged manifest missing');
      });
      return { ...actual, readFileSync };
    });

    try {
      const { resolveFrameworkModelDefault: resolve, validFrameworkModelDefaults: validate } = await import('../../src/core/frameworkModelDefaults.js');
      expect(resolve('codex-cli', 'latest:sol')).toBe('gpt-6.2-sol');
      expect(resolve('codex-cli', 'latest:astra')).toBe('gpt-6.2-sol');
      expect(resolve('codex-cli', 'gpt-6.1-sol')).toBe('gpt-6.1-sol');
      expect(validate({ 'pi-cli': 'openai/gpt-5.5' })).toBe(true);
      expect(validate({ 'codex-cli': 'latest:astra' })).toBe(false);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});
