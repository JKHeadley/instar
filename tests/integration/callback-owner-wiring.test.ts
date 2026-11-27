/** ACT-115 wiring: the real route setup gives the real adapter its approver, from the real operator store. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { TopicOperatorStore } from '../../src/users/TopicOperatorStore.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

const OPERATOR = 777001;

describe('owner check wiring', () => {
  let tmpDir: string;
  let stateDir: string;
  let adapter: TelegramAdapter;
  let store: TopicOperatorStore;
  const answers: string[] = [];
  const tap = (from: number) => adapter.handleForwardedCallback({
    id: 'cbq', from: { id: from }, data: 'pg:anything', message: { message_id: 1, chat: { id: from } },
  } as never);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-wiring-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    ProcessIntegrity.reset();
    ProcessIntegrity.initialize('1.3.500', null);
    answers.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: { body: string }) => {
      if (String(url).endsWith('answerCallbackQuery')) answers.push(String(JSON.parse(opts.body).text));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) } as unknown as Response;
    }));
    adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100999' }, stateDir);
    store = new TopicOperatorStore(path.join(stateDir, 'state'));
    bootRoutes();
  });

  const bootRoutes = () => {
    createRoutes({
      config: { projectName: 'test', projectDir: tmpDir, stateDir, port: 0, authToken: 'token', sessions: {}, scheduler: {} },
      sessionManager: { listRunningSessions: () => [] },
      state: { getJobState: () => null, getSession: () => null, queryEvents: () => [] },
      scheduler: null, telegram: adapter, topicOperatorStore: store,
      relationships: null, feedback: null, dispatches: null, updateChecker: null, autoUpdater: null,
      autoDispatcher: null, quotaTracker: null, publisher: null, viewer: null, tunnel: null,
      evolution: null, watchdog: null, triageNurse: null, topicMemory: null, discoveryEvaluator: null,
      startTime: new Date(),
    } as never);
  };

  afterEach(async () => {
    await adapter.stop();
    vi.unstubAllGlobals();
    ProcessIntegrity.reset();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/callback-owner-wiring.test.ts' });
  });

  it('refuses a tap before any operator is verified', async () => {
    await tap(OPERATOR);
    expect(answers.at(-1)).toContain("I can't confirm who my owner is");
  });

  it('accepts the one verified operator and refuses anyone else', async () => {
    store.setAuthenticatedOperator(3, { platform: 'telegram', uid: String(OPERATOR), displayName: 'Op' }, { kind: 'authenticated-inbound', ingress: 'telegram-polling', authorization: 'telegram-is-authorized-sender', senderUid: String(OPERATOR), messageId: 'tg-bta' });
    await tap(555);
    expect(answers.at(-1)).toBe('Only the session owner can respond to prompts');
    await tap(OPERATOR);
    expect(answers.at(-1)).not.toBe('Only the session owner can respond to prompts');
    expect(answers.at(-1)).not.toContain("I can't confirm who my owner is");
  });

  it('reports at startup when several verified people leave no single owner', () => {
    const evidence = (uid: string) => ({ kind: 'authenticated-inbound', ingress: 'telegram-polling', authorization: 'telegram-is-authorized-sender', senderUid: uid, messageId: `tg-${uid}` });
    store.setAuthenticatedOperator(3, { platform: 'telegram', uid: '111', displayName: 'A' }, evidence('111') as never);
    store.setAuthenticatedOperator(4, { platform: 'telegram', uid: '222', displayName: 'B' }, evidence('222') as never);
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report');
    bootRoutes();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ feature: 'TelegramAdapter.callbackApprover' }));
    report.mockRestore();
  });

  it('reports when the one verified person has no current binding', () => {
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report');
    vi.spyOn(store, 'everVerifiedOperatorUids').mockReturnValue(['111']);
    bootRoutes();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ feature: 'TelegramAdapter.callbackApprover' }));
    report.mockRestore();
  });

  it('reports when the verified history is unreadable', () => {
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report');
    vi.spyOn(store, 'everVerifiedOperatorUids').mockReturnValue(null);
    bootRoutes();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ feature: 'TelegramAdapter.callbackApprover' }));
    report.mockRestore();
  });

  it('reports when the configured owner is invalid', async () => {
    await adapter.stop();
    adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100999', ownerUserId: 'not-a-number' as never }, stateDir);
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report');
    bootRoutes();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ feature: 'TelegramAdapter.callbackApprover' }));
    report.mockRestore();
  });

  it('stays quiet on a new agent nobody has messaged yet', () => {
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report');
    bootRoutes();
    expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ feature: 'TelegramAdapter.callbackApprover' }));
    report.mockRestore();
  });
});
