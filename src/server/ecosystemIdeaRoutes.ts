/**
 * Routes for the ecosystem idea pipeline (docs/specs/ecosystem-idea-pipeline.md §9).
 *
 * Read from the local replica on any machine, with how fresh it is. A decision is the
 * operator's act: PIN plan and commit, never a bearer token alone, and a machine not holding
 * the lease answers 409 naming the holder. 503 when dark, or `no-source` with no roots.
 */
import crypto from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { RenderedPlanStore, PlanCommitError } from '../core/RenderedPlanStore.js';
import { EpochFencedError, REPO_NAME_RE, type EffectClass } from '../ecosystem/types.js';
import { recordHash } from '../ecosystem/EcosystemLedger.js';
import type { EcosystemRouteContext } from '../ecosystem/buildEcosystemIdeas.js';

export interface EcosystemRouteDeps {
  ecosystem: () => EcosystemRouteContext | { unavailable: 'no-source' } | null;
  checkPin: (req: Request, res: Response) => boolean;
}

const clamp = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function unavailable(deps: EcosystemRouteDeps, res: Response): EcosystemRouteContext | null {
  const e = deps.ecosystem();
  if (!e) { res.status(503).json({ error: 'the ecosystem idea pipeline is not switched on for this agent', reason: 'disabled' }); return null; }
  if ('unavailable' in e) { res.status(503).json({ error: 'no source roots are configured, so ideas cannot be checked against anything', reason: 'no-source' }); return null; }
  return e;
}

function notHolder(e: EcosystemRouteContext, res: Response): boolean {
  if (e.isHolder()) return false;
  res.status(409).json({ error: 'not-serving', holder: e.holderName(), detail: `Decisions and reviews run on ${e.holderName() ?? 'the serving machine'}.` });
  return true;
}

const intent = (req: Request, res: Response): boolean => {
  if (req.headers['x-instar-request'] === '1') return true;
  res.status(403).json({ error: 'X-Instar-Request: 1 required' });
  return false;
};

const safely = (res: Response, fn: () => unknown): void => {
  try { res.json(fn()); } catch (error) {
    if (error instanceof EpochFencedError) { res.status(409).json({ error: 'stale-epoch', detail: error.message }); return; }
    res.status(400).json({ error: error instanceof Error ? error.message.slice(0, 200) : 'failed' });
  }
};

export function registerEcosystemIdeaRoutes(router: Router, deps: EcosystemRouteDeps, plans: RenderedPlanStore = new RenderedPlanStore()): void {
  router.get('/ecosystem-ideas', (req, res) => {
    const e = unavailable(deps, res);
    if (!e) return;
    const body = e.service.summary();
    const scope = req.query.scope === 'pool' ? 'pool' : 'local';
    res.json({ ...body, scope, staleness: { lastEventAt: body.lastEventAt, ...(scope === 'pool' ? { note: 'One ledger per agent, read from this machine\'s replica.' } : {}) } });
  });

  router.get('/ecosystem-ideas/:id/evidence', (req, res) => {
    const e = unavailable(deps, res);
    if (!e) return;
    const evidence = e.service.evidence(req.params.id);
    if (!evidence) { res.status(404).json({ error: 'no such idea' }); return; }
    res.json(evidence);
  });

  router.post('/ecosystem-ideas/tick', (req, res) => {
    const e = unavailable(deps, res);
    if (!e || !intent(req, res) || notHolder(e, res)) return;
    void e.service.tick();
    res.status(202).json({ started: true });
  });

  router.post('/ecosystem-ideas/projects/retry', (req, res) => {
    const e = unavailable(deps, res);
    if (!e || !intent(req, res) || notHolder(e, res)) return;
    const repo = clamp(req.body?.repo, 140);
    if (!REPO_NAME_RE.test(repo)) { res.status(400).json({ error: 'repo must be owner/name' }); return; }
    safely(res, () => { e.service.retryProject(repo); return { retried: repo }; });
  });

  // Recorded facts about a shipped change, not operator decisions.
  router.post('/ecosystem-ideas/:id/adoption', (req, res) => {
    const e = unavailable(deps, res);
    if (!e || !intent(req, res) || notHolder(e, res)) return;
    const prediction = clamp(req.body?.prediction, 400), checkAt = clamp(req.body?.checkAt, 40), ref = clamp(req.body?.ref, 200);
    if (!prediction || !Number.isFinite(Date.parse(checkAt)) || !ref) { res.status(400).json({ error: 'prediction, checkAt (a date) and ref are required' }); return; }
    safely(res, () => { e.service.recordAdoption(req.params.id, { prediction, checkAt, ref }); return { recorded: true }; });
  });

  router.post('/ecosystem-ideas/:id/outcome', (req, res) => {
    const e = unavailable(deps, res);
    if (!e || !intent(req, res) || notHolder(e, res)) return;
    const result = req.body?.result;
    if (!['helped', 'no-change', 'harmed', 'unknown'].includes(result)) { res.status(400).json({ error: 'result must be helped, no-change, harmed or unknown' }); return; }
    safely(res, () => { e.service.recordOutcome(req.params.id, { result, evidence: clamp(req.body?.evidence, 400) }); return { recorded: true }; });
  });

  /** Render what the PIN will approve. A bearer token can render; only the PIN can commit. */
  router.post('/ecosystem-ideas/plan', (req, res) => {
    const e = unavailable(deps, res);
    if (!e || !intent(req, res) || notHolder(e, res)) return;
    const action = String(req.body?.action ?? '');
    const state = e.ledger.state();
    const ideaId = clamp(req.body?.ideaId, 80);
    const idea = ideaId ? state.ideas.get(ideaId) : undefined;
    const claim = () => idea?.sightings[idea.sightings.length - 1]?.claim.slice(0, 200) ?? '';
    const render = (text: string, fields: Record<string, unknown>) => {
      const plan = plans.render(`ecosystem-${action}`, text, { action, ...(idea ? { recordHash: recordHash(idea) } : {}), ...fields }, {});
      res.json({ action, planId: plan.planId, nonce: plan.nonce, renderedText: plan.renderedText, expiresAt: plan.expiresAt });
    };
    if (action === 'watchlist-add') {
      const repo = clamp(req.body?.repo, 140);
      if (!REPO_NAME_RE.test(repo)) { res.status(400).json({ error: 'repo must be owner/name' }); return; }
      render(`Add ${repo} to the weekly review list. It will be read, never run.`, { repo, reason: clamp(req.body?.reason, 200) });
      return;
    }
    if (!idea) { res.status(400).json({ error: 'ideaId must name an idea' }); return; }
    if (action === 'decline') { render(`Decline this idea. It comes back only with new evidence at a new commit: "${claim()}"`, { ideaId, reason: clamp(req.body?.reason, 200) }); return; }
    if (action === 'start-spec') { render(`Start a spec for this idea. A draft changes nothing for any agent: "${claim()}"`, { ideaId }); return; }
    if (action === 'later') { render(`Leave this idea for later: "${claim()}"`, { ideaId }); return; }
    if (action === 'split') {
      const sightingId = clamp(req.body?.sightingId, 60);
      if (!idea.sightings.some((s) => s.sightingId === sightingId) || idea.sightings.length < 2) { res.status(400).json({ error: 'sightingId must name one of at least two sightings on this idea' }); return; }
      render(`Split one sighting off into its own idea: "${claim()}"`, { ideaId, sightingId });
      return;
    }
    if (action === 'lower-class') {
      const effectClass = req.body?.effectClass as EffectClass;
      if (!['additive-dark', 'behaviour-changing'].includes(effectClass)) { res.status(400).json({ error: 'effectClass must be additive-dark or behaviour-changing' }); return; }
      render(`Lower this idea's risk class to ${effectClass}, which lowers the evidence it needs: "${claim()}"`, { ideaId, effectClass, reason: clamp(req.body?.reason, 200) });
      return;
    }
    if (action === 'exception') {
      const scope = clamp(req.body?.scope, 200), rollback = clamp(req.body?.rollback, 200), expiresAt = clamp(req.body?.expiresAt, 40), reviewAt = clamp(req.body?.reviewAt, 40);
      if (!scope || !rollback || !Number.isFinite(Date.parse(expiresAt)) || !Number.isFinite(Date.parse(reviewAt))) {
        res.status(400).json({ error: 'an exception names scope and rollback, and carries expiresAt and reviewAt dates' }); return;
      }
      render(`Accept this idea WITHOUT the evidence it needs. Scope: ${scope}. Rollback: ${rollback}. Expires ${expiresAt}, reviewed ${reviewAt}. "${claim()}"`, { ideaId, scope, rollback, expiresAt, reviewAt });
      return;
    }
    res.status(400).json({ error: 'unknown action' });
  });

  router.post('/ecosystem-ideas/commit', (req, res) => {
    const e = unavailable(deps, res);
    if (!e || !intent(req, res) || notHolder(e, res)) return;
    if (!deps.checkPin(req, res)) return; // the response is already sent
    void (async () => {
      const plan = plans.commit(clamp(req.body?.planId, 40), clamp(req.body?.nonce, 80), {});
      const f = plan.fields as Record<string, string>;
      if (f.recordHash) {
        // The PIN approved the revision on screen. New evidence since then means a new look.
        const current = e.ledger.state().ideas.get(f.ideaId);
        if (!current || recordHash(current) !== f.recordHash) { res.status(409).json({ error: 'stale-plan', detail: 'New evidence arrived after this was shown. Open it again.' }); return; }
      }
      const ref = `dashboard-pin:${plan.planId}:${crypto.randomBytes(3).toString('hex')}`;
      const base = { by: 'operator' as const, ref };
      switch (f.action) {
        case 'watchlist-add': e.service.addToWatchlist(f.repo, ref, f.reason); break;
        case 'decline': e.service.recordDecision(f.ideaId, { ...base, action: 'decline', reason: f.reason }); break;
        case 'later': e.service.recordDecision(f.ideaId, { ...base, action: 'later' }); break;
        case 'lower-class': e.service.recordDecision(f.ideaId, { ...base, action: 'lower-class', effectClass: f.effectClass as EffectClass, reason: f.reason }); break;
        case 'exception': e.service.recordDecision(f.ideaId, { ...base, action: 'exception', scope: f.scope, rollback: f.rollback, expiresAt: f.expiresAt, reviewAt: f.reviewAt }); break;
        case 'split': res.json({ committed: true, action: f.action, newIdeaId: e.service.splitSighting(f.ideaId, f.sightingId) }); return;
        case 'start-spec': res.json({ committed: true, action: f.action, sessionName: await e.service.operatorStartSpec(f.ideaId, ref) }); return;
        default: res.status(400).json({ error: 'unknown action' }); return;
      }
      res.json({ committed: true, action: f.action, ref, renderedText: plan.renderedText });
    })().catch((error) => { // @silent-fallback-ok: not silent — the error is returned to the caller as an HTTP error status
      if (res.headersSent) return;
      const code = error instanceof PlanCommitError || error instanceof EpochFencedError ? 409 : 400;
      res.status(code).json({ error: error instanceof Error ? error.message.slice(0, 200) : 'commit failed' });
    });
  });
}
