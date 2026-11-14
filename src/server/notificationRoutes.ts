import { storageErrorResponse } from '../core/storageMachineName.js';
import { readPeerJobs, readPeerNotifications } from './notificationPoolRead.js';
import { poolPeerFetch } from './poolPeerFetch.js';
import { isPeerUrlAllowedForCredentials } from './peerUrlGuard.js';
import type { Router } from 'express';
import type { RouteContext } from './routes.js';
import { CONVERSATION_CATEGORIES, isNotificationCategory, isNotificationJobSlug } from '../messaging/notificationCategories.js';
import { verifiedReplyEnvelope } from '../messaging/NotificationSelectivityGate.js';

/** Uses the existing authenticated router; preference writes additionally require operator proof. */
export function mountNotificationRoutes(router: Router, ctx: RouteContext, verifyLifeline: (headers: Record<string, unknown>) => boolean): void {
  router.post('/notifications/internal/classify', async (req, res) => {
    if (!verifyLifeline(req.headers)) { res.status(403).json({ error: 'Lifeline proof required' }); return; }
    const gate = ctx.telegram?.selectivity, runtime = ctx.telegramOrigin;
    if (!gate || !runtime || typeof req.body?.operationId !== 'string') { res.status(503).json({ error: 'Notification authority unavailable' }); return; }
    try {
      const audit = await runtime.store.getOperation(req.body.operationId);
      if (!audit?.children.length) { res.status(404).json({ error: 'Origin operation not found' }); return; }
      const record = JSON.parse(audit.record.envelopeJson) as import('../messaging/telegram-origin/types.js').TelegramOriginRecord;
      const child = await runtime.store.getChild(audit.children[0].childId);
      const request = JSON.parse(child!.materializations[0].requestJson);
      const body = JSON.parse(request.body);
      const topicId = ctx.telegram!.notificationTopicId(record.destination.chatId, record.destination.topicId);
      const envelope = record.notification?.origin === 'verified-reply' && record.producerKind === 'session' && !ctx.state.getSession(record.sessionId ?? '')?.jobSlug
        ? verifiedReplyEnvelope('lifeline-origin-session') : record.notification?.origin === 'verified-reply' ? undefined : record.notification;
      res.json(await gate.route(topicId, request.policy?.text ?? body.text ?? body.caption ?? '', runtime.service.restoreJobEnvelope(record, envelope), record.operationId));
    } catch { res.status(503).json(storageErrorResponse({ error: 'Notification classification could not be saved' }, ctx.config.stateDir)); }
  });
  router.get('/notifications/selectivity', async (req, res) => {
    const gate = ctx.telegram?.selectivity;
    if (!gate) { res.status(503).json({ error: 'Notification feed is not available on this machine' }); return; }
    try {
      const choices = gate.jobPush();
      const pool = req.query.scope === 'pool' ? await readPeerJobs(ctx) : { jobs: [], unavailable: [] };
      const known = new Map([...pool.jobs, ...(ctx.scheduler?.getJobs() ?? [])].map(job => [job.slug, job]));
      res.json({ ...gate.status(), jobsScope: req.query.scope === 'pool' ? 'pool' : 'this-machine', jobsUnavailable: pool.unavailable,
        jobs: [...known.values()].map(job => ({ slug: job.slug, name: job.name, enabled: job.enabled !== false, push: choices[job.slug] === true, decided: typeof choices[job.slug] === 'boolean' })) });
    } catch { res.status(503).json({ error: 'Notification status is not available right now' }); }
  });
  router.get('/notifications/quiet', async (req, res) => {
    const gate = ctx.telegram?.selectivity;
    if (!gate) { res.status(503).json({ error: 'Notification feed is not available on this machine' }); return; }
    await gate.store.ready;
    const topicId = req.query.topicId === undefined ? undefined : Number(req.query.topicId);
    if (topicId !== undefined && !Number.isSafeInteger(topicId)) { res.status(400).json({ error: 'Invalid conversation' }); return; }
    let cursors: Record<string, string> = {};
    if (typeof req.query.cursors === 'string') {
      try { const parsed = JSON.parse(req.query.cursors); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.entries(parsed).length > 17 || Object.values(parsed).some(value => typeof value !== 'string' || value.length > 200)) throw new Error(); cursors = parsed; }
      catch { res.status(400).json({ error: 'Invalid notification page' }); return; }
    }
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    let items = gate.store.list({ category: typeof req.query.category === 'string' ? req.query.category : undefined,
      unread: req.query.unread === 'true', topicId, limit: Number(req.query.limit) || 50,
      before: cursors[gate.machineId] ?? (typeof req.query.before === 'string' ? req.query.before : undefined) });
    let unavailable: string[] = []; let unread = gate.store.counters().unread;
    if (req.query.scope === 'pool') {
      const query = new URLSearchParams({ limit: String(Math.min(200, Number(req.query.limit) || 50)) });
      for (const key of ['category', 'unread', 'topicId', 'before']) if (typeof req.query[key] === 'string') query.set(key, req.query[key] as string);
      const pool = await readPeerNotifications(ctx, query, cursors); unavailable = pool.unavailable; unread += pool.unread;
      items = [...items, ...pool.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    }
    const hasMore = items.length >= limit; items = items.slice(0, limit);
    const nextCursors = { ...cursors }; for (const row of items) nextCursors[row.machineId] = `${row.createdAt}|${row.id}`;
    res.json({ items, unavailable, nextCursors, hasMore, nextCursor: items.length ? `${items.at(-1)!.createdAt}|${items.at(-1)!.id}` : null, ...gate.store.counters(), unread, scope: req.query.scope === 'pool' ? 'pool' : 'this-machine', machineId: gate.machineId });
  });
  router.patch('/notifications/quiet/:id', async (req, res) => {
    const gate = ctx.telegram?.selectivity;
    if (!gate) { res.status(503).json({ error: 'Notification feed is not available on this machine' }); return; }
    const machine = req.query.machineId;
    if (typeof machine === 'string' && machine !== gate.machineId) {
      const peer = ctx.resolvePeerUrls?.().find(value => value.machineId === machine);
      const allow = (ctx.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)?.peerUrlAllowlist;
      if (!peer || !isPeerUrlAllowedForCredentials({ url: peer.url, kind: peer.kind }, allow).ok) { res.status(503).json({ error: 'The notice owner is unavailable; its acknowledgement is still pending' }); return; }
      try { const response = await poolPeerFetch(ctx.recordRopeResult ?? undefined, peer, '/notifications/quiet/' + encodeURIComponent(String(req.params.id)), { method: 'PATCH', headers: { Authorization: `Bearer ${ctx.config.authToken}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1800) }); res.status(response.status).json(await response.json()); }
      catch { res.status(503).json({ error: `${ctx.machinePoolRegistry?.getCapacity(machine)?.nickname ?? ctx.listPoolMachines?.().find(row => row.machineId === machine)?.nickname ?? 'The notice owner (name unavailable)'} could not save this acknowledgement. Please retry.` }); }
      return;
    }
    try { const found = await gate.store.ack(String(req.params.id)); res.status(found ? 200 : 404).json({ ok: found }); }
    catch { res.status(503).json(storageErrorResponse({ error: 'Could not save the acknowledgement. Please retry.' }, ctx.config.stateDir)); }
  });
  router.post('/notifications/categories/:id/push', async (req, res) => {
    const gate = ctx.telegram?.selectivity;
    const category = req.params.id;
    if (!gate || !gate.preferences) { res.status(503).json({ error: 'Notification preferences are unavailable' }); return; }
    if (!isNotificationCategory(category) || typeof req.body?.enabled !== 'boolean') { res.status(400).json({ error: 'Choose a registered category and whether it should push' }); return; }
    if (CONVERSATION_CATEGORIES.has(category)) { res.status(400).json({ error: 'Conversation replies and delivery notices are protected automatically; choose an automated report category' }); return; }
    const surface = req.body.confirmedBy;
    const topicId = Number(req.body.topicId), messageId = String(req.body.confirmingMessageId ?? '');
    const pin = surface === 'dashboard-pin' && ctx.verifyDashboardOperatorSession?.(req.headers['x-instar-operator-session'] as string | undefined) === true;
    const conversational = surface === 'operator-conversational-confirm' && Number.isSafeInteger(topicId) && gate.confirmsOperator(topicId, messageId);
    if (!pin && !conversational) { res.status(400).json({ error: 'Confirm this change with your dashboard PIN or a recent operator message' }); return; }
    try {
      if (!gate.preferences) throw new Error('Preference writer unavailable');
      await gate.preferences.set(category, req.body.enabled, surface);
      void gate.preferences.drain();
      if (ctx.liveConfig && ctx.liveConfig.get(`notifications.selectivity.push.categories.${category}`, !req.body.enabled) !== req.body.enabled) throw new Error('Preference write did not persist');
      if (conversational) await ctx.telegram!.sendToTopic(topicId, `Done — routine ${category.replaceAll('-', ' ')} ${req.body.enabled ? 'will now be pushed' : 'will stay in the notification feed'}.`, { envelope: verifiedReplyEnvelope('notification-preference-confirm') });
      res.json({ ok: true, category, enabled: req.body.enabled });
    } catch { res.status(503).json(storageErrorResponse({ error: 'Could not save the preference. Please retry.' }, ctx.config.stateDir)); }
  });
  router.post('/notifications/jobs/:slug/push', async (req, res) => {
    const gate = ctx.telegram?.selectivity;
    const slug = req.params.slug;
    if (!gate || !gate.preferences) { res.status(503).json({ error: 'Notification preferences are unavailable' }); return; }
    if (!isNotificationJobSlug(slug) || typeof req.body?.enabled !== 'boolean') { res.status(400).json({ error: 'Choose a job and whether its reports should push' }); return; }
    const surface = req.body.confirmedBy;
    const topicId = Number(req.body.topicId), messageId = String(req.body.confirmingMessageId ?? '');
    const pin = surface === 'dashboard-pin' && ctx.verifyDashboardOperatorSession?.(req.headers['x-instar-operator-session'] as string | undefined) === true;
    const conversational = surface === 'operator-conversational-confirm' && Number.isSafeInteger(topicId) && gate.confirmsOperator(topicId, messageId);
    // Proof comes before the job lookup, so an unconfirmed caller cannot list job names.
    if (!pin && !conversational) { res.status(400).json({ error: 'Confirm this change with your dashboard PIN or a recent operator message' }); return; }
    // A job written seconds ago is not in memory until the next refresh. Turning a job off
    // never needs it to exist: a deleted job's choice must stay removable.
    let name: string | undefined;
    try {
      // An async route has no framework catch: a job file with a typo must answer, not take the server down.
      try { ctx.scheduler?.refreshJobs(); }
      catch (error) { if (req.body.enabled) throw error; /* @silent-fallback-ok: turning a job off needs no job list */ }
      name = ctx.scheduler?.getJobs().find(row => row.slug === slug)?.name;
      if (!name && req.body.enabled) {
        const pool = await readPeerJobs(ctx);
        name = pool.jobs.find(row => row.slug === slug)?.name;
        if (!name && pool.unavailable.length) { res.status(503).json({ error: 'A machine that may run this job cannot be reached right now. Please retry.' }); return; }
        if (!name) { res.status(404).json({ error: 'No job with that name' }); return; }
      }
    } catch { res.status(503).json({ error: 'The job list could not be read. Please check it and retry.' }); return; }
    try {
      await gate.preferences.setJob(slug, req.body.enabled, surface, conversational ? topicId : undefined);
      void gate.preferences.drain();
      if (ctx.liveConfig && ctx.liveConfig.get(`notifications.selectivity.push.jobs.${slug}`, !req.body.enabled) !== req.body.enabled) throw new Error('Preference write did not persist');
      const categoryPush = gate.categoryPushEnabled('job-status'), enforcing = gate.isEnforcing();
      const outcome = req.body.enabled && !enforcing ? 'already reach you, because Quiet by Default is still only observing; this choice takes effect when it starts enforcing' : req.body.enabled ? (conversational ? 'will now reach you here when the job sends them to this conversation, and in the Attention topic otherwise' : 'will now reach you in the Attention topic') : !enforcing ? 'will reach you for now, because Quiet by Default is still only observing' : categoryPush ? 'will still reach you, because all scheduled job reports are turned on' : 'will stay in the notification feed';
      const message = `Reports from ${name ?? slug} ${outcome}.`;
      if (conversational) await ctx.telegram!.sendToTopic(topicId, `Done — ${message}`, { envelope: verifiedReplyEnvelope('notification-preference-confirm') });
      res.json({ ok: true, slug, enabled: req.body.enabled, categoryPush, enforcing, topicId: conversational && req.body.enabled ? topicId : null, message });
    } catch { res.status(503).json(storageErrorResponse({ error: 'Could not save the preference. Please retry.' }, ctx.config.stateDir)); }
  });
}
