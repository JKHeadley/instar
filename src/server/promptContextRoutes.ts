/**
 * The per-prompt hook's single request and its shadow summary
 * (context-budget-layered-summaries §7.7, §9.5; Phase 1 S15).
 *
 *   GET /topic/:id/prompt-context?session=<claudeSessionId>&instarSession=<id>&framework=<f>
 *     One request in place of the hook's two (`/topic-intent/:id/briefing` and
 *     `/telegram/topics/:id/messages?limit=15`). Computes the FULL output and the
 *     DELTA against the context epoch, logs both sizes to the local shadow log
 *     (when `contextBudget.enabled`), and returns the FULL output unless
 *     `contextBudget.deltaHook.enabled` is on here AND the compaction canary reads
 *     `healthy` (a refusal is recorded with its reason). While a fold is open for
 *     the topic, or this session's fold marker exists, it returns `suppressed`.
 *
 *   GET /context-budget/delta-shadow
 *     The shadow comparison's aggregates: prompts, median/p95 of full vs delta
 *     characters, omitted items, and the candidate re-fetches (reported `unknown`
 *     with its reason, never as zero, whenever anything was omitted).
 *
 * Bearer only: a device principal (a phone) is refused. Read-only toward every
 * store but the cursor and the shadow log, both local-only under the layer root.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  SeedFetchLog, DeltaShadowLog, PromptCursorStore, PROMPT_HISTORY_LIMIT, REFETCH_WINDOW_MS, DELTA_HOOK_FEATURE_ID,
  boundBriefing, computePromptDelta, fitDeltaForDelivery, foldSuppression, reductionVerdict, renderPromptContextText, resolveContextEpoch,
  slimMessage, summarizeShadow, unansweredOf, type PromptMessage,
} from '../monitoring/contextLayers/promptContext.js';
import type { CanaryReport } from '../monitoring/compactionCanary.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface PromptContextDeps {
  stateDir: string;
  /** `contextBudget.enabled` resolved at boot (the layer store exists): the shadow comparison runs. */
  shadowOn: () => boolean;
  /** `contextBudget.deltaHook.enabled`, live-read, per machine (default off). */
  deltaSwitchOn: () => boolean;
  /** The sentinel's canary report; `undefined` when the sentinel is off on this machine. */
  canary: () => { report: CanaryReport | null } | undefined;
  /** Today's briefing route, metered the same way (empty string when topic-intent is off). */
  briefing: (topicId: number) => string;
  /** Today's message read: the topic's most recent messages (null when Telegram is not configured). */
  messages: (topicId: number, limit: number) => Array<Record<string, unknown>> | null;
  /** Seed-shaped fetches (the briefing route and the history routes); the prompt route never records here. */
  seedFetches: SeedFetchLog;
  now?: () => number;
}

function isDevice(req: Request): boolean {
  return (req as unknown as { instarPrincipal?: { kind?: string } }).instarPrincipal?.kind === 'device';
}

function param(v: unknown): string | null {
  return typeof v === 'string' && SAFE_ID.test(v) ? v : null;
}

/** Topic → the newest prompt time that omitted something, for the candidate re-fetch rows. */
type OmissionIndex = Map<number, { at: number; count: number }>;

export function createPromptContextRoutes(d: PromptContextDeps): Router {
  const router = Router();
  const now = d.now ?? Date.now;
  const log = new DeltaShadowLog(d.stateDir);
  const cursors = new PromptCursorStore(d.stateDir);
  const lastOmission: OmissionIndex = new Map();
  /** One candidate re-fetch row per topic per minute at most (dashboard polling must not crowd the log). */
  const lastReadRow = new Map<number, number>();

  // Candidate re-fetches: a topic history read soon after the delta would have
  // omitted something in that topic. Observes and passes through; never blocks.
  router.use((req: Request, _res: Response, next: NextFunction) => {
    try {
      if (req.method !== 'GET' || isDevice(req)) return next();
      let topicId: number | null = null;
      let route = '';
      let m = /^\/topic\/context\/(\d+)$/.exec(req.path);
      if (m) { topicId = Number(m[1]); route = 'topic-context'; }
      if (!m && (m = /^\/telegram\/topics\/(\d+)\/messages$/.exec(req.path))) { topicId = Number(m[1]); route = 'telegram-messages'; }
      if (!m && (m = /^\/topic\/(\d+)\/messages$/.exec(req.path))) { topicId = Number(m[1]); route = 'topic-messages'; }
      if (!m && req.path === '/topic/search' && typeof req.query.topic === 'string' && /^\d+$/.test(req.query.topic)) { topicId = Number(req.query.topic); route = 'topic-search'; }
      if (topicId !== null) {
        // The seed fetches its history from /topic/context: that is the delta's evidence the seed delivered it.
        // Counted only when the read succeeded: a failed fetch delivered nothing.
        if (route === 'topic-context') { const id = topicId; _res.on('finish', () => { if (_res.statusCode === 200) d.seedFetches.noteHistory(id); }); }
        const o = lastOmission.get(topicId);
        const t = now();
        if (o && t - o.at <= REFETCH_WINDOW_MS && t - (lastReadRow.get(topicId) ?? 0) >= 60_000) {
          lastReadRow.set(topicId, t);
          if (lastReadRow.size > 2_000) lastReadRow.delete(lastReadRow.keys().next().value as number);
          log.append({ t: 'history-read', at: t, topicId, route, sinceOmissionMs: t - o.at, omittedAtPrompt: o.count });
        }
      }
    } catch { /* @silent-fallback-ok — an observer never changes the request it watches */ }
    next();
  });

  router.get('/topic/:topicId/prompt-context', (req: Request, res: Response) => {
    if (isDevice(req)) { res.status(403).json({ error: 'bearer-only' }); return; }
    if (!/^\d{1,15}$/.test(req.params.topicId)) { res.status(400).json({ error: 'topicId must be a number' }); return; }
    const topicId = Number(req.params.topicId);
    const sessionId = param(req.query.session);
    const instarSession = param(req.query.instarSession);
    const framework = typeof req.query.framework === 'string' && /^[a-z0-9-]{1,32}$/.test(req.query.framework) ? req.query.framework : 'claude-code';
    const t = now();
    const shadowOn = d.shadowOn();

    // §7.7: while a fold is open for the topic (or this session's marker exists) the hook is suppressed entirely.
    // Bounded (foldSuppression): Claude Code only, and a stale or torn record never mutes the topic.
    let fold: ReturnType<typeof foldSuppression> = { suppress: false };
    try { fold = foldSuppression(d.stateDir, topicId, instarSession, framework, t); } catch (err) {
      fold = { suppress: false };
      featureEvidence.record(DELTA_HOOK_FEATURE_ID, { kind: 'error', reason: `fold state unreadable, full output sent: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), context: { topicId } });
    }
    if (fold.suppress) {
      if (shadowOn) log.append({ t: 'suppressed', at: t, topicId, session: sessionId, reason: fold.reason });
      featureEvidence.recordAtMostEvery(DELTA_HOOK_FEATURE_ID, `suppressed:${topicId}`, 10 * 60_000, { kind: 'held', reason: `hook suppressed: ${fold.reason}`, context: { topicId } });
      res.json({ schema: 'prompt-context/1', topicId, mode: 'suppressed', reason: fold.reason, briefing: '', messages: [] });
      return;
    }
    if (fold.note) {
      if (shadowOn) log.append({ t: 'fold-not-suppressed', at: t, topicId, session: sessionId, reason: fold.note });
      featureEvidence.recordAtMostEvery(DELTA_HOOK_FEATURE_ID, `fold-note:${topicId}`, 60 * 60_000, { kind: 'error', reason: `fold record ${fold.note}: hook not suppressed`, context: { topicId } });
    }

    // The FULL output: exactly what today's two calls return.
    let briefing = '';
    try { briefing = boundBriefing(d.briefing(topicId)); } catch { briefing = ''; /* @silent-fallback-ok — today's hook also skips a failed briefing fetch */ }
    let raw: Array<Record<string, unknown>> | null = null;
    try { raw = d.messages(topicId, PROMPT_HISTORY_LIMIT); } catch { raw = null; /* @silent-fallback-ok — today's hook prints no history when the read fails */ }
    const messages: PromptMessage[] = (raw ?? []).slice(-PROMPT_HISTORY_LIMIT).map(slimMessage);
    const full = { schema: 'prompt-context/1' as const, topicId, mode: 'full' as const, briefing, messages, telegram: raw !== null };

    if (!shadowOn) { res.json({ ...full, shadow: null }); return; }

    try {
      const epoch = framework === 'claude-code' ? resolveContextEpoch(d.stateDir, sessionId, topicId) : { kind: 'unseeded' as const, key: 'unseeded' as const };
      const cursor = epoch.kind === 'seeded' && sessionId ? cursors.get(topicId, sessionId) : null;
      const delta = computePromptDelta({
        topicId, sessionId, epoch, cursor, briefing, messages, now: t,
        seedBriefing: epoch.kind === 'seeded' ? d.seedFetches.servedNear(topicId, epoch.seededAt, 'briefing') : { found: false, hash: null },
        seedHistory: epoch.kind === 'seeded' ? d.seedFetches.servedNear(topicId, epoch.seededAt, 'history') : { found: false },
      });
      const unanswered = unansweredOf(messages);
      const fullChars = renderPromptContextText(topicId, briefing, messages).length;
      const deltaText = delta.basis === 'unseeded-full'
        ? null
        : renderPromptContextText(topicId, delta.briefingIncluded ? briefing : '', delta.messages, { mode: 'delta', unanswered });
      const deltaChars = deltaText === null ? fullChars : deltaText.length;
      const switchOn = d.deltaSwitchOn();
      const c = d.canary();
      const verdict = reductionVerdict(switchOn, c?.report ?? null, c !== undefined);
      // Delivery: a delta over the delivery budget is not trimmed; that prompt gets the full output.
      const sent = verdict.allowed && delta.basis !== 'unseeded-full' ? fitDeltaForDelivery(topicId, delta, briefing, unanswered) : null;
      const returnDelta = sent !== null && sent.fits;
      const nextCursor = sent ? sent.cursor : delta.nextCursor;
      if (nextCursor && !cursors.put(nextCursor)) {
        featureEvidence.record(DELTA_HOOK_FEATURE_ID, { kind: 'error', reason: 'prompt cursor write failed', context: { topicId } });
      }
      if (delta.omitted.length > 0) {
        lastOmission.set(topicId, { at: t, count: delta.omitted.length });
        if (lastOmission.size > 2_000) lastOmission.delete(lastOmission.keys().next().value as number);
      }
      const ok = log.append({
        t: 'prompt', at: t, topicId, session: sessionId, framework, epoch: epoch.key, basis: delta.basis,
        returned: returnDelta ? 'delta' : 'full', fullChars, deltaChars, briefingIncluded: delta.briefingIncluded,
        omittedCount: delta.omitted.length, omitted: delta.omitted.slice(0, 40),
        reduction: { switchOn, allowed: verdict.allowed, reason: sent && !sent.fits ? 'delta-over-budget' : verdict.reason },
      });
      if (ok) {
        featureEvidence.recordAtMostEvery(DELTA_HOOK_FEATURE_ID, `prompt:${topicId}`, 10 * 60_000, {
          kind: 'fired', reason: 'per-prompt delta measured', context: { topicId, basis: delta.basis, fullChars, deltaChars, returned: returnDelta ? 'delta' : 'full' },
        });
      } else {
        featureEvidence.record(DELTA_HOOK_FEATURE_ID, { kind: 'error', reason: 'shadow log write failed', context: { topicId } });
      }
      const shadow = { epoch: epoch.kind, basis: delta.basis, fullChars, deltaChars, omitted: delta.omitted.length, reduction: verdict.allowed ? 'allowed' : verdict.reason };
      if (sent && sent.fits) {
        res.json({ ...full, mode: 'delta', briefing: sent.briefingIncluded ? briefing : '', messages: sent.messages, unanswered, shadow });
        return;
      }
      res.json({ ...full, shadow });
    } catch (err) {
      // The shadow measurement must never cost the session its context.
      featureEvidence.record(DELTA_HOOK_FEATURE_ID, { kind: 'error', reason: `shadow measurement failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), context: { topicId } });
      res.json({ ...full, shadow: { error: 'measurement-failed' } });
    }
  });

  router.get('/context-budget/delta-shadow', (req: Request, res: Response) => {
    if (isDevice(req)) { res.status(403).json({ error: 'bearer-only' }); return; }
    if (!d.shadowOn()) { res.status(503).json({ error: 'delta shadow not enabled on this agent', enableWith: 'contextBudget.enabled' }); return; }
    const c = d.canary();
    const verdict = reductionVerdict(d.deltaSwitchOn(), c?.report ?? null, c !== undefined);
    res.json({ ...summarizeShadow(log), reduction: { switchOn: d.deltaSwitchOn(), allowed: verdict.allowed, reason: verdict.reason } });
  });

  return router;
}
