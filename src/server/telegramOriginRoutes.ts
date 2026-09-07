import type { Router, Request, Response } from 'express';
import type { TelegramOriginRuntime } from '../messaging/telegram-origin/TelegramOriginRuntime.js';
import { TelegramOriginHoldError } from '../messaging/telegram-origin/types.js';
import { renderOriginSetupGreeting } from '../messaging/telegram-origin/OriginSetupGreeting.js';
import { OriginSendPolicyRefusal } from '../messaging/telegram-origin/OriginSendPolicy.js';
import { originToolGuardDigest } from '../messaging/telegram-origin/OriginToolGuard.js';

export function sendOriginHoldResponse(res: Response, error: TelegramOriginHoldError): void {
  if (error instanceof OriginSendPolicyRefusal) {
    res.status(error.decision.status).json({ ...error.decision.body, operationId: error.operationId, retryable: false });
    return;
  }
  // A generic 5xx would ask existing callers to submit a new logical operation,
  // including after an uncertain external acceptance. Only the outbox may retry.
  res.status(409).json({ error: 'telegram-origin-held', reason: error.reason,
    outcome: error.outcome, operationId: error.operationId, retryable: false });
}
export function mountTelegramOriginRoutes(router: Router, deps: {
  runtime: () => TelegramOriginRuntime | null | undefined;
  verifyOperator: (proof: string | undefined) => boolean;
  setupGreeting?: () => { send: (text: string) => Promise<{ messageId: number }> } | null;
}): void {
  const operator = (req: Request, res: Response): boolean => {
    if (deps.verifyOperator(req.get('X-Instar-Operator-Session'))) return true;
    res.status(403).json({ error: 'operator-audit-scope-required' }); return false;
  };
  router.post('/telegram/origins/native-hook/challenge', (req, res) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) { res.sendStatus(403); return; }
    const runtime = deps.runtime();
    if (!runtime) { res.sendStatus(503); return; }
    const body = req.body ?? {}, token = req.get('X-Instar-Origin-Session') ?? '';
    if (Object.keys(body).some(key => !['nativeSessionId', 'guardDigest'].includes(key)) ||
      typeof body.nativeSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.nativeSessionId) ||
      body.guardDigest !== originToolGuardDigest()) { res.sendStatus(400); return; }
    const verified = runtime.sessions.verify(token);
    if (!verified.ok || !['claude-code', 'codex-cli'].includes(verified.binding.harnessId)) { res.sendStatus(403); return; }
    const observed = runtime.observer.get(verified.binding.sessionId);
    if (!observed || observed.nativeSessionId !== body.nativeSessionId || observed.sessionIncarnation !== verified.binding.sessionIncarnation) {
      res.status(409).json({ error: 'native-session-binding-unavailable' }); return;
    }
    const proof = runtime.observer.getNativeHookProof(verified.binding.sessionId);
    if (proof && runtime.sessions.verifyNativeHookProof(verified.binding.sessionId, proof, body.guardDigest)) {
      // Avoid injecting the same internal marker into every tool turn. A stale
      // observer, replaced incarnation, expired challenge or changed digest
      // requests a fresh native observation again.
      res.sendStatus(204); return;
    }
    const challenge = runtime.sessions.challengeNativeHook(token, body.nativeSessionId, body.guardDigest);
    if (!challenge) { res.sendStatus(403); return; }
    res.json(challenge);
  });
  router.post('/telegram/setup/greeting', async (req, res) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) { res.sendStatus(403); return; }
    const runtime = deps.runtime(), sender = deps.setupGreeting?.();
    if (!runtime || !sender) { res.status(503).json({ error: 'setup-origin-not-ready' }); return; }
    let text: string;
    try { text = renderOriginSetupGreeting(req.body); }
    catch { res.status(400).json({ error: 'invalid-setup-greeting' }); return; }
    try {
      runtime.service.registerAutomationProducer('setup-wizard');
      const receipt = await runtime.service.runAsAutomation('setup-wizard', () => sender.send(text));
      res.json(receipt);
    } catch (error) {
      if (error instanceof TelegramOriginHoldError) sendOriginHoldResponse(res, error);
      else res.status(409).json({ error: 'setup-greeting-held', retryable: false });
    }
  });
  router.post('/telegram/browser/:profileId/send', async (req, res) => {
    const runtime = deps.runtime(), browser = runtime?.browsers.get(req.params.profileId);
    if (!runtime || !browser) { res.status(503).json({ error: 'telegram-browser-not-enrolled' }); return; }
    const body = req.body ?? {}, destination = body.destination;
    if (Object.keys(body).some(key => !['text', 'destination', 'messageId', 'metadata'].includes(key)) ||
      (body.metadata !== undefined && (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata) ||
        Object.keys(body.metadata).some(key => !['toneAdvisoryAck', 'toneAdvisoryAckReason', 'toneAdvisoryDecisionRef', 'toneAdvisoryComplied'].includes(key)))) ||
      typeof body.text !== 'string' || Buffer.byteLength(body.text) > 256 * 1024 || !destination ||
      !['user', 'chat', 'channel'].includes(destination.kind) || typeof destination.id !== 'string' || !/^[1-9][0-9]*$/.test(destination.id) ||
      Object.keys(destination).some(key => !['kind', 'id', 'topicId'].includes(key)) ||
      (destination.topicId !== undefined && (!Number.isSafeInteger(destination.topicId) || destination.topicId <= 0)) ||
      (body.messageId !== undefined && (!Number.isSafeInteger(body.messageId) || body.messageId <= 0))) {
      res.status(400).json({ error: 'invalid-typed-browser-request' }); return;
    }
    try {
      const result = await runtime.service.runWithSessionToken(req.get('X-Instar-Origin-Session') ?? '', () =>
        runtime.service.runWithSendPolicyInput(body.text, body.metadata, async () => {
        const peer = await browser.resolvePeer(destination);
        return browser.executor.send({ text: body.text, destination, peer,
          ...(body.messageId === undefined ? {} : { messageId: body.messageId }) });
      }));
      res.json(result);
    } catch (error) {
      if (error instanceof TelegramOriginHoldError) sendOriginHoldResponse(res, error);
      else res.status(409).json({ error: 'telegram-browser-held', reason: 'browser-preparation-or-recording-unavailable', retryable: false });
    }
  });
  router.get('/telegram/browser/:profileId/snapshot', async (req, res) => {
    const runtime = deps.runtime(), browser = runtime?.browsers.get(req.params.profileId);
    if (!runtime || !browser) { res.status(503).json({ error: 'telegram-browser-not-enrolled' }); return; }
    try {
      const result = await runtime.service.runWithSessionToken(req.get('X-Instar-Origin-Session') ?? '', () => browser.executor.broker.readSnapshot());
      res.json(result);
    } catch { res.status(409).json({ error: 'telegram-browser-snapshot-unavailable' }); }
  });
  router.get('/telegram/origins/status', async (req, res) => {
    if (!operator(req, res)) return;
    const runtime = deps.runtime();
    if (!runtime) { res.status(503).json({ error: 'origin-runtime-unavailable' }); return; }
    if (req.query.scope === 'pool') {
      try {
        if (!runtime.poolAudit) throw new Error('origin-pool-unavailable');
        res.json({ metrics: await runtime.poolAudit.metricsForOperator() });
      } catch { res.status(503).json({ error: 'origin-pool-metrics-unavailable', coverage: 'unknown' }); }
      return;
    }
    if (req.query.scope !== undefined && req.query.scope !== 'local') { res.status(400).json({ error: 'invalid-origin-scope' }); return; }
    try { res.json(await runtime.status()); }
    catch { res.status(503).json({ error: 'origin-status-unavailable', coverage: 'unknown' }); }
  });
  router.post('/telegram/origins/diagnose', async (req, res) => {
    // Lifeline handoff, still under the server's ordinary agent authentication.
    // No origin contents or existence result are disclosed through this port.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) { res.sendStatus(403); return; }
    const { originId, reason } = req.body ?? {};
    if (typeof originId !== 'string' || !/^[a-f0-9-]{36}$/.test(originId) ||
      !['transport-acceptance-unknown', 'response-without-correlated-receipt'].includes(reason)) { res.sendStatus(400); return; }
    const runtime = deps.runtime();
    if (!runtime) { res.sendStatus(503); return; }
    try {
      if (await runtime.store.getOrigin(originId)) runtime.service.requestDiagnosis(originId, reason);
      res.status(202).json({ accepted: true });
    } catch { res.sendStatus(503); }
  });
  router.get('/telegram/origins', async (req, res) => {
    if (!operator(req, res)) return;
    const runtime = deps.runtime();
    if (!runtime) { res.status(503).json({ error: 'origin-runtime-unavailable' }); return; }
    // Pool federation requires its own authorized snapshot; never label a local
    // page as the whole pool or silently ignore an unsupported scope.
    if (req.query.scope !== undefined && req.query.scope !== 'local' && (req.query.scope !== 'pool' || !runtime.poolAudit)) {
      res.status(503).json({ error: 'origin-pool-snapshot-unavailable', coverage: 'incomplete' }); return;
    }
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) { res.status(400).json({ error: 'invalid-limit' }); return; }
    if (req.query.cursor !== undefined && typeof req.query.cursor !== 'string') { res.status(400).json({ error: 'invalid-cursor' }); return; }
    const query: import('../messaging/telegram-origin/StoreTypes.js').OriginListQuery = { limit, cursor: req.query.cursor as string | undefined };
    for (const key of ['machineId', 'originId', 'transport', 'accountId', 'chatId', 'topicId', 'messageId'] as const) {
      const value = req.query[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !value || value.length > 256) { res.status(400).json({ error: `invalid-${key}` }); return; }
      query[key] = value;
    }
    try {
      const page = req.query.scope === 'pool' ? await runtime.poolAudit!.listForOperator(query) : await runtime.store.listOrigins(query);
      res.json({ ...page, records: page.records.map(row => runtime.auditVerification(row)) });
    }
    catch { res.status(503).json({ error: 'origin-audit-unavailable', coverage: 'unknown' }); }
  });
  router.get('/telegram/origins/:originId', async (req, res) => {
    if (!operator(req, res)) return;
    const runtime = deps.runtime();
    if (!runtime) { res.status(503).json({ error: 'origin-runtime-unavailable' }); return; }
    try {
      if (req.query.scope === 'pool') {
        if (!runtime.poolAudit) { res.status(503).json({ error: 'origin-pool-snapshot-unavailable', coverage: 'incomplete' }); return; }
        const page = await runtime.poolAudit.listForOperator({ originId: req.params.originId, limit: 1 });
        const record = page.records[0] ? runtime.auditVerification(page.records[0]) : null;
        res.status(record ? 200 : page.coverage === 'complete' ? 404 : 503).json({ record, coverage: page.coverage,
          unavailableShards: page.unavailableShards, conflictingOrigins: page.conflictingOrigins, snapshotAt: page.snapshotAt });
        return;
      }
      if (req.query.scope !== undefined && req.query.scope !== 'local') { res.status(400).json({ error: 'invalid-audit-scope' }); return; }
      const record = await runtime.store.getOrigin(req.params.originId);
      if (!record) { res.status(404).json({ error: 'origin-not-found' }); return; }
      res.json(runtime.auditVerification(record));
    } catch { res.status(503).json({ error: 'origin-audit-unavailable', coverage: 'unknown' }); }
  });
  router.use('/telegram/reply/:topicId', async (req, res, next) => {
    const runtime = deps.runtime();
    if (!runtime || req.method !== 'POST') { next(); return; }
    try {
      const automationToken = req.get('X-Instar-Origin-Automation');
      if (automationToken) {
        if (req.get('X-Instar-Origin-Session')) throw new TelegramOriginHoldError('conflicting-origin-credentials');
        runtime.service.runWithAutomationReply(automationToken, Number(req.params.topicId), req.body, next);
        return;
      }
      await runtime.service.runWithSessionToken(req.get('X-Instar-Origin-Session') ?? '', async () => {
        if (typeof req.body?.text === 'string') runtime.service.runWithSendPolicyInput(req.body.text, req.body.metadata, next);
        else next();
      });
    } catch (error) {
      if (error instanceof TelegramOriginHoldError) sendOriginHoldResponse(res, error);
      else res.status(409).json({ error: 'telegram-origin-held', reason: 'origin-session-unavailable', retryable: false });
    }
  });
}
