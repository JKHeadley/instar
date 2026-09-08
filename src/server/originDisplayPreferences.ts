import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Router, Request, Response } from 'express';
import type { RouteContext } from './routes.js';
import { topicDisplayRevision } from '../core/TopicProfileStore.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { resolveOriginDisplay } from '../messaging/telegram-origin/OriginPresentation.js';
import { validateProfileFields } from '../core/topicProfileValidation.js';

const revision = (value: string) => createHash('sha256').update(value).digest('hex');
/** The existing config-file authority, narrowed to cosmetic bits and operator proof.
 * Read raw on-disk config: resolved runtime credentials must never be serialized.
 */
export function mountOriginDisplayPreferences(router: Router, ctx: RouteContext): void {
  const gate = (req: Request, res: Response) => {
    if (ctx.verifyDashboardOperatorSession?.(req.get('X-Instar-Operator-Session'))) return true;
    res.status(403).json({ error: 'operator-audit-scope-required' }); return false;
  };
  const read = () => {
    const file = path.join(ctx.config.stateDir, 'config.json');
    const bytes = fs.readFileSync(file, 'utf8'), config = JSON.parse(bytes);
    const candidates = Array.isArray(config.messaging) ? config.messaging.filter((m: { type?: string; enabled?: boolean }) => m.type === 'telegram' && m.enabled === true) : [];
    if (candidates.length !== 1 || !candidates[0].config) throw new Error('telegram-display-config-unavailable');
    const telegram = candidates[0].config;
    return { file, bytes, config, telegram, defaults: resolveOriginDisplay(telegram.messageOrigin?.display), revision: revision(bytes) };
  };
  const topics = () => (ctx.telegram?.getAllTopicMappings() ?? []).slice(0, 1000).map(item => {
    const id = String(item.topicId), pin = ctx.topicProfile?.store.resolve(id)?.messageOriginDisplay ?? null;
    return { id, name: item.topicName && !/^topic-\d+$/.test(item.topicName) ? item.topicName : 'Unnamed conversation',
      display: pin, revision: topicDisplayRevision(pin), editable: !!ctx.topicProfile };
  });
  router.get('/telegram/origin-display', (req, res) => {
    if (!gate(req, res)) return;
    try { const current = read(); res.json({ defaults: current.defaults, revision: current.revision, topics: topics(), topicsMayBeIncomplete: (ctx.telegram?.getAllTopicMappings().length ?? 0) > 1000 }); }
    catch { res.status(503).json({ error: 'origin-display-settings-unavailable' }); }
  });
  router.post('/telegram/origin-display', async (req, res) => {
    if (!gate(req, res)) return;
    if (req.get('X-Instar-Request') !== '1') { res.status(403).json({ error: 'intent-header-required' }); return; }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['topicId', 'display', 'revision'].includes(k)) ||
      typeof body.revision !== 'string' || body.display === undefined || (body.topicId !== undefined && (typeof body.topicId !== 'string' || !/^[1-9][0-9]*$/.test(body.topicId)))) {
      res.status(400).json({ error: 'invalid-display-settings' }); return;
    }
    const validated = validateProfileFields({ messageOriginDisplay: body.display }, 'claude-code');
    if (!validated.ok || (!body.topicId && body.display === null)) { res.status(400).json({ error: 'invalid-display-settings' }); return; }
    try {
      if (body.topicId) {
        const topic = topics().find(item => item.id === body.topicId);
        if (!topic || !ctx.topicProfile) { res.status(404).json({ error: 'conversation-settings-unavailable' }); return; }
        if (topic.revision !== body.revision) { res.status(409).json({ error: 'settings-changed-refresh-required' }); return; }
        const result = await ctx.topicProfile.surface.applyWrite({ topicKey: body.topicId,
          patch: validated.patch, principal: { kind: 'token' }, origin: 'http', expectedDisplayRevision: body.revision });
        if (!result.ok) {
          const conflict = result.refusal?.reason === 'display-conflict';
          res.status(conflict ? 409 : 403).json({ error: conflict ? 'settings-changed-refresh-required' : 'conversation-display-write-refused' }); return;
        }
      } else {
        const current = read();
        if (current.revision !== body.revision) { res.status(409).json({ error: 'settings-changed-refresh-required' }); return; }
        const { version: _resolvedVersion, ...display } = resolveOriginDisplay({ ...current.defaults, ...validated.patch.messageOriginDisplay });
        current.telegram.messageOrigin = { ...current.telegram.messageOrigin, display };
        const temporary = `${current.file}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temporary, JSON.stringify(current.config, null, 2) + '\n', { mode: fs.statSync(current.file).mode & 0o777, flag: 'wx' });
          // No await separates read/check/replace: HTTP config writers share
          // this event loop. Also reject an external edit observed while staging.
          if (fs.readFileSync(current.file, 'utf8') !== current.bytes) { res.status(409).json({ error: 'settings-changed-refresh-required' }); return; }
          fs.renameSync(temporary, current.file);
        } finally {
          if (fs.existsSync(temporary)) SafeFsExecutor.safeUnlinkSync(temporary, { operation: 'origin-display-staging-cleanup' });
        }
        const runtimeTelegram = ctx.config.messaging?.find(m => m.type === 'telegram' && m.enabled === true)?.config as { messageOrigin?: Record<string, unknown> } | undefined;
        if (runtimeTelegram) runtimeTelegram.messageOrigin = { ...runtimeTelegram.messageOrigin, display };
      }
      res.json({ ok: true, message: 'Display saved. New messages use it after the configuration refresh (normally within a few seconds). Origin recording continues.' });
    } catch { res.status(503).json({ error: 'origin-display-save-unavailable' }); }
  });
}
