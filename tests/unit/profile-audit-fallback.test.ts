import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendTopicProfileAudit } from '../../src/core/topicProfileAudit.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/profile-audit-fallback.test.ts:cleanup' });
});
it('writes a deciding-machine refusal trace before returning when the primary audit path cannot be created', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-audit-fallback-')); dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'logs'), 'a file prevents the audit directory');
  const captured = vi.spyOn(console, 'error').mockImplementation(() => {});
  const health = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => {});
  const seq = appendTopicProfileAudit(path.join(dir, '.instar'), {
    type: 'proposal-reply-result', topic: '23', requestId: 'R-test', messageId: 51,
    outcome: 'refused', reason: 'ownership-changed', patch: { privateText: 'never-log-this-value' },
  });
  expect(seq).toEqual(expect.any(String));
  const trace = captured.mock.calls.find(call => call[0] === '[topic-profile-audit-fallback]');
  expect(trace).toBeDefined();
  expect(JSON.parse(String(trace![1]))).toMatchObject({ seq, topic: '23', messageId: 51, outcome: 'refused', refusalReason: 'ownership-changed' });
  expect(JSON.stringify(trace)).not.toContain('never-log-this-value');
  expect(health).toHaveBeenCalledWith(expect.objectContaining({ feature: 'topic-profile.audit', internalOnly: true }));
});
