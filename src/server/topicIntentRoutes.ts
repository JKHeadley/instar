/**
 * Topic Intent HTTP routes — diagnostics + read-only projection access.
 *
 * Layer 1 component. Exposes per-topic state so the user (operator) and
 * the agent itself can inspect what's being tracked, how confident the
 * agent is in each item, and what evidence built that confidence.
 *
 * Framework-agnostic: only depends on TopicIntentStore (file-based) and
 * Express. No Claude Code or Codex specifics.
 *
 * Endpoints:
 *   GET /topic-intent/:topicId/diagnostics — full projection snapshot
 *   GET /topic-intent/:topicId/refs        — just the refs (compact)
 *   GET /topic-intent/:topicId/pending     — outstanding + queued
 *   GET /topic-intent/:topicId/telemetry   — counters
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { TopicIntentStore } from '../core/TopicIntent.js';
import { defaultCaptureCounters } from '../core/TopicIntent.js';
import { renderTopicIntentBriefing } from '../core/TopicIntentBriefing.js';
import { ArcCheck, type ArcCheckClassifyFn } from '../core/TopicIntentArcCheck.js';

const TopicIdParam = z.coerce.number().int().nonnegative();

/**
 * PII safety: when returning diagnostics, evidence event meta is allowed
 * to leak only known-safe fields. Raw user-message text is NEVER returned
 * — the projection diagnostics show structural information, not content.
 *
 * (This is the "diagnostics-PII-leak" threat the GSD planner spike flagged:
 * a diagnostics endpoint that returns raw .text of refs is a content leak
 * vector. We return the propositionText that the LLM already distilled,
 * which is bounded by the extractor's 1-2-sentence rule.)
 */
function sanitizeMetaForDiagnostics(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  // Allowlist: only well-known structural fields
  for (const k of ['retry', 'final', 'reason', 'verdict']) {
    if (k in meta) out[k] = meta[k];
  }
  return out;
}

export function createTopicIntentRoutes(deps: {
  topicIntentStore: TopicIntentStore | null;
  /** Layer 3 ArcCheck instance. Null/undefined → arccheck route returns
   *  a no-fire verdict (degrades open). Production constructs one shared
   *  instance in server.ts so the HTTP route and the in-process
   *  outbound-gate caller use the same classifier. */
  arcCheck?: ArcCheck | null;
  /** Legacy entrypoint — when `arcCheck` is not provided but a classifier
   *  function is, construct a per-route ArcCheck instance from it. Kept so
   *  pre-existing tests and out-of-process integrations keep working
   *  unchanged. Production passes `arcCheck` directly. */
  arcCheckClassify?: ArcCheckClassifyFn | null;
}): Router {
  const router = Router();
  const { topicIntentStore: store } = deps;
  const arcCheck = !store
    ? null
    : deps.arcCheck ?? (deps.arcCheckClassify ? new ArcCheck(store, deps.arcCheckClassify) : null);

  if (!store) {
    // Wire a 503 stub so the route surface exists even when the feature is disabled
    router.use('/topic-intent', (_req, res) => {
      res.status(503).json({ error: 'topic-intent disabled' });
    });
    return router;
  }

  router.get('/topic-intent/:topicId/diagnostics', (req: Request, res: Response) => {
    const parsed = TopicIdParam.safeParse(req.params.topicId);
    if (!parsed.success) return res.status(400).json({ error: 'invalid topicId' });
    const topicId = parsed.data;

    const file = store.read(topicId);
    const refsAll = store.getRefsAtOrAbove(topicId, 'observation');
    const tierCount = { observation: 0, tentative: 0, authoritative: 0 };
    const refsOut = refsAll.map(r => {
      tierCount[r.projection.tier]++;
      return {
        refId: r.refId,
        arcId: r.arcId,
        kind: r.kind,
        text: r.text,                           // proposition text (LLM-distilled, bounded)
        confidence: r.projection.confidence,
        tier: r.projection.tier,
        authorityClampApplied: r.projection.authorityClampApplied,
        decayApplied: r.projection.decayApplied,
        evidenceCount: r.projection.evidenceCount,
        userAuthoredEpisodes: r.projection.userAuthoredEpisodes,
        lastReinforcedAt: r.lastReinforcedAt,
        status: r.status,
        // Slim evidence summary — no message text, only structural fields
        recentEvidence: r.evidence.slice(-10).map(e => ({
          eventId: e.eventId,
          kind: e.kind,
          userAuthored: e.userAuthored,
          at: e.at,
          delta: e.delta,
          sourceMessageId: e.sourceMessageId,
          meta: sanitizeMetaForDiagnostics(e.meta as Record<string, unknown> | undefined),
        })),
      };
    });

    res.json({
      topicId,
      refs: refsOut,
      tierDistribution: tierCount,
      pending: {
        outstanding: file.pending.outstanding,
        queueDepth: file.pending.queue.length,
        queuedRefIds: file.pending.queue.map(p => p.refId),
      },
      telemetry: file.telemetry,
      schemaVersion: file.schemaVersion,
    });
  });

  router.get('/topic-intent/:topicId/refs', (req: Request, res: Response) => {
    const parsed = TopicIdParam.safeParse(req.params.topicId);
    if (!parsed.success) return res.status(400).json({ error: 'invalid topicId' });
    const tierFilter = (req.query.tier as string | undefined) ?? 'observation';
    if (!['observation', 'tentative', 'authoritative'].includes(tierFilter)) {
      return res.status(400).json({ error: 'invalid tier filter' });
    }
    const refs = store.getRefsAtOrAbove(parsed.data, tierFilter as 'observation' | 'tentative' | 'authoritative');
    res.json({
      topicId: parsed.data,
      refs: refs.map(r => ({
        refId: r.refId,
        text: r.text,
        kind: r.kind,
        confidence: r.projection.confidence,
        tier: r.projection.tier,
        lastReinforcedAt: r.lastReinforcedAt,
      })),
    });
  });

  router.get('/topic-intent/:topicId/pending', (req: Request, res: Response) => {
    const parsed = TopicIdParam.safeParse(req.params.topicId);
    if (!parsed.success) return res.status(400).json({ error: 'invalid topicId' });
    const file = store.read(parsed.data);
    res.json({
      topicId: parsed.data,
      outstanding: file.pending.outstanding,
      queue: file.pending.queue,
    });
  });

  router.get('/topic-intent/:topicId/telemetry', (req: Request, res: Response) => {
    const parsed = TopicIdParam.safeParse(req.params.topicId);
    if (!parsed.success) return res.status(400).json({ error: 'invalid topicId' });
    const file = store.read(parsed.data);
    res.json({ topicId: parsed.data, telemetry: file.telemetry });
  });

  /**
   * Layer 2 briefing endpoint. Returns plain text suitable for direct
   * inject into a bootstrap context. Empty body (200) when nothing has
   * accumulated to tentative or above — bootstrap hooks can skip
   * injection cleanly without a 404 detour.
   *
   * Content-Type: text/plain so the consuming shell script can pipe it
   * directly without JSON parsing.
   */
  router.get('/topic-intent/:topicId/briefing', (req: Request, res: Response) => {
    const parsed = TopicIdParam.safeParse(req.params.topicId);
    if (!parsed.success) return res.status(400).type('text/plain').send('');
    const topicId = parsed.data;
    const result = renderTopicIntentBriefing(store, topicId);
    // Surface-side metering (spec §10): a briefing fetch = the captured set
    // actually reached the agent. Record it + how many refs it carried.
    try {
      const settled = store.getRefsAtOrAbove(topicId, 'authoritative').length;
      const tentativePlus = store.getRefsAtOrAbove(topicId, 'tentative').length;
      store.bumpCaptureCounters(topicId, {
        briefing_served: 1,
        briefing_refs_settled: settled,
        briefing_refs_tentative: Math.max(0, tentativePlus - settled),
      });
    } catch { /* metering best-effort — never block a briefing fetch */ }
    res.type('text/plain').send(result.text);
  });

  /**
   * Capture-loop funnel metrics (spec §10) — the "tune as we go" surface. Shows
   * the WHOLE loop (captured → surfaced → used → corrected), so we can see where
   * it leaks: capturing nothing? capturing but never surfacing? surfacing but
   * never acted on? Operator-only (INTERNAL_PREFIXES). `refs_decayed` is computed
   * live (decay is a read-time projection, not a persisted event).
   */
  router.get('/topic-intent/:topicId/capture-metrics', (req: Request, res: Response) => {
    const parsed = TopicIdParam.safeParse(req.params.topicId);
    if (!parsed.success) return res.status(400).json({ error: 'invalid topicId' });
    const topicId = parsed.data;
    const file = store.read(topicId);
    const c = file.telemetry.capture ?? defaultCaptureCounters();
    const refs = store.getRefsAtOrAbove(topicId, 'observation');
    const refs_decayed = refs.filter(r => r.projection.decayApplied > 0).length;
    res.json({
      topicId,
      funnel: {
        turns_seen: c.turns_seen,
        prefilter_skipped: c.prefilter_skipped,
        extractions_attempted: c.extractions_attempted,
        extractions_emitted: c.extractions_emitted,
        refs_created: c.refs_created,
        degraded: {
          no_intelligence: c.degraded_no_intelligence,
          cap_or_error: c.degraded_cap_or_error,
          shed: c.degraded_shed,
        },
        rate_limited: c.rate_limited,
        briefing_served: c.briefing_served,
        briefing_refs: { settled: c.briefing_refs_settled, tentative: c.briefing_refs_tentative },
        arccheck_fired: c.arccheck_fired,
        arccheck_signalled: c.arccheck_signalled,
        refs_decayed,
        refkind_created: c.refkind_created ?? {},
        last_capture_at: c.last_capture_at,
      },
      refsLive: refs.length,
    });
  });

  /**
   * Layer 3 ArcCheck endpoint. POST with the draft text; returns the
   * verdict. Signal-only — the caller is the outbound gate, ArcCheck
   * does not block by itself.
   *
   * When the classifier is not wired (e.g. no LLM provider configured),
   * the route degrades open and returns {fire: false}. Bootstrap hooks
   * and outbound paths can call this unconditionally and only act if
   * fire is true.
   */
  router.post('/topic-intent/:topicId/arccheck', async (req: Request, res: Response) => {
    const parsed = TopicIdParam.safeParse(req.params.topicId);
    if (!parsed.success) return res.status(400).json({ error: 'invalid topicId' });
    const draftText = typeof req.body?.draftText === 'string' ? req.body.draftText : '';
    if (!draftText) return res.status(400).json({ error: 'draftText required' });
    if (!arcCheck) {
      return res.json({ fire: false, reason: 'arccheck classifier not configured (degrade-open)' });
    }
    try {
      const forUserTurn = typeof req.body?.forUserTurn === 'number' ? req.body.forUserTurn : undefined;
      const verdict = await arcCheck.check({ topicId: parsed.data, draftText, forUserTurn });
      // Surface-side metering (spec §10): ArcCheck ran (fired); `signalled` when
      // it actually emitted a confirm-signal (a captured ref changed the next move).
      store.bumpCaptureCounters(parsed.data, {
        arccheck_fired: 1,
        arccheck_signalled: verdict.fire ? 1 : 0,
      });
      return res.json(verdict);
    } catch (err) {
      // Degrade open on any classifier error — never block a send on ArcCheck noise.
      return res.json({ fire: false, reason: `arccheck error (degrade-open): ${(err as Error).message}` });
    }
  });

  return router;
}
