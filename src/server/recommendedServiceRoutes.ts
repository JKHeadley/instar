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
import { recipeFor, type RecipeDeps, type VerifyResult } from '../recommended/recipes.js';
import { readSetupStates, updateSetupState, type ServiceSetupState } from '../recommended/setupState.js';
import { decideSetupRestart } from '../recommended/setupRestart.js';
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
  /** Returns the commitment's id. */
  openCommitment: (name: string, service: string) => string | null;
  /** Done: verify passed. */
  finishCommitment: (id: string) => void;
  /** Off: the person said no. */
  withdrawCommitment: (id: string, reason: string) => void;
  /** Starts the session in its own conversation, reusing that topic on a restart. */
  startSetup: (service: string, name: string, brief: string, topicId?: number) => Promise<{ sessionName: string; topicId: number }>;
  /** False when the session didn't stop. */
  stopSetup: (sessionName: string) => boolean;
  /** The session a conversation runs in now. A reply can bring it back under another name. */
  sessionForTopic?: (topicId: number) => string | null;
  /** Sessions outlive a server restart, so a resume must not start a second copy. */
  isSetupRunning: (sessionName: string) => boolean;
  /** Starts ran out. One notice to the person, because nothing else would say so. True once it's sent. */
  notifyStuck: (service: string, name: string) => Promise<boolean>;
  /** Closes that notice when a pass or a no makes it moot. */
  clearStuck: (service: string) => void;
  /** A plain line to the person, for a yes that needed no setup. */
  tellOwner: (text: string) => void;
  writeSecret: (name: string, value: string) => void;
  readSecret: (name: string) => string | null;
  port: number;
  fetch?: typeof fetch;
  /** Tests supply Tailscale's answer; real servers let the recipe ask the program on this machine. */
  tailscaleStatus?: RecipeDeps['tailscaleStatus'];
  /** Hands over the check to run once sessions can start, and on a timer after that. */
  onReady?: (reconcile: () => Promise<void>) => void;
  /** Tests supply a row with a recipe, since no real service has one yet. */
  catalog?: readonly CatalogRow[];
  now?: () => number;
}

/** What the list shows about setup on this machine. */
function setupView(state: ServiceSetupState | undefined): { verified: ServiceSetupState['verified'] | null; alreadyHeld: boolean; stalled: boolean; held: boolean } {
  return { verified: state?.verified ?? null, alreadyHeld: !!state?.alreadyHeld, stalled: !!state?.exhausted, held: !!state?.held };
}

export function registerRecommendedServiceRoutes(router: Router, deps: RecommendedServiceRouteDeps): void {
  const catalog = deps.catalog ?? RECOMMENDED_SERVICE_CATALOG;
  const tokens = new ConfirmTokenStore({ stateDir: deps.stateDir, now: deps.now });
  let mintLimitReported = false;
  const starting = new Set<string>();
  const report = (primary: string, err: unknown, impact: string): void => {
    DegradationReporter.getInstance().report({
      feature: 'RecommendedServices.setup', primary, fallback: 'The choice is saved. This step did not happen.',
      reason: err instanceof Error ? err.message : String(err), impact,
    });
  };
  const hasGrant = (service: string): boolean => {
    const ledger = deps.ledger();
    return !!ledger && ledger.activeGrant(service, ledger.machineId()) !== null;
  };
  const currentState = (service: string): ServiceSetupState | undefined => {
    const state = readSetupStates(deps.stateDir)[service];
    // Only while setup has a session: a topic keeps its last name after a kill, and a no has let go of this one.
    const live = state?.sessionName && state.topicId !== undefined ? deps.sessionForTopic?.(state.topicId) : null;
    return live && live !== state?.sessionName ? updateSetupState(deps.stateDir, service, { sessionName: live }) : state;
  };
  /** A new yes from the person: a clean start, with the restarts it would have had the first time. */
  const liftHold = (service: string): void => {
    if (!readSetupStates(deps.stateDir)[service]?.held) return;
    updateSetupState(deps.stateDir, service, { held: undefined, attempts: undefined, lastAttemptAt: undefined, exhausted: undefined, dormant: undefined });
  };
  /** A no ends the work in progress and the promise to finish it, on this machine. */
  const endSetup = (service: string): void => {
    const state = currentState(service);
    if (!state) return;
    try {
      // Only forget a session that really stopped, so the next tick tries again if it didn't.
      const stopped = !state.sessionName || !deps.isSetupRunning(state.sessionName) || deps.stopSetup(state.sessionName);
      if (state.commitmentId) deps.withdrawCommitment(state.commitmentId, 'The owner said no.');
      updateSetupState(deps.stateDir, service, {
        sessionName: stopped ? undefined : state.sessionName, commitmentId: undefined, verified: undefined,
        // keyStoredBySetup stays: the key itself stays after a no, so a later yes can still replace one that has died.
        alreadyHeld: undefined, attempts: undefined, lastAttemptAt: undefined, exhausted: undefined, dormant: undefined, held: undefined,
      });
      deps.clearStuck(service);
    } catch (err) {
      report(`End setup of ${service} after a no`, err, 'A setup session or its promise may still be open. The next check tries again, and verifying is refused.');
    }
  };
  const recordVerify = (service: string, outcome: VerifyResult, alreadyHeld: boolean): void => {
    const before = readSetupStates(deps.stateDir)[service];
    // An outage says nothing new, so it never takes a pass away. That would restart setup on a working service.
    if (outcome.result === 'unknown' && before?.verified?.result === 'pass') return;
    const state = updateSetupState(deps.stateDir, service, {
      verified: { at: new Date(deps.now?.() ?? Date.now()).toISOString(), ...outcome },
      ...(alreadyHeld ? { alreadyHeld: true } : {}),
      ...(outcome.result === 'pass' ? { held: undefined } : {}),
    });
    if (outcome.result !== 'pass' || !state.commitmentId) return;
    try {
      deps.finishCommitment(state.commitmentId);
      updateSetupState(deps.stateDir, service, { commitmentId: undefined, attempts: undefined, exhausted: undefined, dormant: undefined });
      deps.clearStuck(service);
    } catch (err) {
      report(`Close the setup commitment for ${service}`, err, 'The service works, but its promise still reads as open.');
    }
  };
  /**
   * Starts the session, unless this machine already passes the check or a session is already at work.
   * A key already held must never lead to a new sign-up that replaces it, so an unreadable check starts
   * nothing and costs nothing: the next regular check looks again.
   */
  const beginSetup = async (row: CatalogRow): Promise<void> => {
    const recipe = recipeFor(row);
    if (!recipe || starting.has(row.id)) return;
    const before = currentState(row.id);
    if (before?.sessionName && deps.isSetupRunning(before.sessionName)) return;
    starting.add(row.id);
    try {
      const preflight = await recipe.verify({ readSecret: deps.readSecret, fetch: deps.fetch, tailscaleStatus: deps.tailscaleStatus });
      if (!hasGrant(row.id) || preflight.result === 'unknown') return;
      // The check takes a moment, and a stop can land in it.
      if (readSetupStates(deps.stateDir)[row.id]?.held) return;
      if (preflight.result === 'pass') {
        recordVerify(row.id, preflight, true);
        deps.tellOwner(`${row.name} was already working on this machine, so there's nothing for me to set up.`);
        return;
      }
      updateSetupState(deps.stateDir, row.id, { attempts: (before?.attempts ?? 0) + 1, lastAttemptAt: new Date(deps.now?.() ?? Date.now()).toISOString(), dormant: undefined });
      const { sessionName, topicId } = await deps.startSetup(row.id, row.name, recipe.brief({ port: deps.port }), before?.topicId);
      updateSetupState(deps.stateDir, row.id, { sessionName, topicId });
      // A no can land while the session starts, when there was nothing yet to stop.
      if (!hasGrant(row.id)) endSetup(row.id);
    } catch (err) {
      report(`Start setup of ${row.id}`, err, `${row.name} is approved but nothing is setting it up yet. The next check tries again, a limited number of times.`);
    } finally {
      starting.delete(row.id);
    }
  };
  /**
   * Runs at boot and on a timer. A no from another machine ends the work here. A granted service with
   * no live session and no pass gets a bounded restart, then one notice, because nothing else would
   * say that setup quietly died.
   */
  const reconcile = async (): Promise<void> => {
    const ledger = deps.ledger();
    if (!ledger) return;
    const nowMs = deps.now?.() ?? Date.now();
    for (const row of catalog) {
      const state = currentState(row.id);
      if (!hasGrant(row.id)) {
        if (state?.commitmentId || state?.sessionName) endSetup(row.id);
        continue;
      }
      if (!isServiceAvailable(row) || state?.verified?.result === 'pass' || state?.exhausted || state?.dormant || state?.held) continue;
      if (state?.sessionName && deps.isSetupRunning(state.sessionName)) continue;
      const decision = decideSetupRestart({ starts: state?.attempts ?? 0, lastStartMs: state?.lastAttemptAt ? Date.parse(state.lastAttemptAt) : null, nowMs });
      if (decision === 'restart') await beginSetup(row);
      else if (decision === 'dormant') updateSetupState(deps.stateDir, row.id, { dormant: true, sessionName: undefined });
      else if (decision === 'give-up' && await deps.notifyStuck(row.id, row.name)) updateSetupState(deps.stateDir, row.id, { exhausted: true });
    }
  };
  deps.onReady?.(reconcile);

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
      return { ...text, ...ledger.effective(id), available: isServiceAvailable(row), grantedHere: ledger.activeGrant(id, ledger.machineId()) !== null, ...setupView(readSetupStates(deps.stateDir)[id]) };
    });
    res.json({ services, offersLive: false, migrationComplete: isMigrationComplete(deps.stateDir), firstResult: readDeliveredFirstResult(deps.stateDir), replicating: ledger.isReplicating() });
  });

  /** Asks for nothing and grants nothing: it only stops this session being restarted, so it needs no PIN. */
  router.post('/recommended-services/:id/hold', (req, res) => {
    const row = catalog.find((r) => r.id === req.params.id);
    if (!row || !recipeFor(row)) {
      res.status(404).json({ error: 'no-recipe' });
      return;
    }
    if (req.headers['x-instar-request'] !== '1') {
      res.status(403).json({ error: 'X-Instar-Request: 1 required' });
      return;
    }
    res.json({ held: !!updateSetupState(deps.stateDir, req.params.id, { held: true }).held });
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
    endSetup(req.params.id);
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
    if (!tokens.mayMint()) {
      if (!mintLimitReported) {
        mintLimitReported = true;
        DegradationReporter.getInstance().report({
          feature: 'RecommendedServices.confirmPage',
          primary: 'Open a service confirm page',
          fallback: 'The page says to wait a minute. No token is written.',
          reason: 'The page is being opened faster than a person could, which needs no credential.',
          impact: 'While this lasts, the owner cannot open the page to say yes or no.',
        });
      }
      res.status(429).json({ error: 'too-many-pages' });
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
    const { token, answer, reason = 'none' } = (req.body ?? {}) as { token?: unknown; answer?: unknown; reason?: unknown };
    if (typeof token !== 'string' || !token || token.length > 128) {
      res.status(400).json({ error: 'token-refused' });
      return;
    }
    if (answer !== 'yes' && answer !== 'no') {
      res.status(400).json({ error: 'invalid-answer' });
      return;
    }
    if (!NO_REASONS.includes(reason as NoReason)) {
      res.status(400).json({ error: 'invalid-reason', valid: NO_REASONS });
      return;
    }
    // A PIN is only looked at for a real, live request, so this route can't test PIN guesses for
    // anyone who hasn't a page open, and a mistyped PIN doesn't spend the token.
    if (!isServiceAvailable(row) && answer === 'yes') {
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
    // A no never needs the page to be current: refusing it over changed text would keep a service
    // the person just declined. It stops offers and voids grants. It doesn't stop a running service.
    if (answer === 'no') {
      try {
        ledger.recordNo({ service: row.id, reason: reason as NoReason, shutdown: 'none', origin: 'owner-surface', offerTextHash: binding.offerTextHash });
      } catch {
        res.status(503).json({ error: 'recommended-services-unavailable', detail: 'That choice could not be saved. Nothing changed.' });
        return;
      }
      try {
        tokens.invalidateService(row.id);
      } catch { /* @silent-fallback-ok — nosAtOpen still voids every open page */ }
      endSetup(row.id);
      res.json(ledger.effective(row.id));
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
      // The only thing a repeat yes changes: it lifts a hold, because the person has now asked again.
      if (readSetupStates(deps.stateDir)[row.id]?.held) {
        liftHold(row.id);
        void beginSetup(row);
      }
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
      ['setup commitment', () => {
        // A fresh yes to changed text keeps the promise already open.
        if (readSetupStates(deps.stateDir)[row.id]?.commitmentId) return;
        const commitmentId = deps.openCommitment(row.name, row.id);
        if (commitmentId) updateSetupState(deps.stateDir, row.id, { commitmentId });
      }],
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
    liftHold(row.id);
    void beginSetup(row);
    res.json(ledger.effective(row.id));
  });

  /** The session's way to report it's finished. Only the recipe's own check can say so. */
  router.post('/recommended-services/:id/verify', async (req, res) => {
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
    const recipe = recipeFor(row);
    if (!recipe) {
      res.status(409).json({ error: 'no-recipe' });
      return;
    }
    if (!ledger.activeGrant(row.id, ledger.machineId())) {
      res.status(409).json({ error: 'not-granted-here' });
      return;
    }
    try {
      const outcome = await recipe.verify({ readSecret: deps.readSecret, fetch: deps.fetch, tailscaleStatus: deps.tailscaleStatus });
      // A no can land during the call. It wins, and nothing is recorded.
      if (!ledger.activeGrant(row.id, ledger.machineId())) {
        res.status(409).json({ error: 'not-granted-here' });
        return;
      }
      recordVerify(row.id, outcome, false);
      res.json(outcome);
    } catch (err) {
      report(`Verify ${row.id}`, err, 'The check could not run.');
      res.status(503).json({ error: 'verify-failed' });
    }
  });

  /** Stores the one secret a recipe names, so a session never improvises where a key goes. */
  router.post('/recommended-services/:id/key', (req, res) => {
    const ledger = ledgerOr503(res);
    if (!ledger) return;
    const row = catalog.find((r) => r.id === req.params.id);
    const recipe = row ? recipeFor(row) : null;
    if (!row || !recipe) {
      res.status(404).json({ error: 'no-recipe' });
      return;
    }
    if (req.headers['x-instar-request'] !== '1') {
      res.status(403).json({ error: 'X-Instar-Request: 1 required' });
      return;
    }
    if (!ledger.activeGrant(row.id, ledger.machineId())) {
      res.status(409).json({ error: 'not-granted-here' });
      return;
    }
    const secretName = recipe.secretName;
    if (!secretName) {
      // Tailscale's sign-in is the person's own tap. A recipe that keeps no secret accepts none.
      res.status(409).json({ error: 'no-secret-for-this-service' });
      return;
    }
    // Plain text, parsed by its own route-level parser: a JSON slip here would put part of the key in a parse-error log.
    const value = typeof req.body === 'string' ? req.body.trim() : '';
    if (!value || value.length > 4096 || /[\s\p{Cc}]/u.test(value)) {
      res.status(400).json({ error: 'invalid-value' });
      return;
    }
    try {
      // Live features may read a key that was already here, so a setup session never replaces one. It
      // may correct its own, until that key has passed.
      const state = readSetupStates(deps.stateDir)[row.id];
      if (deps.readSecret(secretName) && (!state?.keyStoredBySetup || state.verified?.result === 'pass')) {
        res.status(409).json({ error: 'already-held' });
        return;
      }
      deps.writeSecret(secretName, value);
      updateSetupState(deps.stateDir, row.id, { keyStoredBySetup: true });
    } catch (err) {
      report(`Store the key for ${row.id}`, err, 'The key was not saved.');
      res.status(503).json({ error: 'key-not-saved' });
      return;
    }
    res.json({ stored: true });
  });
}
