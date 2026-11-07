/**
 * Routes for recommended outside services (docs/specs/recommended-services.md, Surfaces).
 * Reading is open to any session. A no is the operator's act, so it needs the PIN, never a
 * bearer token alone. A yes needs a single-use token and the PIN, and is refused for a service
 * with no proven setup, or on a machine that can't message the person. A no may also switch a
 * working service off here (`shutdown: authorized`), which the recipe carries out. Absent ledger
 * answers 503.
 */
import type { Request, Response, Router } from 'express';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { NO_REASONS, type NoReason, type RecommendedServicesLedger } from '../recommended/RecommendedServicesLedger.js';
import { RECOMMENDED_SERVICE_CATALOG, isServiceAvailable, offerTextHash, type CatalogRow } from '../recommended/catalog.js';
import { ConfirmTokenStore } from '../recommended/confirmTokens.js';
import { recipeFor, type RecipeDeps, type StopDeps, type VerifyResult } from '../recommended/recipes.js';
import type { BitwardenSurface } from '../recommended/bitwardenVault.js';
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
  /** Tests supply the sign-out; real servers run `tailscale logout` on this machine. */
  tailscaleLogout?: StopDeps['tailscaleLogout'];
  /** Removes a key a recipe stored, for a confirmed switch-off. */
  deleteSecret?: (name: string) => void;
  /** The names of this agent's stored secrets (never values), for a recipe that keeps a copy elsewhere. */
  readSecretNames?: () => string[];
  /** This machine's Bitwarden, scoped to the agent's folder; tests pass a stand-in. */
  bitwarden?: BitwardenSurface;
  /**
   * True when this machine can message the person right now: it has a channel and holds the lease.
   * Setup talks to the person, so a yes is refused here when it can't, and a restart waits.
   */
  canReachOwner?: () => boolean;
  /** Before switching a service off: does the person keep another way to reach this agent, not counting the one being switched off? */
  otherRouteWorks?: (service: string) => Promise<boolean>;
  /** Hands over the check to run once sessions can start, and on a timer after that. */
  onReady?: (reconcile: () => Promise<void>) => void;
  /** Tests supply their own rows; real servers use the catalog, plus any recipe this agent is proving. */
  catalog?: readonly CatalogRow[];
  now?: () => number;
}

/** What the list shows about setup on this machine. */
function setupView(state: ServiceSetupState | undefined): { verified: ServiceSetupState['verified'] | null; alreadyHeld: boolean; stalled: boolean; held: boolean; stopped: ServiceSetupState['stopped'] | null; switchingOff: boolean } {
  return { verified: state?.verified ?? null, alreadyHeld: !!state?.alreadyHeld, stalled: !!state?.exhausted, held: !!state?.held, stopped: state?.stopped ?? null, switchingOff: !!state?.stopRequestedAt && !state?.stopped };
}

export function registerRecommendedServiceRoutes(router: Router, deps: RecommendedServiceRouteDeps): void {
  const catalog = deps.catalog ?? RECOMMENDED_SERVICE_CATALOG;
  const tokens = new ConfirmTokenStore({ stateDir: deps.stateDir, now: deps.now });
  let mintLimitReported = false;
  const starting = new Set<string>();
  const stopping = new Set<string>();
  const reach = (): boolean => deps.canReachOwner?.() ?? true;
  const recipeDeps = (): RecipeDeps => ({ readSecret: deps.readSecret, fetch: deps.fetch, tailscaleStatus: deps.tailscaleStatus, bitwarden: deps.bitwarden });
  /** How often a copy kept elsewhere is brought up to date by the regular check, and how long a failed refresh waits before another try. */
  const SYNC_EVERY_MS = 24 * 60 * 60_000;
  const SYNC_RETRY_MS = 6 * 60 * 60_000;
  /** After this many failed refreshes in a row the check is re-run: its fail restarts setup, which asks the person for what changed. */
  const SYNC_FAILURES_BEFORE_RECHECK = 3;
  const nowIso = (): string => new Date(deps.now?.() ?? Date.now()).toISOString();
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
  /**
   * The one positive sign that this machine's own setup made the service work. For a recipe with a key it is
   * the key route's record, which never overwrites a key that was already here. For one without, it is a pass
   * through the verify route after the check before setup found nothing here. Anything else is the person's.
   */
  const setupDidIt = (secretName: string | null, state: ServiceSetupState | undefined): boolean =>
    secretName ? !!state?.keyStoredBySetup : !!state?.signedInBySetup;
  /**
   * A confirmed no with "switch it off" (`shutdown: authorized`). Undoes only what setup did on this
   * machine. If the service may be the person's only way in, the switch-off waits for another route,
   * and the regular check finishes it. Runs on a no here and on a no that arrives from another machine.
   */
  const stopService = async (row: CatalogRow, before?: ServiceSetupState): Promise<void> => {
    const recipe = recipeFor(row);
    const state = readSetupStates(deps.stateDir)[row.id];
    if (!recipe || state?.stopped || stopping.has(row.id)) return;
    stopping.add(row.id);
    try {
      // What setup did here is read from the state as it was before the no cleared it. Only positive evidence
      // counts: a machine with no record did nothing, so nothing is undone there and nobody is told.
      const was = before ?? state;
      const setUpHere = setupDidIt(recipe.secretName, was) || setupDidIt(recipe.secretName, state);
      const hadSomething = !!(was?.verified || was?.alreadyHeld || setUpHere);
      const waiting = !!state?.stopRequestedAt;
      // Only a way of reaching the person (an address or a channel) can strand them; Jev cannot.
      if (row.wayIn && !(await (deps.otherRouteWorks?.(row.id) ?? Promise.resolve(true)))) {
        if (!waiting) {
          updateSetupState(deps.stateDir, row.id, { stopRequestedAt: nowIso() });
          deps.tellOwner(`I've saved your no to ${row.name}. It stays on for now, because it may be the only way I can reach you. As soon as another way works, I'll switch it off here and tell you.`);
        }
        return;
      }
      const outcome = await recipe.stop({
        ...recipeDeps(), tailscaleLogout: deps.tailscaleLogout,
        deleteSecret: deps.deleteSecret ?? (() => { throw new Error('this server cannot remove a stored key'); }),
        setUpHere,
        absentBefore: !!(was?.absentBeforeSetup || state?.absentBeforeSetup),
      });
      if (outcome.stopped) {
        updateSetupState(deps.stateDir, row.id, { stopped: { at: nowIso(), detail: outcome.detail }, stopRequestedAt: undefined, verified: undefined, keyStoredBySetup: undefined, signedInBySetup: undefined, absentBeforeSetup: undefined });
        // Told when something was undone, when something was working here, or when they were promised word.
        if (outcome.changed || hadSomething || waiting) deps.tellOwner(outcome.detail);
        return;
      }
      // Still on. Say so once; the regular check keeps trying quietly.
      if (!waiting) {
        updateSetupState(deps.stateDir, row.id, { stopRequestedAt: nowIso() });
        deps.tellOwner(`${outcome.detail} I'll keep trying, and tell you when it's off.`);
      }
      report(`Switch ${row.id} off after a confirmed no`, new Error(outcome.detail), `${row.name} is still on. The next check tries again.`);
    } catch (err) {
      // Said once too, so a machine that can't carry out the switch-off doesn't repeat itself every check.
      if (!readSetupStates(deps.stateDir)[row.id]?.stopRequestedAt) {
        updateSetupState(deps.stateDir, row.id, { stopRequestedAt: nowIso() });
        deps.tellOwner(`I couldn't switch ${row.name} off on this machine just now. I'll keep trying, and tell you when it's off.`);
      }
      report(`Switch ${row.id} off after a confirmed no`, err, `${row.name} may still be on. The next check tries again.`);
    } finally {
      stopping.delete(row.id);
    }
  };
  /**
   * Brings a copy kept elsewhere up to date. Only the names of what was copied are recorded or returned;
   * values stay inside the recipe. Quiet on the regular check; the session hears the answer on its own call.
   */
  const syncCopy = async (row: CatalogRow): Promise<{ ok: boolean; copied: string[]; detail: string } | null> => {
    const recipe = recipeFor(row);
    if (!recipe?.sync) return null;
    const outcome = await recipe.sync({ ...recipeDeps(), secretNames: () => deps.readSecretNames?.() ?? [] });
    const before = readSetupStates(deps.stateDir)[row.id];
    updateSetupState(deps.stateDir, row.id, outcome.ok
      ? { lastSyncAt: nowIso(), lastSyncAttemptAt: nowIso(), copies: outcome.copied.length, syncFailures: undefined }
      : { lastSyncAttemptAt: nowIso(), syncFailures: (before?.syncFailures ?? 0) + 1 });
    return outcome;
  };
  /** A fresh yes starts over: an old switch-off record must not hide the new setup or swallow a later switch-off. */
  const clearStop = (service: string): void => {
    const state = readSetupStates(deps.stateDir)[service];
    if (state?.stopped || state?.stopRequestedAt) updateSetupState(deps.stateDir, service, { stopped: undefined, stopRequestedAt: undefined });
  };
  const recordVerify = (service: string, outcome: VerifyResult, alreadyHeld: boolean): void => {
    const before = readSetupStates(deps.stateDir)[service];
    // An outage says nothing new, so it never takes a pass away. That would restart setup on a working service.
    if (outcome.result === 'unknown' && before?.verified?.result === 'pass') return;
    // A no that landed during the check wins: a pass is never written beside it.
    if (outcome.result === 'pass' && !hasGrant(service)) return;
    const recipe = recipeFor(catalog.find((r) => r.id === service) ?? { id: service, setupRecipe: null } as CatalogRow);
    const { absent: _absent, ...recorded } = outcome;
    const state = updateSetupState(deps.stateDir, service, {
      verified: { at: new Date(deps.now?.() ?? Date.now()).toISOString(), ...recorded },
      ...(alreadyHeld ? { alreadyHeld: true } : {}),
      // A pass the session reports is setup's own sign-in only for a keyless recipe, and only when the check
      // before setup found nothing here. A recipe with a key has the key route's record for this.
      ...(outcome.result === 'pass' && !alreadyHeld && !before?.alreadyHeld && recipe?.secretName === null && before?.absentBeforeSetup ? { signedInBySetup: true } : {}),
      // A switch-off record is for the service as it was; a new pass with a standing yes starts over.
      ...(outcome.result === 'pass' ? { held: undefined, stopped: undefined, stopRequestedAt: undefined } : {}),
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
      const preflight = await recipe.verify(recipeDeps());
      if (!hasGrant(row.id) || preflight.result === 'unknown') return;
      // The check takes a moment, and a stop can land in it.
      if (readSetupStates(deps.stateDir)[row.id]?.held) return;
      if (preflight.result === 'pass') {
        recordVerify(row.id, preflight, true);
        // The check took a moment; a no in it means nothing is said.
        if (hasGrant(row.id)) deps.tellOwner(`${row.name} was already working on this machine, so there's nothing for me to set up.`);
        return;
      }
      updateSetupState(deps.stateDir, row.id, {
        attempts: (before?.attempts ?? 0) + 1, lastAttemptAt: new Date(deps.now?.() ?? Date.now()).toISOString(), dormant: undefined,
        // What the check saw before setup ran: nothing here at all, or something here that isn't working. Only the
        // first makes a later pass setup's own sign-in. The first attempt's reading is the real "before": a restart
        // after setup's own half-finished sign-in must not overwrite it.
        absentBeforeSetup: before?.absentBeforeSetup || preflight.absent === true ? true : undefined,
      });
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
        // A no with "switch it off", here or on another machine, is obeyed here too.
        if (ledger.effective(row.id).shutdown === 'authorized' && !state?.stopped) await stopService(row, state);
        continue;
      }
      if (!isServiceAvailable(row)) continue;
      // A working copy kept elsewhere is refreshed on a schedule, so a secret stored after setup reaches it too.
      // A failed refresh waits hours, not minutes, and after a few in a row the check is re-run, so a changed
      // password or a revoked login ends in setup asking the person, never in a row that says "working" for ever.
      const copyRecipe = recipeFor(row);
      if (state?.verified?.result === 'pass' && copyRecipe?.sync) {
        const last = (state.lastSyncAt && Date.parse(state.lastSyncAt)) || 0;
        const lastTry = (state.lastSyncAttemptAt && Date.parse(state.lastSyncAttemptAt)) || 0;
        const failures = state.syncFailures ?? 0;
        if (failures >= SYNC_FAILURES_BEFORE_RECHECK && nowMs - lastTry >= SYNC_RETRY_MS) {
          // The stamp moves first, so a re-check that itself fails waits the same six hours instead of every tick.
          updateSetupState(deps.stateDir, row.id, { syncFailures: undefined, lastSyncAttemptAt: nowIso() });
          try {
            const recheck = await copyRecipe.verify(recipeDeps());
            recordVerify(row.id, recheck, false);
            if (recheck.result === 'fail') {
              // Something only the person can give has changed (a new master password, a revoked login). The old
              // session is long gone, so the restart budget starts over and setup comes back to ask them for it.
              updateSetupState(deps.stateDir, row.id, { attempts: undefined, lastAttemptAt: undefined, dormant: undefined, exhausted: undefined });
              // The repair is a promise too: it stays open until the check passes again or the person says no.
              try {
                const commitmentId = deps.openCommitment(row.name, row.id);
                if (commitmentId) updateSetupState(deps.stateDir, row.id, { commitmentId });
              } catch (err) {
                report(`Open the repair commitment for ${row.id}`, err, 'The repair runs, but its promise is not tracked.');
              }
              deps.tellOwner(`${row.name} stopped working on this machine: ${recheck.detail} I'll come back to you for what I need to fix it.`);
            }
          } catch {
            report(`Re-check ${row.name} after failed refreshes`, new Error('the check could not run'), 'The copy stays behind until the next check.');
          }
          // The rest of this row waits for the next tick, which reads the fresh result: a fail restarts setup then.
          continue;
        } else if (nowMs - last >= SYNC_EVERY_MS && nowMs - lastTry >= (failures > 0 ? SYNC_RETRY_MS : 0)) {
          try {
            const outcome = await syncCopy(row);
            // A fixed reason: nothing downstream of the CLI, whose text can carry a command line, reaches a log.
            if (outcome && !outcome.ok) report(`Refresh the ${row.name} copy`, new Error('the copy could not be written'), 'The copy is behind until the next check.');
          } catch {
            report(`Refresh the ${row.name} copy`, new Error('the refresh failed'), 'The copy is behind until the next check.');
          }
        }
      }
      if (state?.verified?.result === 'pass' || state?.exhausted || state?.dormant || state?.held) continue;
      if (state?.sessionName && deps.isSetupRunning(state.sessionName)) continue;
      // Setup talks to the person. While this machine can't, a restart waits and costs no attempt.
      if (!reach()) continue;
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
    const before = readSetupStates(deps.stateDir)[req.params.id];
    endSetup(req.params.id);
    const row = catalog.find((r) => r.id === req.params.id);
    if (shutdown && row) void stopService(row, before);
    res.json({ ...ledger.effective(req.params.id), switchingOff: shutdown });
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
    const state = readSetupStates(deps.stateDir)[row.id];
    // The page offers "switch it off" only where this machine's own setup made the service work; a service the
    // person already had is named as theirs. It also says when a yes can't be taken here.
    const workingHere = state?.verified?.result === 'pass' && !state.stopped;
    // A recipe that keeps a copy elsewhere says on the page which secrets it would copy: names only, never values.
    const copies = recipeFor(row)?.sync ? (deps.readSecretNames?.() ?? []) : undefined;
    res.json({ service: row.id, name, benefit, dataLeaves, cost, account, backup, canSetUp: reach(), workingHere, switchOffHere: workingHere && setupDidIt(recipeFor(row)?.secretName ?? null, state), ...(copies ? { copies } : {}), ...minted });
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
    const { token, answer, reason = 'none', shutdown = false } = (req.body ?? {}) as { token?: unknown; answer?: unknown; reason?: unknown; shutdown?: unknown };
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
    if (typeof shutdown !== 'boolean') {
      res.status(400).json({ error: 'invalid-shutdown' });
      return;
    }
    // A PIN is only looked at for a real, live request, so this route can't test PIN guesses for
    // anyone who hasn't a page open, and a mistyped PIN doesn't spend the token.
    if (!isServiceAvailable(row) && answer === 'yes') {
      res.status(409).json({ error: 'not-available' });
      return;
    }
    // Setup talks to the person from this machine. Refused before the token is spent, so the page works again once it can.
    if (answer === 'yes' && !reach()) {
      res.status(409).json({ error: 'cannot-reach-you' });
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
    // the person just declined. It stops offers and voids grants. It switches a running service off
    // only when the person ticked that too, which this PIN-checked page is the place to confirm.
    if (answer === 'no') {
      try {
        ledger.recordNo({ service: row.id, reason: reason as NoReason, shutdown: shutdown ? 'authorized' : 'none', origin: 'owner-surface', offerTextHash: binding.offerTextHash });
      } catch {
        res.status(503).json({ error: 'recommended-services-unavailable', detail: 'That choice could not be saved. Nothing changed.' });
        return;
      }
      try {
        tokens.invalidateService(row.id);
      } catch { /* @silent-fallback-ok — nosAtOpen still voids every open page */ }
      const before = readSetupStates(deps.stateDir)[row.id];
      endSetup(row.id);
      if (shutdown) void stopService(row, before);
      res.json({ ...ledger.effective(row.id), switchingOff: shutdown });
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
        clearStop(row.id);
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
    clearStop(row.id);
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
      const outcome = await recipe.verify(recipeDeps());
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

  /** The session's way to have this server write the copy a recipe keeps elsewhere. Returns names, never values. */
  router.post('/recommended-services/:id/sync', async (req, res) => {
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
    if (!recipe.sync) {
      res.status(409).json({ error: 'no-copy-for-this-service' });
      return;
    }
    if (!ledger.activeGrant(row.id, ledger.machineId())) {
      res.status(409).json({ error: 'not-granted-here' });
      return;
    }
    try {
      const outcome = await syncCopy(row);
      if (!outcome) {
        res.status(409).json({ error: 'no-copy-for-this-service' });
        return;
      }
      res.status(outcome.ok ? 200 : 503).json(outcome);
    } catch {
      // A fixed reason: the CLI's own error text can carry a command line.
      report(`Write the ${row.name} copy`, new Error('the copy could not be written'), 'The copy was not written.');
      res.status(503).json({ error: 'sync-failed' });
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
    // Trimmed, then only control characters are refused: a Bitwarden master passphrase has spaces in it.
    const value = typeof req.body === 'string' ? req.body.trim() : '';
    if (!value || value.length > 4096 || /\p{Cc}/u.test(value)) {
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
