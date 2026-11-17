import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('issues group profile defaults', () => {
  it('defaults every issue topic to Codex, while main and Slack keep their defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-profile-'));
    try {
      const store = new TopicProfileStore({ stateFilePath: path.join(dir, 'profiles.json') });
      const resolver = new TopicProfileResolver({
        store,
        defaultFramework: () => 'claude-code',
        configTopicFrameworks: () => ({}),
        configProfileDefaults: () => ({}),
        frameworkDefaultModels: () => ({ 'codex-cli': 'gpt-5.6-sol' }),
        tierEscalationConfig: () => undefined,
        localModelBinding: () => null,
        frameworkBinaryPath: () => '/usr/bin/true',
        codexModelSupported: () => true,
      });
      const issue = resolver.resolve(10_000_001_618);
      expect(issue.framework).toBe('codex-cli');
      expect(issue.model).toBe('gpt-6.2-sol');
      expect(resolver.resolve(1618).framework).toBe('claude-code');
      expect(resolver.resolve('slack:C123:1.2').framework).toBe('claude-code');
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'echo-bugs-profile-default test cleanup' }); }
  });


  it('keeps Codex when a config override changes only the issues model', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-profile-'));
    try {
      const resolver = new TopicProfileResolver({
        store: new TopicProfileStore({ stateFilePath: path.join(dir, 'profiles.json') }),
        defaultFramework: () => 'claude-code', configTopicFrameworks: () => ({}), configProfileDefaults: () => ({}),
        configGroupDefaults: () => ({ issues: { model: 'gpt-6-sol' } }),
        frameworkDefaultModels: () => ({}), tierEscalationConfig: () => undefined,
        localModelBinding: () => null, frameworkBinaryPath: () => '/usr/bin/true', codexModelSupported: () => true,
      });
      expect(resolver.resolve(10_000_001_618)).toMatchObject({ framework: 'codex-cli', model: 'gpt-6-sol' });
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'echo-bugs-profile-default test cleanup' }); }
  });

  it('keeps a verified operator pin above the issues group policy after a store reload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-profile-'));
    try {
      const stateFilePath = path.join(dir, 'profiles.json');
      const store = new TopicProfileStore({ stateFilePath });
      await store.mutate(10_000_001_618, { framework: 'claude-code', model: 'claude-opus-5-5', updatedBy: 'telegram:777' });
      const resolver = new TopicProfileResolver({
        store: new TopicProfileStore({ stateFilePath }),
        defaultFramework: () => 'claude-code', configTopicFrameworks: () => ({}), configProfileDefaults: () => ({}),
        configGroupDefaults: () => ({ issues: { framework: 'codex-cli', model: 'gpt-6.1-sol' } }),
        frameworkDefaultModels: () => ({}), tierEscalationConfig: () => undefined,
        localModelBinding: () => null, frameworkBinaryPath: () => '/usr/bin/true', codexModelSupported: () => true,
      });
      expect(resolver.resolve(10_000_001_618)).toMatchObject({ framework: 'claude-code', model: 'claude-opus-5-5' });
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'echo-bugs-profile-default test cleanup' }); }
  });

  it('uses gpt-6-sol with a plain note when this machine has an older Codex CLI', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-profile-'));
    try {
      const resolver = new TopicProfileResolver({
        store: new TopicProfileStore({ stateFilePath: path.join(dir, 'profiles.json') }),
        defaultFramework: () => 'claude-code', configTopicFrameworks: () => ({}), configProfileDefaults: () => ({}),
        configGroupDefaults: () => ({ issues: { framework: 'codex-cli', model: 'gpt-6.1-sol' } }),
        frameworkDefaultModels: () => ({}), tierEscalationConfig: () => undefined,
        localModelBinding: () => null, frameworkBinaryPath: () => '/usr/bin/true', codexModelSupported: () => false,
      });
      const result = resolver.resolve(10_000_001_618);
      expect(result.model).toBe('gpt-6-sol');
      expect(result.notices.join(' ')).toMatch(/older Codex CLI.*gpt-6-sol/);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'echo-bugs-profile-default test cleanup' }); }
  });

  it.each([
    ['gpt-6.2-sol', 'gpt-6-sol'],
    ['gpt-6.2-astra', 'gpt-6-astra'],
    ['gpt-6.1-sol', 'gpt-6-sol'],
  ])('falls back from %s to %s on an older Codex CLI, and keeps it on a current one', (wanted, older) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-profile-'));
    try {
      const make = (supported: boolean) => new TopicProfileResolver({
        store: new TopicProfileStore({ stateFilePath: path.join(dir, `profiles-${supported}.json`) }),
        defaultFramework: () => 'codex-cli', configTopicFrameworks: () => ({}), configProfileDefaults: () => ({}),
        frameworkDefaultModels: () => ({ 'codex-cli': wanted }), tierEscalationConfig: () => undefined,
        localModelBinding: () => null, frameworkBinaryPath: () => '/usr/bin/true', codexModelSupported: () => supported,
      });
      const old = make(false).resolve(4242);
      expect(old.model).toBe(older);
      expect(old.sources.model).toBe('older-codex-cli-fallback');
      expect(old.notices.join(' ')).toContain(`cannot run ${wanted}; using ${older}`);
      const current = make(true).resolve(4242);
      expect(current.model).toBe(wanted);
      expect(current.notices).toEqual([]);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'echo-bugs-profile-default test cleanup' }); }
  });

  it('leaves a model with no older-CLI fallback alone even on an older CLI', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-profile-'));
    try {
      const resolver = new TopicProfileResolver({
        store: new TopicProfileStore({ stateFilePath: path.join(dir, 'profiles.json') }),
        defaultFramework: () => 'codex-cli', configTopicFrameworks: () => ({}), configProfileDefaults: () => ({}),
        frameworkDefaultModels: () => ({ 'codex-cli': 'gpt-6-luna' }), tierEscalationConfig: () => undefined,
        localModelBinding: () => null, frameworkBinaryPath: () => '/usr/bin/true', codexModelSupported: () => false,
      });
      expect(resolver.resolve(4242).model).toBe('gpt-6-luna');
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'echo-bugs-profile-default test cleanup' }); }
  });
});
