import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../../src/core/SessionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/memory-session-inbound-claims.test.ts' });
});

function fixture(topicId: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-claim-'));
  dirs.push(root);
  const projectDir = path.join(root, 'agent');
  const stateDir = path.join(root, 'state');
  const scope = path.join(root, 'scope');
  fs.mkdirSync(path.join(scope, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'telegram-documents'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.instar', 'telegram-inbound'), { recursive: true });
  const manager = Object.create(SessionManager.prototype) as SessionManager & Record<string, any>;
  manager.config = { projectDir, stateDir };
  manager.memoryPrivacyWiring = { privacy: { enabled: true } };
  manager.memoryInboundClaims = new Map();
  manager.listRunningSessions = () => [{ tmuxSession: 'test', telegramTopicId: topicId, memoryScopeDir: scope }];
  return { root, projectDir, stateDir, scope, manager };
}

describe('privacy-on inbound claims at session injection', () => {
  it('stages a claimed PDF for a running session and rejects the same path in another topic', () => {
    const { stateDir, scope, manager } = fixture(1);
    const pdf = path.join(stateDir, 'telegram-documents', 'sent.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4\n%%EOF\n');
    manager.registerMemoryInboundFile('telegram:1', pdf);
    const result = manager.withInboundFilesInScope('test', `Read ${pdf}`);
    expect(result).toContain(`${scope}/inbox/`);
    const staged = result.match(/\/inbox\/[^\s]+\.pdf/)?.[0];
    expect(staged && fs.readFileSync(`${scope}${staged}`, 'utf8')).toContain('%PDF-1.4');
    manager.listRunningSessions = () => [{ tmuxSession: 'test', telegramTopicId: 2, memoryScopeDir: scope }];
    expect(manager.withInboundFilesInScope('test', `Read ${pdf}`)).toContain(pdf);
  });

  it('rewrites an attachment inside a claimed fresh-session bootstrap', () => {
    const { projectDir, stateDir, scope, manager } = fixture(1);
    const pdf = path.join(stateDir, 'telegram-documents', 'sent.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4\n%%EOF\n');
    const wrapper = path.join(projectDir, '.instar', 'telegram-inbound', 'bootstrap-1-123.txt');
    fs.writeFileSync(wrapper, `[telegram:1] See ${pdf}`);
    manager.registerMemoryInboundFile('telegram:1', pdf);
    manager.registerMemoryInboundFile('telegram:1', wrapper);
    const result = manager.withInboundFilesInScope('test', `Read ${wrapper}`);
    const stagedWrapper = result.match(/\/inbox\/[^\s]+\.txt/)?.[0];
    expect(stagedWrapper).toBeDefined();
    const nested = fs.readFileSync(`${scope}${stagedWrapper}`, 'utf8');
    expect(nested).toContain(`${scope}/inbox/`);
    expect(nested).not.toContain(pdf);
  });
});
