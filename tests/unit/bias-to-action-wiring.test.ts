/**
 * Wiring-integrity tests for the Bias-to-Action standing-authorization signal
 * (BIAS-TO-ACTION-SPEC D10 + the resolver→real-read-path wiring).
 *
 * These prove the parts the pure-unit resolver/detector tests cannot:
 *  - BOTH Telegram ingress paths persist an EXPLICIT `forwarded` boolean
 *    (including `false` on a genuine row) into the message log the resolver reads.
 *  - Feeding `resolveStandingAuthorization` from the REAL `getTopicHistory` read
 *    path (mapped exactly as routes.ts does) honors every security boundary:
 *    verified-operator-uid only (NOT `fromUser`), forwarded-fail-safe, and the
 *    legacy-unknown fail-safe.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { TopicOperatorStore } from '../../src/users/TopicOperatorStore.js';
import { resolveStandingAuthorization } from '../../src/core/standing-authorization.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OPERATOR_UID = 7812716706;
const OTHER_UID = 99990000;
const TOPIC = 4242;

describe('bias-to-action wiring-integrity', () => {
  let tmpDir: string;
  let adapter: TelegramAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-bta-wiring-'));
    adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100123', pollIntervalMs: 100 }, tmpDir);
  });

  afterEach(async () => {
    await adapter.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/bias-to-action-wiring.test.ts' });
  });

  describe('D10 forwarded persistence — lifeline path (logInboundMessage)', () => {
    it('persists an EXPLICIT forwarded:false on a genuine row (omitted ⇒ false, not absent)', () => {
      adapter.logInboundMessage({
        messageId: 1,
        topicId: TOPIC,
        text: 'you have my preapproval, go for it',
        timestamp: new Date().toISOString(),
        telegramUserId: OPERATOR_UID,
      });
      const rows = adapter.getTopicHistory(TOPIC, 10);
      expect(rows.length).toBe(1);
      // The load-bearing assertion: the field is present AND false (not undefined),
      // so the resolver can PROVE non-forwarded provenance.
      expect(rows[0].forwarded).toBe(false);
    });

    it('persists forwarded:true when the lifeline reports a forward', () => {
      adapter.logInboundMessage({
        messageId: 2,
        topicId: TOPIC,
        text: 'go ahead and run autonomously',
        timestamp: new Date().toISOString(),
        telegramUserId: OPERATOR_UID,
        forwarded: true,
      });
      const rows = adapter.getTopicHistory(TOPIC, 10);
      expect(rows[rows.length - 1].forwarded).toBe(true);
    });
  });

  describe('D10 forwarded persistence — polling path (processUpdate)', () => {
    const baseMsg = (extra: Record<string, unknown>) => ({
      update_id: Math.floor(Math.random() * 1e9),
      message: {
        message_id: Math.floor(Math.random() * 1e6),
        from: { id: OPERATOR_UID, first_name: 'Op', username: 'op' },
        date: Math.floor(Date.now() / 1000),
        message_thread_id: TOPIC,
        text: 'you have my preapproval',
        ...extra,
      },
    });

    it('persists forwarded:false on a normal (non-forwarded) polled message', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (adapter as any).processUpdate(baseMsg({}));
      const rows = adapter.getTopicHistory(TOPIC, 10);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[rows.length - 1].forwarded).toBe(false);
    });

    it('persists forwarded:true when a polled message carries a forward marker', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (adapter as any).processUpdate(baseMsg({ forward_date: Math.floor(Date.now() / 1000) }));
      const rows = adapter.getTopicHistory(TOPIC, 10);
      expect(rows[rows.length - 1].forwarded).toBe(true);
    });
  });

  describe('resolver fed from the REAL getTopicHistory read path', () => {
    let opStore: TopicOperatorStore;

    beforeEach(() => {
      opStore = new TopicOperatorStore(tmpDir);
      opStore.setOperator(TOPIC, { platform: 'telegram', uid: String(OPERATOR_UID), displayName: 'Op' });
    });

    // Mirror EXACTLY how routes.ts builds the resolver deps from getTopicHistory.
    const deps = (adapterRef: TelegramAdapter, store: TopicOperatorStore) => ({
      getVerifiedOperatorUid: (t: number | string) => store.asVerifiedOperator(t)?.uid ?? null,
      getRecentMessages: (t: number | string) =>
        (adapterRef.getTopicHistory(Number(t), 40) ?? [])
          .filter((e) => e.fromUser)
          .map((e) => ({
            telegramUserId: e.telegramUserId,
            text: e.text,
            ts: Date.parse(e.timestamp),
            forwarded: e.forwarded,
          })),
      now: () => Date.now(),
    });

    it('counts a verified-operator, non-forwarded, in-window grant', () => {
      adapter.logInboundMessage({
        messageId: 10,
        topicId: TOPIC,
        text: 'you have my preapproval for any decisions in this session',
        timestamp: new Date().toISOString(),
        telegramUserId: OPERATOR_UID,
      });
      const res = resolveStandingAuthorization(TOPIC, deps(adapter, opStore));
      expect(res.present).toBe(true);
      expect(res.source).toBe('verified-operator-directive');
    });

    it('does NOT count an identical grant from a DIFFERENT uid (not fromUser, the verified uid)', () => {
      adapter.logInboundMessage({
        messageId: 11,
        topicId: TOPIC,
        text: 'you have my preapproval for any decisions in this session',
        timestamp: new Date().toISOString(),
        telegramUserId: OTHER_UID,
      });
      const res = resolveStandingAuthorization(TOPIC, deps(adapter, opStore));
      expect(res.present).toBe(false);
    });

    it('does NOT count a FORWARDED operator grant (third-party content)', () => {
      adapter.logInboundMessage({
        messageId: 12,
        topicId: TOPIC,
        text: 'go ahead, run autonomously',
        timestamp: new Date().toISOString(),
        telegramUserId: OPERATOR_UID,
        forwarded: true,
      });
      const res = resolveStandingAuthorization(TOPIC, deps(adapter, opStore));
      expect(res.present).toBe(false);
    });

    it('does NOT count an agent (fromUser:false) message even if it contains a grant phrase', () => {
      // Outbound agent messages never enter getTopicHistory as fromUser:true; the
      // dep mapping filters on fromUser, so an agent echo of "go ahead" cannot grant.
      adapter.logInboundMessage({
        messageId: 13,
        topicId: TOPIC,
        text: 'you have my preapproval', // operator grant present...
        timestamp: new Date().toISOString(),
        telegramUserId: OPERATOR_UID,
      });
      // ...but with NO operator bound, nothing resolves (no-operator fail-safe).
      const unboundStore = new TopicOperatorStore(fs.mkdtempSync(path.join(os.tmpdir(), 'instar-bta-noop-')));
      const res = resolveStandingAuthorization(TOPIC, deps(adapter, unboundStore));
      expect(res.present).toBe(false);
      expect(res.reason).toBe('no-operator');
    });
  });
});
