import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { slackReplyRelayReadiness } from '../../src/core/SlackReplyRelayInstaller.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const prior = fs.readFileSync(path.join(root, 'tests/fixtures/slack-reply-2026-11-03.sh'), 'utf8');
const current = fs.readFileSync(path.join(root, 'src/templates/scripts/slack-reply.sh'), 'utf8');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'slack-reply-relay-migration:test-cleanup' });
  }
});

function fixture(script = prior) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-relay-migration-'));
  dirs.push(projectDir);
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ messaging: [{ type: 'slack', enabled: true }] }));
  const canonical = path.join(stateDir, 'scripts/slack-reply.sh');
  const compatibility = path.join(projectDir, '.claude/scripts/slack-reply.sh');
  for (const destination of [canonical, compatibility]) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, script, { mode: 0o755 });
  }
  return { projectDir, stateDir, canonical, compatibility };
}

function migrateScripts(projectDir: string, stateDir: string) {
  const migrator = new PostUpdateMigrator({ projectDir, stateDir, port: 4043, hasTelegram: false, projectName: 'indra-test' });
  const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
  (migrator as unknown as { migrateScripts(result: typeof result): void }).migrateScripts(result);
  return result;
}

describe('Slack reply relay update migration', () => {
  it('upgrades the exact shipped here-string relay for existing opted-in agents', () => {
    const old = fs.readFileSync(path.join(root, 'tests/fixtures/slack-reply-2026-11-05.sh'), 'utf8');
    const f = fixture(old);
    const result = migrateScripts(f.projectDir, f.stateDir);
    expect(result.errors.filter(error => error.includes('Slack reply relay'))).toEqual([]);
    for (const destination of [f.canonical, f.compatibility]) {
      expect(fs.readFileSync(destination, 'utf8')).toBe(current);
      expect(fs.readFileSync(`${destination}.bak.f16111eb9d39`, 'utf8')).toBe(old);
    }
    expect(slackReplyRelayReadiness(f.stateDir, current)).toEqual({ ready: true });
  });

  it('reconciles the prior shipped relay through the production migrator and is idempotent', () => {
    const f = fixture();
    const first = migrateScripts(f.projectDir, f.stateDir);
    expect(first.errors.filter(error => error.includes('Slack reply relay'))).toEqual([]);
    for (const destination of [f.canonical, f.compatibility]) {
      expect(fs.readFileSync(destination, 'utf8')).toBe(current);
      expect(fs.readFileSync(`${destination}.bak.166438d58f02`, 'utf8')).toBe(prior);
      expect(fs.existsSync(`${destination}.new`)).toBe(false);
    }
    expect(slackReplyRelayReadiness(f.stateDir, current)).toEqual({ ready: true });
    const second = migrateScripts(f.projectDir, f.stateDir);
    expect(second.errors.filter(error => error.includes('Slack reply relay'))).toEqual([]);
    expect(fs.readFileSync(f.canonical, 'utf8')).toBe(current);
  });

  it('keeps a customized canonical relay and reports it as not ready', () => {
    const f = fixture();
    fs.writeFileSync(f.canonical, '#!/bin/sh\necho operator-customized\n', { mode: 0o755 });
    const result = migrateScripts(f.projectDir, f.stateDir);
    expect(fs.readFileSync(f.canonical, 'utf8')).toContain('operator-customized');
    expect(fs.readFileSync(`${f.canonical}.new`, 'utf8')).toBe(current);
    expect(fs.readFileSync(f.compatibility, 'utf8')).toBe(current);
    expect(result.errors.some(error => error.includes(f.canonical) && error.includes('customized content preserved'))).toBe(true);
    expect(slackReplyRelayReadiness(f.stateDir, current).ready).toBe(false);
  });
});
