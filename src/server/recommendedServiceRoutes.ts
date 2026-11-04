/**
 * Routes for recommended outside services (docs/specs/recommended-services.md, Surfaces).
 * Reading is open to any session. A no is the operator's act, so it needs the PIN, never a
 * bearer token alone. A yes needs a single-use token and the PIN, and is refused for a service
 * with no proven setup. Absent ledger answers 503.
 */
import type { Request, Response, Router } from 'express';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { NO_REASONS, type NoReason, type RecommendedServicesLedger } from '../recommended/RecommendedServicesLedger.js';
import { RECOMMENDED_SERVICE_CATALOG, isServiceAvailable, offerTextHash, type CatalogRow } from '../recommended/catalog.js';
import { ConfirmTokenStore } from '../recommended/confirmTokens.js';
import { isMigrationComplete, readDeliveredFirstResult } from '../recommended/offerPrerequisites.js';
import { RECOMMENDED_SERVICE_IDS } from '../recommended/serviceIds.js';

export interface RecommendedServiceRouteDeps {
  ledger: () => RecommendedServicesLedger | null;
  stateDir: string;
  checkPin: (req: Request, res: Response) => boolean;
  /** The PIN check for the confirm route, which has no bearer token in front of it. */
  checkConfirmPin: (req: Request, res: Response) => boolean;
  /** The dashboard unlock's rule: this connection may not carry a PIN. */
  pinEntryRefused?: (req: Request) => boolean;
  /** The one verified owner, or null when none can be told. */
  owner: () => string | null;
  recordApproval: (subject: string, evidenceRef: string) => void;
  openCommitment: (name: string, service: string) => void;
  /** Tests supply a row with a recipe, since no real service has one yet. */
  catalog?: readonly CatalogRow[];
  now?: () => number;
}

export function registerRecommendedServiceRoutes(router: Router, deps: RecommendedServiceRouteDeps): void {
  const catalog = deps.catalog ?? RECOMMENDED_SERVICE_CATALOG;
  const tokens = new ConfirmTokenStore({ stateDir: deps.stateDir, now: deps.now });
  const ledgerOr503 = (res: Response): RecommendedServicesLedger | null => {
    const ledger = deps.ledger();
    if (!ledger) res.status(503).json({ error: 'recommended-services-unavailable', detail: 'Choices cannot be saved on this machine yet, because it has no machine identity.' });
    return ledger;
  };

  router.get('/recommended-services', (_req, res) => {
    const ledger = ledgerOr503(res);
    if (!ledger) return;
    const services = catalog.map((row) => {
      const { id, setupRecipe: _setupRecipe, ...text } = row;
      return { ...text, ...ledger.effective(id), available: isServiceAvailable(row) };
    });
    res.json({ services, offersLive: false, migrationComplete: isMigrationComplete(deps.stateDir), firstResult: readDeliveredFirstResult(deps.stateDir), replicating: ledger.isReplicating() });
  });

  router.post('/recommended-services/:id/no', (req, res) => {
    const ledger = ledgerOr503(res);
    if (!ledger) return;
    if (!RECOMMENDED_SERVICE_IDS.includes(req.params.id)) {
      res.status(404).json({ error: 'unknown-service' });
      return;
    }
    if (req.headers['x-instar-request'] !== '1') {
      res.status(403).json({ error: 'X-Instar-Request: 1 required' });
      return;
    }
    const { reason = 'none', shutdown = false } = (req.body ?? {}) as { reason?: unknown; shutdown?: unknown };
    if (!NO_REASONS.includes(reason as NoReason)) {
      res.status(400).json({ error: 'invalid-reason', valid: NO_REASONS });
      return;
    }
    if (typeof shutdown !== 'boolean') {
      res.status(400).json({ error: 'invalid-shutdown' });
      return;
    }
    if (!deps.checkPin(req, res)) return;
    try {
      ledger.recordNo({ service: req.params.id, reason: reason as NoReason, shutdown: shutdown ? 'authorized' : 'none', origin: 'owner-surface' });
    } catch {
      res.status(503).json({ error: 'recommended-services-unavailable', detail: 'That choice could not be saved. Nothing changed.' });
      return;
    }
    // Open pages refuse this no anyway through their list of known nos. This only tidies up.
    try {
      tokens.invalidateService(req.params.id);
    } catch { /* @silent-fallback-ok — nosAtOpen still voids every open page */ }
    res.json(ledger.effective(req.params.id));
  });

  /** Opening the page mints its token. Carries only catalog text, and the token alone grants nothing. */
  router.get('/recommended-services/:id/confirm', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const ledger = ledgerOr503(res);
    if (!ledger) return;
    const row = catalog.find((r) => r.id === req.params.id);
    if (!row) {
      res.status(404).json({ error: 'unknown-service' });
      return;
    }
    if (!isServiceAvailable(row)) {
      res.status(409).json({ error: 'not-available' });
      return;
    }
    // A PIN box the server would refuse is never shown, because the PIN would already have travelled.
    if (deps.pinEntryRefused?.(req)) {
      res.status(403).json({ error: 'insecure-connection' });
      return;
    }
    const owner = deps.owner();
    if (!owner) {
      res.status(409).json({ error: 'no-owner' });
      return;
    }
    let minted: { token: string; expiresAt: number };
    try {
      minted = tokens.mint({ service: row.id, owner, targetMachine: ledger.machineId(), offerTextHash: offerTextHash(row), origin: 'person-asked', nosAtOpen: ledger.knownNoIds(row.id) });
    } catch {
      res.status(503).json({ error: 'recommended-services-unavailable' });
      return;
    }
    const { name, benefit, dataLeaves, cost, account, backup } = row;
    res.json({ service: row.id, name, benefit, dataLeaves, cost, account, backup, ...minted });
  });

  router.post('/recommended-services/:id/confirm', (req, res) => {
    const ledger = ledgerOr503(res);
    if (!ledger) return;
    const row = catalog.find((r) => r.id === req.params.id);
    if (!row) {
      res.status(404).json({ error: 'unknown-service' });
      return;
    }
    if (req.headers['x-instar-request'] !== '1') {
      res.status(403).json({ error: 'X-Instar-Request: 1 required' });
      return;
    }
    const { token } = (req.body ?? {}) as { token?: unknown };
    if (typeof token !== 'string' || !token || token.length > 128) {
      res.status(400).json({ error: 'token-refused' });
      return;
    }
    // A PIN is only looked at for a real, live request, so this route can't test PIN guesses for
    // anyone who hasn't a page open, and a mistyped PIN doesn't spend the token.
    if (!isServiceAvailable(row)) {
      res.status(409).json({ error: 'not-available' });
      return;
    }
    if (!tokens.isLive(token, row.id)) {
      res.status(409).json({ error: 'token-refused' });
      return;
    }
    if (!deps.checkConfirmPin(req, res)) return;
    const binding = tokens.consume(token, row.id);
    if (!binding) {
      res.status(409).json({ error: 'token-refused' });
      return;
    }
    const refusal = binding.offerTextHash !== offerTextHash(row) ? 'text-changed'
      : ledger.knownNoIds(row.id).some((id) => !binding.nosAtOpen.includes(id)) ? 'no-since-open'
        : binding.owner !== deps.owner() ? 'wrong-owner'
          : binding.targetMachine !== ledger.machineId() ? 'wrong-machine'
            : null;
    if (refusal) {
      res.status(409).json({ error: refusal });
      return;
    }
    // A second tab or an old link must not write a second yes, approval and commitment. A yes to new
    // text, or from a new owner, is a fresh consent and gets its own row.
    const already = ledger.activeGrant(row.id, binding.targetMachine);
    if (already && already.offerTextHash === binding.offerTextHash && already.principal === binding.owner) {
      res.json(ledger.effective(row.id));
      return;
    }
    let yes;
    try {
      yes = ledger.recordYes({ service: row.id, origin: binding.origin, offerTextHash: binding.offerTextHash, grantMachine: binding.targetMachine, principal: binding.owner });
    } catch {
      res.status(503).json({ error: 'recommended-services-unavailable', detail: 'That choice could not be saved. Nothing changed.' });
      return;
    }
    // The yes is saved and stands. These two are records of it, so a failure here is reported, not refused.
    const followUps: [string, () => void][] = [
      ['approval record', () => deps.recordApproval(`recommended-service:${row.id}`, yes.eventId)],
      ['setup commitment', () => deps.openCommitment(row.name, row.id)],
    ];
    for (const [what, run] of followUps) {
      try {
        run();
      } catch (err) {
        DegradationReporter.getInstance().report({
          feature: 'RecommendedServices.confirm',
          primary: `Write the ${what} after the owner said yes to ${row.id}`,
          fallback: 'The yes is saved. This record is missing.',
          reason: err instanceof Error ? err.message : String(err),
          impact: `Setup of ${row.name} may not be tracked until someone notices.`,
        });
      }
    }
    res.json(ledger.effective(row.id));
  });
}
