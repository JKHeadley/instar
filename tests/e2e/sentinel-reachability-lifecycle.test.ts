// safe-git-allow: test file — direct fs.rmSync is for tmpdir cleanup only.
//   Code under test (recoveryReachability) writes via injected callbacks,
//   which is what would route through SafeFsExecutor in production.

/**
 * E2E test — Sentinel Recovery Reachability.
 *
 * Closes the silent-no-op bug class confirmed 2026-05-24: RateLimitSentinel
 * (and siblings) detect failure correctly but their resume/notify outputs
 * are silently dropped when the session is not bound to a Telegram topic.
 *
 * The verification this test enforces (which the original v1.2.33 test
 * did NOT):
 *
 *   1. With a non-topic-bound session, a delivery attempt through the
 *      reachability helper MUST land at the lifeline topic.
 *   2. If neither a topic nor a lifeline exists, the attempt MUST surface as
 *      a `recovery-unreachable` audit event — never silently no-op.
 *   3. The audit-only fallback writes to BOTH the JSONL audit log AND the
 *      dashboard alerts file so operators have two surfaces to find it.
 *
 * Tier-3 reachability discipline: assert on the user-reachable destination,
 * not on internal sentinel events.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deliverReachable, type ReachabilityDeps } from '../../src/monitoring/recoveryReachability.js';

function makeTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

interface TestRig {
  tmp: string;
  auditPath: string;
  alertsPath: string;
  sent: Array<{ topicId: number; text: string }>;
  buildDeps: (over?: Partial<ReachabilityDeps>) => ReachabilityDeps;
}

function makeRig(): TestRig {
  const tmp = makeTmp('reach-e2e');
  const auditPath = path.join(tmp, 'sentinel-events.jsonl');
  const alertsPath = path.join(tmp, 'sentinel-alerts.json');
  const sent: Array<{ topicId: number; text: string }> = [];

  const auditUnreachable = (sessionName: string, sentinel: string, text: string, tried: string[]): void => {
    const entry = {
      ts: new Date().toISOString(),
      kind: 'recovery-unreachable',
      sentinel,
      sessionName,
      text,
      fallbackTried: tried,
    };
    fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n');
    const cur = fs.existsSync(alertsPath)
      ? JSON.parse(fs.readFileSync(alertsPath, 'utf-8')) as unknown[]
      : [];
    const next = (Array.isArray(cur) ? cur : []).concat([entry]).slice(-200);
    fs.writeFileSync(alertsPath, JSON.stringify(next, null, 2));
  };

  const buildDeps = (over: Partial<ReachabilityDeps> = {}): ReachabilityDeps => ({
    topicForSession: () => undefined,
    lifelineTopicId: () => undefined,
    sendToTopic: async (topicId, text) => { sent.push({ topicId, text }); },
    auditUnreachable,
    ...over,
  });

  return { tmp, auditPath, alertsPath, sent, buildDeps };
}

describe('Sentinel Reachability E2E', () => {
  let rig: TestRig;

  beforeEach(() => { rig = makeRig(); });
  afterEach(() => { try { fs.rmSync(rig.tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('T1 — non-topic-bound rate-limit recovery delivers to lifeline', async () => {
    const result = await deliverReachable(
      'echo-interactive-window',
      'rate-limit',
      'The temporary throttle should have cleared — please continue.',
      rig.buildDeps({
        topicForSession: () => undefined,         // NOT topic-bound (the bug case)
        lifelineTopicId: () => 9001,              // lifeline exists
      }),
    );

    // PRIMARY assertion — the message reached the user-visible channel.
    expect(result.reached).toBe('lifeline');
    expect(result.topicId).toBe(9001);
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0].topicId).toBe(9001);
    expect(rig.sent[0].text).toContain('rate-limit/echo-interactive-window');
    expect(rig.sent[0].text).toContain('throttle should have cleared');

    // SILENT-NO-OP REGRESSION ASSERTION — no audit-unreachable was written.
    expect(fs.existsSync(rig.auditPath)).toBe(false);
  });

  it('T2 — socket-disconnect with default escalation lands at lifeline', async () => {
    const result = await deliverReachable(
      'gsd-worktree-session',
      'socket-disconnect',
      'lost the connection to Claude Code; trying to recover.',
      rig.buildDeps({
        topicForSession: () => undefined,
        lifelineTopicId: () => 9001,
      }),
    );
    expect(result.reached).toBe('lifeline');
    expect(rig.sent[0].text).toContain('socket-disconnect/gsd-worktree-session');
  });

  it('T3 — active-silence delivery follows the same reachability path', async () => {
    const result = await deliverReachable(
      'quiet-session',
      'active-silence',
      'session went quiet mid-task; gentle nudge attempted.',
      rig.buildDeps({
        topicForSession: () => undefined,
        lifelineTopicId: () => 9001,
      }),
    );
    expect(result.reached).toBe('lifeline');
    expect(rig.sent[0].text).toContain('active-silence/quiet-session');
  });

  it('audit-only fallback writes to BOTH JSONL log AND dashboard alerts', async () => {
    const result = await deliverReachable(
      'orphan',
      'rate-limit',
      'whatever',
      rig.buildDeps({
        topicForSession: () => undefined,
        lifelineTopicId: () => undefined,   // No lifeline configured (early-boot case)
      }),
    );
    expect(result.reached).toBe('audit-only');

    // Audit JSONL has the entry.
    expect(fs.existsSync(rig.auditPath)).toBe(true);
    const jsonl = fs.readFileSync(rig.auditPath, 'utf-8').trim().split('\n');
    expect(jsonl).toHaveLength(1);
    const entry = JSON.parse(jsonl[0]);
    expect(entry.kind).toBe('recovery-unreachable');
    expect(entry.sentinel).toBe('rate-limit');
    expect(entry.sessionName).toBe('orphan');
    expect(entry.fallbackTried).toEqual(expect.arrayContaining(['topic', 'lifeline', 'audit']));

    // Dashboard alerts JSON file has the entry too.
    expect(fs.existsSync(rig.alertsPath)).toBe(true);
    const alerts = JSON.parse(fs.readFileSync(rig.alertsPath, 'utf-8'));
    expect(Array.isArray(alerts)).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('recovery-unreachable');
  });

  it('topic-bound session still routes to its bound topic (no regression)', async () => {
    const result = await deliverReachable(
      'topic-bound',
      'rate-limit',
      'continue',
      rig.buildDeps({
        topicForSession: () => 1234,
        lifelineTopicId: () => 9001,
      }),
    );
    expect(result.reached).toBe('topic');
    expect(result.topicId).toBe(1234);
    expect(rig.sent[0].topicId).toBe(1234);
    // Topic-bound messages are NOT lifeline-prefixed (they go to a topic the
    // user is already reading).
    expect(rig.sent[0].text).toBe('continue');
    expect(fs.existsSync(rig.auditPath)).toBe(false);
  });

  it('topic delivery failure falls through to lifeline (the resilience guarantee)', async () => {
    const result = await deliverReachable(
      'broken-topic',
      'rate-limit',
      'continue',
      rig.buildDeps({
        topicForSession: () => 1234,
        lifelineTopicId: () => 9001,
        sendToTopic: async (topicId, text) => {
          if (topicId === 1234) throw new Error('topic was deleted');
          rig.sent.push({ topicId, text });
        },
      }),
    );
    expect(result.reached).toBe('lifeline');
    expect(result.fallbackTried).toContain('topic-error:topic was deleted');
  });
});
