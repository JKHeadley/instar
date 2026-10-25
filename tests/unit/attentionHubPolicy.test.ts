import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  admitItemToHub,
  admitNoticeToHub,
  recordHeldHubPost,
  resolveHubFilterMode,
} from '../../src/messaging/attentionHubPolicy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const item = (over: Partial<Parameters<typeof admitItemToHub>[0]> = {}) => ({
  id: 'x', priority: 'NORMAL' as const, sourceContext: 'passkey-health', ...over,
});

describe('attentionHubPolicy — items', () => {
  it('holds routine automated status (the observed noise sources)', () => {
    for (const sourceContext of ['passkey-health', 'machine-coherence-guard', 'telegram-origin-forward-to-holder', 'stale-owner-release:m_1', 'orphaned-work:foo']) {
      expect(admitItemToHub(item({ sourceContext, priority: 'HIGH' }), 'signal')).toEqual({ admit: false, reason: 'automated-status' });
    }
  });

  it('admits urgent, agent-raised and needsUser items', () => {
    expect(admitItemToHub(item({ priority: 'URGENT' }), 'signal').admit).toBe(true);
    expect(admitItemToHub(item({ sourceContext: 'agent', priority: 'LOW' }), 'signal').admit).toBe(true);
    expect(admitItemToHub(item({ needsUser: true }), 'signal').admit).toBe(true);
  });

  it('admits needs-user sources and respects their narrowing', () => {
    expect(admitItemToHub(item({ sourceContext: 'assisted-subscription-relogin', priority: 'HIGH' }), 'signal').admit).toBe(true);
    // the "signed in again, nothing to do" follow-up is NORMAL
    expect(admitItemToHub(item({ sourceContext: 'assisted-subscription-relogin', priority: 'NORMAL' }), 'signal').admit).toBe(false);
    expect(admitItemToHub(item({ sourceContext: 'duplicate-reconciler', id: 'dup-reconciler-escalate:telegram:1', priority: 'HIGH' }), 'signal').admit).toBe(true);
    expect(admitItemToHub(item({ sourceContext: 'duplicate-reconciler', id: 'dup-reconciler-breaker:telegram:1', priority: 'HIGH' }), 'signal').admit).toBe(false);
    expect(admitItemToHub(item({ sourceContext: 'feedback-triage:action-list' }), 'signal').admit).toBe(true);
  });

  it("mode 'all' admits everything (rollback)", () => {
    expect(admitItemToHub(item(), 'all').admit).toBe(true);
  });
});

describe('attentionHubPolicy — notices', () => {
  it('admits user-impact categories and holds the rest', () => {
    expect(admitNoticeToHub('inbound-loss', 'SUMMARY', 'signal').admit).toBe(true);
    expect(admitNoticeToHub('mutual-ssh-host-key-change', 'IMMEDIATE', 'signal').admit).toBe(true);
    expect(admitNoticeToHub('quota', 'IMMEDIATE', 'signal').admit).toBe(true);
    expect(admitNoticeToHub('session-reap', 'SUMMARY', 'signal').admit).toBe(true); // interrupted user work
    expect(admitNoticeToHub('quota', 'SUMMARY', 'signal').admit).toBe(false);
    expect(admitNoticeToHub('system', 'IMMEDIATE', 'signal').admit).toBe(false); // worktree scans
    expect(admitNoticeToHub('system-review', 'SUMMARY', 'signal').admit).toBe(false);
    expect(admitNoticeToHub('system', 'IMMEDIATE', 'all').admit).toBe(true);
  });
});

describe('attentionHubPolicy — config + audit', () => {
  it('defaults to signal; only an explicit "all" turns it off', () => {
    expect(resolveHubFilterMode(undefined)).toBe('signal');
    expect(resolveHubFilterMode('garbage')).toBe('signal');
    expect(resolveHubFilterMode('all')).toBe('all');
  });

  it('records held posts to logs/attention-hub-held.jsonl', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-held-'));
    try {
      recordHeldHubPost(dir, { kind: 'item', reason: 'automated-status', id: 'a', title: 'Passkey health' });
      const rows = fs.readFileSync(path.join(dir, 'attention-hub-held.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'item', reason: 'automated-status', id: 'a', title: 'Passkey health' });
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'attentionHubPolicy test cleanup' });
    }
  });
});
