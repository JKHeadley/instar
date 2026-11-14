// safe-fs-allow: isolated fixture transcript directory only.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { confirmSessionUsageLimit } from '../../src/monitoring/sessionUsageLimitEvidence.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { resolveFrameworkTranscriptPath } from '../../src/core/FrameworkSessionStore.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'usage-limit-test:cleanup' })));
// Captured read-only from Claude Code 2.1.300, 2026-11-05T19:06:18.095Z,
// account-home projects/-private-tmp/5e6d08f9-*.jsonl. UUID anonymized.
const ownError = { type: 'assistant', sessionId: 'parent-id', error: 'rate_limit', isApiErrorMessage: true, message: { content: [{ type: 'text', text: "You've hit your weekly limit · resets Nov 8 at 3am (America/Los_Angeles)" }] } };
function fixture(rows: unknown[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-evidence-')); dirs.push(home);
  const transcript = resolveFrameworkTranscriptPath({ framework: 'claude-code', sessionId: 'parent-id', projectDir: '/project', configHome: home });
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { transcript, home };
}
describe('exact serving-session usage-limit evidence', () => {
  it('uses the serving session UUID, cwd and account home through SessionManager', () => {
    const { home } = fixture([ownError]);
    const manager = { listRunningSessions: () => [{ tmuxSession: 'parent', claudeSessionId: 'parent-id', cwd: '/project', framework: 'claude-code' }],
      configHomeForSession: () => home, config: { projectDir: '/wrong-project' } };
    expect(SessionManager.prototype.confirmSessionUsageLimit.call(manager as any, 'parent')).toBe('parent-id');
    expect(SessionManager.prototype.confirmSessionUsageLimit.call(manager as any, 'helper')).toBe(false);
  });
  it('usageWallFromTranscript reads the same exact transcript and tells the wall from the throttle', () => {
    const { home } = fixture([ownError]);
    const manager = { listRunningSessions: () => [{ tmuxSession: 'parent', claudeSessionId: 'parent-id', cwd: '/project', framework: 'claude-code' }],
      configHomeForSession: () => home, config: { projectDir: '/wrong-project' } };
    expect(SessionManager.prototype.usageWallFromTranscript.call(manager as any, 'parent')).toContain('weekly limit');
    expect(SessionManager.prototype.usageWallFromTranscript.call(manager as any, 'helper')).toBeNull();
    const throttle = fixture([{ ...ownError, message: { content: [{ type: 'text', text: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited' }] } }]);
    const m2 = { ...manager, configHomeForSession: () => throttle.home };
    expect(SessionManager.prototype.usageWallFromTranscript.call(m2 as any, 'parent')).toBeNull();
    expect(SessionManager.prototype.confirmSessionUsageLimit.call(m2 as any, 'parent')).toBe('parent-id');
  });
  it.each([
    [{ ...ownError, isSidechain: true }],
    [{ ...ownError, agentId: 'builder' }],
    [{ ...ownError, sessionId: 'helper-id' }],
    [{ type: 'user', sessionId: 'parent-id', message: { content: [{ type: 'tool_result', content: JSON.stringify(ownError) }] } }],
    [ownError, { type: 'assistant', sessionId: 'parent-id', message: { content: [{ type: 'text', text: 'Resuming builders' }] } }],
    [ownError, { type: 'user', sessionId: 'parent-id', message: { content: 'continue' } }],
    [{ ...ownError, error: 'overloaded_error' }],
    [{ ...ownError, isApiErrorMessage: false }],
  ])('never treats helper/quoted/stale/untyped errors as the parent limit', (...rows) => {
    const { transcript } = fixture(rows);
    expect(confirmSessionUsageLimit(transcript, 'parent-id')).toBe(false);
  });
  it('fails toward no claim for unreadable/partial evidence', () => {
    const { transcript } = fixture([ownError]);
    fs.appendFileSync(transcript, '{"type":"assistant"');
    expect(confirmSessionUsageLimit(transcript, 'parent-id')).toBe(false);
    expect(confirmSessionUsageLimit('/does-not-exist', 'parent-id')).toBe(false);
  });
});
