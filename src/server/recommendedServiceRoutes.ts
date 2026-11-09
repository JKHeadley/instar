/**
 * Routes for recommended outside services (docs/specs/recommended-services.md, Surfaces).
 * Reading is open to any session. A no is the operator's act, so it needs the PIN, never a
 * bearer token alone. A yes needs a single-use token and the PIN, and is refused for a service
 * with no proven setup, or on a machine that can't message the person. A no may also switch a
 * working service off here (`shutdown: authorized`), which the recipe carries out. Absent ledger
 * answers 503.
 */
import { storageErrorResponse } from '../core/storageMachineName.js';
import type { Request, Response, Router } from 'express';
import { parseCloudflareSecret } from '../recommended/cloudflareDomain.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { NO_REASONS, OFFER_LIST_EVERY_MS, type NoReason, type RecommendedServicesLedger } from '../recommended/RecommendedServicesLedger.js';
import { newListId, offerCandidates, renderOfferList } from '../recommended/offerList.js';
import { OfferTapStore } from '../recommended/offerTaps.js';
import { RECOMMENDED_SERVICE_CATALOG, isServiceAvailable, offerTextHash, type CatalogRow } from '../recommended/catalog.js';
import { ConfirmTokenStore } from '../recommended/confirmTokens.js';
import { recipeFor, type RecipeDeps, type StopDeps, type VerifyResult } from '../recommended/recipes.js';
import type { BitwardenSurface } from '../recommended/bitwardenVault.js';
import type { GitHubBackupSurface } from '../recommended/githubBackup.js';
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
  /** Without a topic (an agent setting up Telegram before it has any), the session runs where the dashboard shows it. */
  startSetup: (service: string, name: string, brief: string, topicId?: number) => Promise<{ sessionName: string; topicId?: number }>;
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
  /** The value behind one of those names, wherever it lives (the vault, or the config file on a fresh agent). Defaults to readSecret. */
  readCopyValue?: (name: string) => string | null;
  /** This machine's Bitwarden, scoped to the agent's folder; tests pass a stand-in. */
  bitwarden?: BitwardenSurface;
  /** GitHub and this agent's state repository, for the private-backup recipe; tests pass a stand-in. */
  github?: GitHubBackupSurface;
  aiDoors?: import('../recommended/aiDoors.js').AiDoorSurface;
  telegramSetup?: import('../recommended/telegramSetup.js').TelegramSetupSurface;
  cloudflare?: import('../recommended/cloudflareDomain.js').CloudflareSurface;
  /** This agent's name, for things named after it. */
  agentName?: string;
  /** Turns the agent's git backup off in its config (a confirmed no to GitHub). */
  disableGitBackup?: () => void;
  /** Raises one attention item for the person (a privacy issue a check found). True once it is raised. */
  raiseAttention?: (id: string, title: string, text: string) => Promise<boolean>;
  /**
   * True when this machine can message the person right now: it has a channel and holds the lease.
   * Setup talks to the person, so a yes is refused here when it can't, and a restart waits.
   */
  canReachOwner?: (service?: string) => boolean;
  /** Before switching a service off: does the person keep another way to reach this agent, not counting the one being switched off? */
  otherRouteWorks?: (service: string) => Promise<boolean>;
  /** Hands over the check to run once sessions can start, and on a timer after that. */
  onReady?: (reconcile: () => Promise<void>) => void;
  /** Tests supply their own rows; real servers use the catalog, plus any recipe this agent is proving. */
  catalog?: readonly CatalogRow[];
  now?: () => number;
  /** The kill switch for the first list (`recommendedServices.offers.enabled`). Off means no offer is ever sent. */
  offersEnabled?: () => boolean;
  /** Sends one list with its buttons to the owner's conversation and returns the platform's message id, or null when it did not go. */
  sendOfferList?: (text: string, buttons: Array<{ text: string; data: string }>) => Promise<string | number | null>;
  /** The address the person can open the confirm page at (tunnel or home network), or null when there is none. */
  linkBase?: () => string | null;
  /** Lets the adapter hand offer-button taps to these routes. */
  registerOfferTapHandler?: (handler: OfferTapHandler) => void;
}

/** A tap on an offer button. `fromIsOwner` is the adapter's owner-principal check; a yes needs it, a no does not. */
export type OfferTapHandler = (tap: { action: 'no' | 'yes'; nonce: string; fromIsOwner: boolean }) => Promise<string>;

/** Between two sends of the same pending list, when the first returned no message id. */
export const OFFER_RESEND_AFTER_MS = 60 * 60_000;

/** What the list shows about setup on this machine. */
function setupView(state: ServiceSetupState | undefined): { verified: ServiceSetupState['verified'] | null; alreadyHeld: boolean; stalled: boolean; held: boolean; stopped: ServiceSetupState['stopped'] | null; switchingOff: boolean } {
  return { verified: state?.verified ?? null, alreadyHeld: !!state?.alreadyHeld, stalled: !!state?.exhausted, held: !!state?.held, stopped: state?.stopped ?? null, switchingOff: !!state?.stopRequestedAt && !state?.stopped };
}

export function registerRecommendedServiceRoutes(router: Router, deps: RecommendedServiceRouteDeps): void {
  const catalog = deps.catalog ?? RECOMMENDED_SERVICE_CATALOG;
  const tokens = new ConfirmTokenStore({ stateDir: deps.stateDir, now: deps.now });
  const taps = new OfferTapStore({ stateDir: deps.stateDir, now: deps.now });
  // The Cloudflare recipe's own work, kept in the setup state so its switch-off undoes exactly that.
  const cloudflareWork = {
    remember: (work: import('../recommended/cloudflareDomain.js').CloudflareWork) => { updateSetupState(deps.stateDir, 'cloudflare-domain', { cloudflareWork: work }); },
    recall: () => readSetupStates(deps.stateDir)['cloudflare-domain']?.cloudflareWork ?? null,
    forget: () => { updateSetupState(deps.stateDir, 'cloudflare-domain', { cloudflareWork: undefined }); },
  };
  /**
   * Offers go out only when every precondition holds on this machine: the switch is on, the migration flag is
   * set for this owner, a first result was delivered, this machine can reach the person (lease and channel),
   * and there is an owner to offer to. Multi-machine agents also need the choices to replicate, or a yes on
   * one machine could meet a no the other never saw.
   */
  const offersLive = (): boolean => {
    const ledger = deps.ledger();
    const owner = deps.owner();
    return !!deps.offersEnabled?.() && !!deps.sendOfferList && !!ledger && owner !== null
      && isMigrationComplete(deps.stateDir, owner) && readDeliveredFirstResult(deps.stateDir) !== null && reach();
  };
  let mintLimitReported = false;
  const starting = new Set<string>();
  const stopping = new Set<string>();
  /** With a service named, setting up that service is the question: Telegram's own setup needs no Telegram yet. */
  const reach = (service?: string): boolean => deps.canReachOwner?.(service) ?? true;
  const recipeDeps = (): RecipeDeps => ({ readSecret: deps.readSecret, fetch: deps.fetch, tailscaleStatus: deps.tailscaleStatus, bitwarden: deps.bitwarden, github: deps.github, agentName: deps.agentName, machineId: deps.ledger()?.machineId(), aiDoors: deps.aiDoors, telegramSetup: deps.telegramSetup, cloudflare: deps.cloudflare, cloudflareWork: cloudflareWork });
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
        disableGitBackup: deps.disableGitBackup,
      });
      if (outcome.stopped) {
        updateSetupState(deps.stateDir, row.id, { stopped: { at: nowIso(), detail: outcome.detail }, stopRequestedAt: undefined, verified: undefined, keyStoredBySetup: undefined, signedInBySetup: undefined, absentBeforeSetup: undefined,
          // A later yes starts the regular refresh afresh, not a day after the last one before this switch-off.
          lastSyncAt: undefined, lastSyncAttemptAt: undefined, syncFailures: undefined });
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
    const outcome = await recipe.sync({ ...recipeDeps(), readSecret: (name) => (deps.readCopyValue ?? deps.readSecret)(name), secretNames: () => deps.readSecretNames?.() ?? [] });
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
    const { absent: _absent, attention, ...recorded } = outcome;
    // A check that found something only the person can fix (a public backup repository) asks for one attention item.
    // Raised once per id; a later pass clears the mark so a repeat is raised again if it happens again.
    if (attention && before?.attentionRaised !== attention.id && deps.raiseAttention) {
      void deps.raiseAttention(attention.id, attention.title, attention.text).then((raised) => {
        if (raised) updateSetupState(deps.stateDir, service, { attentionRaised: attention.id });
      }).catch((err) => report(`Raise the ${service} attention item`, err, 'The person was not told about the privacy issue.'));
    }
    const state = updateSetupState(deps.stateDir, service, {
      verified: { at: new Date(deps.now?.() ?? Date.now()).toISOString(), ...recorded },
      ...(alreadyHeld ? { alreadyHeld: true } : {}),
      // A pass the session reports is setup's own sign-in only for a keyless recipe, and only when the check
      // before setup found nothing here. A recipe with a key has the key route's record for this.
      ...(outcome.result === 'pass' && !alreadyHeld && !before?.alreadyHeld && recipe?.secretName === null && before?.absentBeforeSetup ? { signedInBySetup: true } : {}),
      // A switch-off record is for the service as it was; a new pass with a standing yes starts over.
      ...(outcome.result === 'pass' ? { held: undefined, stopped: undefined, stopRequestedAt: undefined, attentionRaised: undefined } : {}),
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
  /**
   * A yes, from whichever verified surface: the confirm page (PIN) or the owner-only button for an address
   * service. Saves the choice, then the records of it (a failure there is reported, never refused), then starts
   * setup. False only when the choice itself could not be saved.
   */
  const applyYes = (ledger: RecommendedServicesLedger, row: CatalogRow, input: { origin: import('../recommended/RecommendedServicesLedger.js').ChoiceOrigin; offerTextHash: string; grantMachine: string; principal: string }): boolean => {
    let yes;
    try {
      yes = ledger.recordYes({ service: row.id, origin: input.origin, offerTextHash: input.offerTextHash, grantMachine: input.grantMachine, principal: input.principal });
    } catch {
      return false;
    }
    try { taps.invalidateService(row.id); } catch { /* @silent-fallback-ok — a stale button answers "already answered" */ }
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
    return true;
  };

  /**
   * The first list (spec, Offers). Rows are written `pending` before the send and `offered` only from the
   * message id the platform returned, so a failed send is never counted as an offer and a crash between the
   * two repeats at most one list. A service that `verify` finds working here with no choice is `inUse`: a
   * fact about this machine, never a choice, and it keeps the row out of the list.
   */
  let lastOfferAttemptAt = 0;
  // One list build at a time: the regular check's timer does not wait for a slow tick, and two overlapping
  // builds would each write pending rows and send. A second tick while one runs simply skips.
  let offering = false;
  const maybeOfferList = async (ledger: RecommendedServicesLedger, nowMs: number): Promise<void> => {
    if (offering) return;
    offering = true;
    try {
      await buildAndSendOfferList(ledger, nowMs);
    } finally {
      offering = false;
    }
  };
  const buildAndSendOfferList = async (ledger: RecommendedServicesLedger, nowMs: number): Promise<void> => {
    if (!offersLive() || !deps.sendOfferList) return;
    const owner = deps.owner();
    if (owner === null) return;
    if (nowMs - lastOfferAttemptAt < OFFER_RESEND_AFTER_MS) return;
    // Stamped before any probe or write, so a failing ledger write or a refused send costs one try an hour, not one a tick.
    lastOfferAttemptAt = nowMs;
    // Resume a list that was written but never proven delivered (a crash, a lease move, a refused send).
    const pending = ledger.pendingOffers(owner, nowMs);
    let listId: string;
    let rows: CatalogRow[];
    if (pending.length) {
      listId = pending[0]!.listId;
      rows = catalog.filter((row) => pending.some((r) => r.service === row.id && r.listId === listId));
    } else {
      const last = ledger.lastListAt(owner);
      if (last !== null && nowMs - last < OFFER_LIST_EVERY_MS) return;
      const candidates = offerCandidates(catalog, (row) => ({ choice: ledger.effective(row.id), offer: ledger.offerState(row.id, owner, nowMs), inUse: !!readSetupStates(deps.stateDir)[row.id]?.inUse }));
      rows = [];
      for (const row of candidates) {
        // In use already? Only a passing check on this machine says so; an unmeasurable one keeps the row.
        const recipe = recipeFor(row);
        if (recipe) {
          try {
            const seen = await recipe.verify(recipeDeps());
            if (seen.result === 'pass') {
              updateSetupState(deps.stateDir, row.id, { inUse: true });
              continue;
            }
          } catch { /* @silent-fallback-ok — unmeasurable keeps the row in the list, as the spec says */ }
        }
        rows.push(row);
      }
      if (!rows.length) return;
      listId = newListId();
      try {
        for (const row of rows) ledger.recordOfferPending({ service: row.id, owner, listId });
      } catch (err) { // @silent-fallback-ok — reported through report(), and no list is sent on this path
        report('Write the pending offers', err, 'No list was sent; the next check tries again.');
        return;
      }
    }
    const linkBase = deps.linkBase?.() ?? null;
    const rendered = renderOfferList(rows, { listId, linkBase, hasAddress: linkBase !== null, now: nowMs });
    let messageId: string | number | null = null;
    try {
      messageId = await deps.sendOfferList(rendered.text, rendered.buttons);
    } catch (err) {
      report('Send the first list of services', err, 'The list stays pending and is sent again later.');
      return;
    }
    if (messageId === null || messageId === undefined || messageId === '') return;
    try { taps.add(rendered.taps); } catch (err) { report('Write the offer buttons', err, 'The buttons under the list answer "expired"; the dashboard still works.'); }
    try {
      for (const row of rows) ledger.recordOfferDelivered({ service: row.id, owner, listId, messageId });
    } catch (err) {
      report('Record the delivered offers', err, 'The list was sent; the record is missing, so one repeat is possible.');
    }
  };

  // Offer buttons (telegram-button-approval.md §1). `rs:n:` is S-class: less action, undoable through the
  // confirm page, bounded per hour. `rs:y:` is P-class: owner-only, only for an address service, because an
  // owner with no address cannot open the page.
  deps.registerOfferTapHandler?.(async ({ action, nonce, fromIsOwner }) => {
    const ledger = deps.ledger();
    if (!ledger) return 'Choices cannot be saved on this machine right now.';
    const tap = taps.peek(nonce);
    if (!tap || tap.action !== action) return 'That button has been used or has expired. My dashboard has the list.';
    const row = catalog.find((r) => r.id === tap.service);
    if (!row) return 'That service is no longer offered.';
    if (ledger.effective(row.id).choice !== 'unset') {
      taps.consume(nonce);
      return 'Already answered.';
    }
    if (action === 'no') {
      if (!taps.admitNo()) return 'Too many answers this hour. My dashboard has the list.';
      if (!taps.consume(nonce)) return 'Already answered.';
      try {
        ledger.recordNo({ service: row.id, reason: 'none', shutdown: 'none', origin: 'first-offer', offerTextHash: offerTextHash(row) });
      } catch {
        return 'That choice could not be saved. Nothing changed.';
      }
      try { tokens.invalidateService(row.id); } catch { /* @silent-fallback-ok — nosAtOpen still voids every open page */ }
      taps.invalidateService(row.id);
      endSetup(row.id);
      return `No to ${row.name}. I won't ask again without a real reason.`;
    }
    if (!fromIsOwner) return 'Only the owner can say yes.';
    if (!row.wayIn) return 'A yes to this one needs the page, with your PIN.';
    if (!isServiceAvailable(row)) return 'That service is not available here right now.';
    const owner = deps.owner();
    if (owner === null || !reach(row.id)) return 'I cannot start setup from this machine right now.';
    if (!taps.consume(nonce)) return 'Already answered.';
    if (!applyYes(ledger, row, { origin: 'first-offer', offerTextHash: offerTextHash(row), grantMachine: ledger.machineId(), principal: owner })) return 'That choice could not be saved. Nothing changed.';
    return `Yes to ${row.name}. Setting it up now; I'll say when it works.`;
  });

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
      if (!reach(row.id)) continue;
      const decision = decideSetupRestart({ starts: state?.attempts ?? 0, lastStartMs: state?.lastAttemptAt ? Date.parse(state.lastAttemptAt) : null, nowMs });
      if (decision === 'restart') await beginSetup(row);
      else if (decision === 'dormant') updateSetupState(deps.stateDir, row.id, { dormant: true, sessionName: undefined });
      else if (decision === 'give-up' && await deps.notifyStuck(row.id, row.name)) updateSetupState(deps.stateDir, row.id, { exhausted: true });
    }
  };
  const reconcileAndOffer = async (): Promise<void> => {
    await reconcile();
    const ledger = deps.ledger();
    if (ledger) await maybeOfferList(ledger, deps.now?.() ?? Date.now());
  };
  deps.onReady?.(reconcileAndOffer);

  const ledgerOr503 = (res: Response): RecommendedServicesLedger | null => {
    const ledger = deps.ledger();
    if (!ledger) res.status(503).json(storageErrorResponse({ error: 'recommended-services-unavailable', detail: 'Choices cannot be saved on this machine yet, because it has no machine identity.' }, deps.stateDir));
    return ledger;
  };

  router.get('/recommended-services', (_req, res) => {
    const ledger = ledgerOr503(res);
    if (!ledger) return;
    const owner = deps.owner();
    const services = catalog.map((row) => {
      const { id, setupRecipe: _setupRecipe, ...text } = row;
      const state = readSetupStates(deps.stateDir)[id];
      return { ...text, ...ledger.effective(id), available: isServiceAvailable(row), grantedHere: ledger.activeGrant(id, ledger.machineId()) !== null, ...setupView(state),
        offered: owner !== null && ledger.offerState(id, owner) === 'offered', inUse: !!state?.inUse };
    });
    res.json({ services, offersLive: offersLive(), migrationComplete: isMigrationComplete(deps.stateDir, owner ?? undefined), firstResult: readDeliveredFirstResult(deps.stateDir), replicating: ledger.isReplicating() });
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
      res.status(503).json(storageErrorResponse({ error: 'recommended-services-unavailable', detail: 'That choice could not be saved. Nothing changed.' }, deps.stateDir));
      return;
    }
    // Open pages refuse this no anyway through their list of known nos. This only tidies up.
    try {
      tokens.invalidateService(req.params.id);
      taps.invalidateService(req.params.id);
    } catch { /* @silent-fallback-ok — nosAtOpen still voids every open page; a stale button sees the no and answers "already answered" */ }
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
      // A page opened for a service the owner was offered, and has not answered, answers that offer.
      const origin = ledger.effective(row.id).choice === 'unset' && ledger.offerState(row.id, owner) === 'offered' ? 'first-offer' : 'person-asked';
      minted = tokens.mint({ service: row.id, owner, targetMachine: ledger.machineId(), offerTextHash: offerTextHash(row), origin, nosAtOpen: ledger.knownNoIds(row.id) });
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
    const copies = recipeFor(row)?.listsCopies ? (deps.readSecretNames?.() ?? []) : undefined;
    res.json({ service: row.id, name, benefit, dataLeaves, cost, account, backup, canSetUp: reach(row.id), workingHere, switchOffHere: workingHere && setupDidIt(recipeFor(row)?.secretName ?? null, state), ...(copies ? { copies } : {}), ...minted });
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
    if (answer === 'yes' && !reach(row.id)) {
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
        res.status(503).json(storageErrorResponse({ error: 'recommended-services-unavailable', detail: 'That choice could not be saved. Nothing changed.' }, deps.stateDir));
        return;
      }
      try {
        tokens.invalidateService(row.id);
        taps.invalidateService(row.id);
      } catch { /* @silent-fallback-ok — nosAtOpen still voids every open page; a stale button sees the no and answers "already answered" */ }
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
    if (!applyYes(ledger, row, { origin: binding.origin, offerTextHash: binding.offerTextHash, grantMachine: binding.targetMachine, principal: binding.owner })) {
      res.status(503).json(storageErrorResponse({ error: 'recommended-services-unavailable', detail: 'That choice could not be saved. Nothing changed.' }, deps.stateDir));
      return;
    }
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
  router.post('/recommended-services/:id/key', async (req, res) => {
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
    // Telegram keeps no named secret: its bot token and chat id become this agent's messaging entry.
    if (!secretName && row.id === 'telegram' && deps.telegramSetup) {
      const token = typeof req.body === 'string' ? req.body.trim() : '';
      const chatId = typeof req.headers['x-telegram-chat-id'] === 'string' ? req.headers['x-telegram-chat-id'].trim() : '';
      if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
        res.status(400).json({ error: 'invalid-value' });
        return;
      }
      if (!/^-100\d{5,15}$/.test(chatId)) {
        res.status(400).json({ error: 'invalid-chat-id', detail: 'The chat id must be a supergroup id (-100…), the one Telegram returns after topics are turned on.' });
        return;
      }
      // A Telegram the person already had is theirs: setup never replaces a working entry.
      const existing = deps.telegramSetup.configured();
      const state = readSetupStates(deps.stateDir)[row.id];
      if (existing?.enabled && !state?.absentBeforeSetup) {
        res.status(409).json({ error: 'already-held' });
        return;
      }
      // The server proves the token and group itself, so the session never puts the token in a URL; a token
      // or group Telegram refuses is never written and never restarted into.
      const probe = await deps.telegramSetup.probe(token, chatId);
      if (probe !== 'ok') {
        res.status(409).json({ error: 'telegram-refused', probe, detail: probe === 'unknown' ? 'Telegram did not answer.' : probe === 'token-refused' ? 'Telegram refused the bot token.' : probe === 'chat-unreachable' ? "The bot can't reach that group." : 'That group has no topics turned on.' });
        return;
      }
      try {
        deps.telegramSetup.write({ token, chatId });
        // Setup made this channel: the switch-off may disable it.
        updateSetupState(deps.stateDir, row.id, { signedInBySetup: true });
        deps.telegramSetup.requestRestart('Telegram set up by the recommended-services recipe');
      } catch (err) {
        report('Store the Telegram channel', err, 'The channel was not saved.');
        res.status(503).json({ error: 'key-not-saved' });
        return;
      }
      res.json({ stored: true, restarting: true });
      return;
    }
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
    // Cloudflare's value is a token and a host name together; a value the sync could not use is refused here, not stored.
    if (row.id === 'cloudflare-domain' && !parseCloudflareSecret(value)) {
      res.status(400).json({ error: 'invalid-value', detail: 'Expected JSON with "token" and a lower-case "hostname" such as agent.example.com.' });
      return;
    }
    // A fixed address the person already had (a named tunnel here before setup) is theirs: setup never replaces it.
    if (row.id === 'cloudflare-domain' && deps.cloudflare) {
      const existing = deps.cloudflare.tunnelConfigured();
      if (existing?.enabled && existing.type === 'named' && !readSetupStates(deps.stateDir)[row.id]?.absentBeforeSetup) {
        res.status(409).json({ error: 'already-held' });
        return;
      }
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
