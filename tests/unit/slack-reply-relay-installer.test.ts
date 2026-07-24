import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSlackReplyRelay, isSlackConfigured, slackReplyRelayReadiness } from '../../src/core/SlackReplyRelayInstaller.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'slack-reply-relay-installer:test-cleanup' });
  }
});

function fixture() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-relay-installer-'));
  dirs.push(projectDir);
  const stateDir = path.join(projectDir, '.instar');
  return { projectDir, stateDir };
}

describe('SlackReplyRelayInstaller', () => {
  it('installs executable neutral + compatibility copies only for enabled Slack', () => {
    const f = fixture();
    const config = { messaging: [{ type: 'slack' }] };
    expect(isSlackConfigured(config)).toBe(true);
    const result = ensureSlackReplyRelay({ ...f, config, template: '#!/bin/sh\necho relay\n' });
    expect(result.errors).toEqual([]);
    for (const p of [path.join(f.stateDir, 'scripts/slack-reply.sh'), path.join(f.projectDir, '.claude/scripts/slack-reply.sh')]) {
      expect(fs.readFileSync(p, 'utf8')).toContain('echo relay');
      expect(fs.statSync(p).mode & 0o777).toBe(0o755);
    }
  });

  it('preserves customized canonical bytes and writes a current candidate', () => {
    const f = fixture();
    const destination = path.join(f.stateDir, 'scripts/slack-reply.sh');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, '# shipped header retained\ncustom behavior\n');
    const result = ensureSlackReplyRelay({ ...f, config: { messaging: [{ type: 'slack', enabled: true }] }, template: 'current\n' });
    expect(fs.readFileSync(destination, 'utf8')).toContain('custom behavior');
    expect(fs.readFileSync(`${destination}.new`, 'utf8')).toBe('current\n');
    expect(result.degraded).toHaveLength(1);
  });

  it('is a strict no-op for disabled Slack', () => {
    const f = fixture();
    const result = ensureSlackReplyRelay({ ...f, config: { messaging: [{ type: 'slack', enabled: false }] }, template: 'x' });
    expect(result).toEqual({ installed: [], current: [], degraded: [], errors: [] });
    expect(fs.existsSync(path.join(f.stateDir, 'scripts/slack-reply.sh'))).toBe(false);
  });

  it('refuses readiness for customized canonical bytes even when a candidate exists', () => {
    const f = fixture();
    const destination = path.join(f.stateDir, 'scripts/slack-reply.sh');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'custom\n', { mode: 0o755 });
    ensureSlackReplyRelay({ ...f, config: { messaging: [{ type: 'slack' }] }, template: 'current\n' });
    expect(slackReplyRelayReadiness(f.stateDir, 'current\n')).toEqual({
      ready: false,
      reason: 'canonical relay bytes do not match the packaged template',
    });
  });
});
