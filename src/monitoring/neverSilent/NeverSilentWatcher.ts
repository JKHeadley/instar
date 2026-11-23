/**
 * NeverSilentWatcher — the overdue sweep, judgment, action and telling loop
 * (docs/specs/never-silent-conversation.md §3.1–§3.5).
 *
 * Every inbound message to a conversation is an obligation (NeverSilentStore). On each
 * tick, every obligation past its notice deadline is looked at: evidence is gathered
 * (screen since the message, the engine's own login answer, pool facts), the judge on a
 * DIFFERENT engine decides why it is silent, the deterministic policy decides what may be
 * done, and the person is told — by fixed templates, through Instar's own send path, with
 * no LLM. Telling never waits on the judge or the action: a judge that throws, hangs or
 * is switched off still yields the waiting notice.
 *
 * All I/O is injected. Never throws out of tick().
 */
import crypto from 'node:crypto';
import type { ProfileRegisteredReplyProof, ProfileReplySettlementStatus } from '../../core/profileProposalResponseSettlement.js';
interface AdmissionFence { check: () => void; write: (fn: () => void) => void; record: (fn: () => void) => void }
class StaleMonitorAdmission extends Error {}
import type { NeverSilentStore, Incident, Obligation, ConversationPlatform, SilenceClass } from './NeverSilentStore.js';
import type { ConversationSilenceJudge, SilenceVerdict } from './ConversationSilenceJudge.js';
import { decideNeverSilentAction, renderNotice, ASK_BUTTON_TEXT, engineName, STALE_LOGIN_HOLD_MS, STALE_LOGIN_WAIT_REASON, type NeverSilentAction } from './NeverSilentPolicy.js';

export interface NeverSilentConfig {
  enabled: boolean;
  /** Judge on (off ⇒ every incident is `undetermined` and told). */
  judge: boolean;
  /** Automatic actions (swap / engine move). Off until measured (§3.7). */
  actions: boolean;
  frameworkFallback: boolean;
  confidenceFloor: number;
  /** Notice deadline for a new message (ms). */
  noticeAfterMs: number;
}

export interface SessionFacts {
  tmuxSession: string;
  framework: string | null;
  accountId: string | null;
  configHome: string | null;
  alive: boolean;
  startedAt: number | null;
}

export interface NeverSilentDeps {
  store: NeverSilentStore;
  verifyRegisteredReplyProof?: (proof: unknown) => boolean;
  config: () => NeverSilentConfig;
  judge: ConversationSilenceJudge | null;
  resolveSession: (platform: ConversationPlatform, key: string) => SessionFacts | null;
  /**
   * With no session here: is the waiting message held in this machine's inbound queue for
   * the other machine that runs the conversation? Returns that machine's id, or null.
   * Absent ⇒ never (single-machine installs).
   */
  awaitingMachine?: (platform: ConversationPlatform, key: string) => string | null;
  capturePane: (tmuxSession: string) => string | null;
  authStatus: (framework: string | null, configHome: string | null) => Promise<{ loggedIn: boolean | null; detail?: string } | null>;
  accountFacts: (accountId: string | null) => { id: string | null; status: string | null; loginCheck: string | null; statusCause?: string | null } | null;
  healthyByFramework: () => Record<string, number>;
  sameEngineHealthy: (framework: string | null, excludeAccountId: string | null) => boolean;
  /** An engine other than `stuck`, not in `tried`, with a signed-in account (and an available door). */
  fallbackEngine: (platform: ConversationPlatform, stuck: string | null, tried: string[]) => string | null;
  hints: (pane: string) => string[];
  /** The operator chose this conversation's engine (a non-system pin). */
  isPinned: (platform: ConversationPlatform, key: string) => boolean;
  /** Protected sessions are never moved or swapped. */
  isProtected: (tmuxSession: string) => boolean;
  /** Pool funnel: a judged login failure counts as the CLI sighting (§3.3 a, §3.6). */
  /** Returns the pool's own answer (e.g. marked / already-held / credential-unreadable) for the log. */
  observeLoginExpired: (configHome: string, tmuxSession: string) => Promise<string | void | { reason: string; probe?: 'ok' | 'refused' | 'pending' | 'inconclusive' }>;
  /** Spec stale-process-login-expired: is an in-place refresh in progress or still possible for this session? */
  inPlaceRefreshPossible?: (tmuxSession: string, accountId: string | null) => boolean;
  swap: (session: SessionFacts) => Promise<{ swapped: boolean; reason?: string }>;
  /**
   * Move the conversation to `target` and restart its session there carrying the waiting
   * messages (`redriveText`), the same path as the /route switch. Returns the engine it left.
   */
  applyFallback: (platform: ConversationPlatform, key: string, target: string, by: 'automatic' | 'tap', redriveText: string) => Promise<{ ok: boolean; from: string | null; fromUpdatedBy: string | null; reason?: string }>;
  /** Undo this feature's move once the original login works (only if nobody changed it since), restoring who set it. */
  restoreFallback: (platform: ConversationPlatform, key: string, from: string | null, fromUpdatedBy: string | null) => Promise<boolean>;
  sendNotice: (platform: ConversationPlatform, key: string, text: string, button?: { text: string; data: string }) => Promise<string | null>;
  repairStarted: (accountId: string | null) => boolean;
  accountHealthy: (accountId: string) => boolean;
  log?: (event: Record<string, unknown>) => void;
  now?: () => number;
}

const ASK_PREFIX = 'ns:m:';
export function askCallbackData(nonce: string): string { return `${ASK_PREFIX}${nonce}`; }
export function parseAskCallback(data: string): string | null {
  const m = /^ns:m:([0-9a-f]{24})$/.exec(data);
  return m ? m[1]! : null;
}

/** First judge call is free; later ones wait 60 s, doubling, up to 10 minutes (spend bound, No Unbounded Loops). */
export const JUDGE_BACKOFF_BASE_MS = 60_000;
export const JUDGE_BACKOFF_MAX_MS = 10 * 60_000;
/** A new silence this soon after a move back asks instead of moving again (the repair did not hold). */
export const RESTORE_FLAP_WINDOW_MS = 6 * 60 * 60_000;

export class NeverSilentWatcher {
  private readonly pendingReplies = new Map<string, ProfileRegisteredReplyProof>();
  private proofRevision = 0;
  private lastReconciliationCredit = -1;
  private proofKey(p: ProfileRegisteredReplyProof): string { return JSON.stringify([p.generation, p.source, p.inboundId, p.attemptId]); }
  private hasReplyProof(platform: ConversationPlatform, key: string, id: string): boolean {
    return platform === 'telegram' && [...this.pendingReplies.values()].some(p => p.source === key && p.inboundId === id);
  }
  private subjects(platform: ConversationPlatform, key: string): Obligation[] {
    return this.d.store.openFor(platform, key).filter(o => !this.hasReplyProof(platform, key, o.inboundMessageId));
  }
  onRegisteredReply(proof: ProfileRegisteredReplyProof): ProfileReplySettlementStatus {
    try {
      if (this.d.verifyRegisteredReplyProof?.(proof) !== true) return 'unavailable';
      if (!this.d.config().enabled) return 'not-required';
      if (!proof || !/^telegram:[1-9]\d*$/.test(proof.principal) || !/^[1-9]\d*$/.test(proof.source)
        || !/^[1-9]\d*$/.test(proof.inboundId) || !Number.isSafeInteger(Number(proof.source))
        || !Number.isSafeInteger(Number(proof.inboundId)) || !Number.isSafeInteger(proof.deliveredMessageId)
        || proof.deliveredMessageId <= Number(proof.inboundId) || !proof.generation || !proof.attemptId || !proof.requestId) return 'unavailable';
      const key = this.proofKey(proof);
      if (this.pendingReplies.has(key)) return 'pending';
      const captured = Object.freeze({ ...proof });
      this.pendingReplies.set(key, captured); this.proofRevision++;
      try {
        const [status] = this.d.store.recordRegisteredReplies([captured]);
        if (status !== 'pending') { this.pendingReplies.delete(key); this.proofRevision++; }
        else this.lastReconciliationCredit = this.d.store.getOrdinaryCommitRevision();
        return status;
      } catch (error) { this.lastReconciliationCredit = this.d.store.getOrdinaryCommitRevision(); this.log({ event: 'registered-reply-persist-failed', source: proof.source, inboundId: proof.inboundId, error: String(error) }); return 'pending'; }
    } catch { return 'unavailable'; }
  }
  private reconcileRegisteredReplies(): void {
    if (!this.pendingReplies.size) return;
    const credit = this.d.store.getOrdinaryCommitRevision();
    if (credit <= this.lastReconciliationCredit) return;
    this.lastReconciliationCredit = credit;
    const entries = [...this.pendingReplies.entries()];
    try {
      const statuses = this.d.store.recordRegisteredReplies(entries.map(([, proof]) => proof));
      statuses.forEach((status, i) => { if (status !== 'pending') { this.pendingReplies.delete(entries[i][0]); this.proofRevision++; } });
    } catch (error) { this.log({ event: 'registered-reply-reconcile-failed', error: String(error) }); }
  }
  private admission(platform: ConversationPlatform, key: string, incident: Incident): AdmissionFence {
    const snapshot = () => JSON.stringify([this.subjects(platform, key), this.proofRevision, this.d.store.getIncident(incident.id)]);
    let expected = snapshot();
    let stale = false;
    const check = () => {
      if (stale || snapshot() !== expected) { stale = true; throw new StaleMonitorAdmission('Monitor evidence changed before effect admission'); }
    };
    return { check, write: fn => { check(); fn(); expected = snapshot(); }, record: fn => {
      // An admitted external result is a fact even if its original permission is now stale.
      // Never refresh stale permission while committing that fact.
      if (snapshot() !== expected) stale = true;
      fn();
      if (!stale) expected = snapshot();
    } };

  }
  private readonly inflight = new Set<string>();
  /** One recovery at a time per conversation: the sweep and a tap queue behind each other. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private withLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(k) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(k, next.catch(() => undefined));
    return next;
  }
  private readonly now: () => number;
  constructor(private readonly d: NeverSilentDeps) {
    this.now = d.now ?? (() => Date.now());
  }

  // ── Inputs from the message logs ────────────────────────────────────────────

  onInbound(platform: ConversationPlatform, key: string, inboundMessageId: string, text: string, senderName?: string): void {
    const cfg = this.d.config();
    if (!cfg.enabled) return;
    try { this.d.store.accept({ platform, conversationKey: key, inboundMessageId, text, senderName, deadlineMs: cfg.noticeAfterMs }); }
    catch (err) { this.log({ event: 'accept-failed', platform, key, error: String(err) }); }
  }

  /** A substantive, delivered agent reply (not a standby, not Instar's own notice). */
  onReply(platform: ConversationPlatform, key: string): void {
    if (!this.d.config().enabled) return;
    try {
      const closed = this.d.store.recordReply(platform, key);
      if (closed.length) {
        const inc = this.d.store.openIncident(platform, key);
        if (inc && this.d.store.openFor(platform, key).length === 0) this.d.store.closeIncident(inc.id, 'answered');
      }
    } catch (err) { this.log({ event: 'reply-failed', platform, key, error: String(err) }); }
  }

  onStandby(platform: ConversationPlatform, key: string): void {
    if (!this.d.config().enabled) return;
    try { this.d.store.recordStandby(platform, key); } catch { /* @silent-fallback-ok — worst case a waiting notice is also sent */ }
  }

  // ── The sweep ───────────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    const cfg = this.d.config();
    if (!cfg.enabled) return;
    this.reconcileRegisteredReplies();
    let groups: ReturnType<NeverSilentStore['overdueConversations']> = [];
    try { groups = this.d.store.overdueConversations(this.now()); } catch (err) { this.log({ event: 'sweep-failed', error: String(err) }); }
    for (const g of groups) {
      const k = `${g.platform}:${g.conversationKey}`;
      if (this.inflight.has(k)) continue;
      this.inflight.add(k);
      try { await this.withLock(k, () => this.handleConversation(g.platform, g.conversationKey, cfg)); }
      catch (err) { this.log({ event: 'handle-failed', platform: g.platform, key: g.conversationKey, error: String(err) }); }
      finally { this.inflight.delete(k); }
    }
    try { await this.restoreMoved(); } catch (err) { this.log({ event: 'restore-failed', error: String(err) }); }
  }

  private async handleConversation(platform: ConversationPlatform, key: string, cfg: NeverSilentConfig): Promise<void> {
    const session = this.safe(() => this.d.resolveSession(platform, key), null);
    const open = this.subjects(platform, key);
    if (!open.length) return;
    const incident = this.d.store.ensureIncident(platform, key, {
      sessionName: session?.tmuxSession ?? null, framework: session?.framework ?? null, accountId: session?.accountId ?? null,
    });

    const fence = this.admission(platform, key, incident);
    const { verdict, revision } = await this.judgeSafely(incident, session, open, cfg, fence);
    fence.check();
    let decision: { action: NeverSilentAction; reason: string; target?: string } = { action: 'tell', reason: 'no verdict' };
    let loginProbe: 'ok' | 'refused' | 'pending' | 'inconclusive' | undefined;
    {
      if (verdict.silenceClass === 'engine-login' && verdict.confidence >= cfg.confidenceFloor && !verdict.truncated && session?.configHome) {
        try {
          const r = await this.d.observeLoginExpired(session.configHome, session.tmuxSession);
          fence.check();
          if (r && typeof r === 'object') loginProbe = r.probe;
          this.log({ event: 'pool-observed', incident: incident.id, result: typeof r === 'string' ? r : r && typeof r === 'object' ? r.reason : 'ok' });
        } catch { this.log({ event: 'pool-observed', incident: incident.id, result: 'error' }); }
      }
      fence.check();
      decision = decideNeverSilentAction({
        silenceClass: verdict.silenceClass,
        confidence: verdict.confidence,
        truncated: verdict.truncated,
        actionsSinceMessage: verdict.actionsSinceMessage,
        pinned: this.safe(() => this.d.isPinned(platform, key), true),
        actionsEnabled: cfg.actions,
        frameworkFallbackEnabled: cfg.frameworkFallback,
        confidenceFloor: cfg.confidenceFloor,
        sameEngineHealthy: this.safe(() => this.d.sameEngineHealthy(session?.framework ?? null, session?.accountId ?? null), false),
        fallbackEngine: this.safe(() => this.d.fallbackEngine(platform, session?.framework ?? null, [session?.framework ?? '', ...incident.triedFrameworks].filter(Boolean)), null),
        swapTried: incident.attempts > 0,
        protectedSession: !!session && this.safe(() => this.d.isProtected(session.tmuxSession), true),
        recentlyRestored: (() => { const at = this.d.store.lastRestoreAt(platform, key); return at !== null && this.now() - at < RESTORE_FLAP_WINDOW_MS; })(),
        loginProbe,
        inPlaceRefreshPossible: !!session && this.safe(() => this.d.inPlaceRefreshPossible?.(session.tmuxSession, session.accountId ?? null) ?? false, false),
        staleHoldExpired: incident.staleLoginWaitStartedAt !== undefined && this.now() - incident.staleLoginWaitStartedAt >= STALE_LOGIN_HOLD_MS,
      });
    }
    const cls: SilenceClass = verdict.silenceClass;

    if (decision.action === 'wait' && decision.reason === STALE_LOGIN_WAIT_REASON) {
      // A stale-login restart is under way: the persisted clock starts at the first hold-off.
      if (incident.staleLoginWaitStartedAt === undefined) fence.write(() => { this.d.store.updateIncident(incident.id, { staleLoginWaitStartedAt: this.now() }); });
      await this.sendWaitingIfUncovered(platform, key, incident, open, 'engine-login', 'restarting-sign-in', fence);
      return;
    }
    if (decision.action === 'wait') {
      // Still working: only the waiting notice, and only when no standby line already covered it.
      await this.sendWaitingIfUncovered(platform, key, incident, open, 'working-slow', undefined, fence);
      return;
    }

    let outcome: 'started' | 'succeeded' | 'refused' | 'exhausted' | null = null;
    let askReason: 'pinned' | 'replay' | undefined;
    let runtimeEffectAdmitted = false;
    const current = this.d.store.getIncident(incident.id) ?? incident;
    const alreadyActed = current.action === decision.action && current.outcome !== null && current.actedRevision === revision;
    if (!alreadyActed && session) {
      if (decision.action === 'swap') {
        fence.check();
        runtimeEffectAdmitted = true;
        const r = await this.safeAsync(() => this.d.swap(session), { swapped: false, reason: 'swap threw' });
        outcome = r.swapped ? 'succeeded' : 'refused';
        fence.record(() => { this.d.store.updateIncident(incident.id, { attempts: (this.d.store.getIncident(incident.id)?.attempts ?? incident.attempts) + 1 }); });
      } else if (decision.action === 'fallback' && decision.target) {
        fence.check();
        runtimeEffectAdmitted = true;
        outcome = await this.moveConversation(platform, key, incident, decision.target, 'automatic', fence);
      } else if (decision.action === 'ask-fallback' && decision.target) {
        askReason = this.safe(() => this.d.isPinned(platform, key), true) ? 'pinned' : 'replay';
        outcome = 'started';
      }
    } else if (alreadyActed) {
      outcome = current.outcome as typeof outcome;
      if (decision.action === 'ask-fallback') askReason = this.safe(() => this.d.isPinned(platform, key), true) ? 'pinned' : 'replay';
    }
    const recordOutcome = () => { this.d.store.updateIncident(incident.id, { action: decision.action, outcome, actedRevision: revision }); };
    if (runtimeEffectAdmitted) fence.record(recordOutcome); else fence.write(recordOutcome);

    if (cls === 'undetermined' || cls === 'other') {
      await this.sendWaitingIfUncovered(platform, key, incident, open, cls, undefined, fence);
      return;
    }
    await this.sendStatus(platform, key, incident, open, {
      silenceClass: cls, action: decision.action, outcome, target: decision.target ?? null, askReason,
    }, fence);
  }

  private async judgeSafely(incident: Incident, session: SessionFacts | null, open: Obligation[], cfg: NeverSilentConfig, fence: AdmissionFence): Promise<{ verdict: SilenceVerdict; revision: string }> {
    const verdict = await this.judgeOnce(incident, session, open, cfg, fence);
    return { verdict: verdict.v, revision: verdict.revision };
  }

  private async judgeOnce(incident: Incident, session: SessionFacts | null, open: Obligation[], cfg: NeverSilentConfig, fence: AdmissionFence): Promise<{ v: SilenceVerdict; revision: string }> {
    const pane = session ? (this.safe(() => this.d.capturePane(session.tmuxSession), null) ?? '') : '';
    const auth = session ? await this.safeAsync(() => this.d.authStatus(session.framework, session.configHome), null) : null;
    fence.check();
    const account = this.safe(() => this.d.accountFacts(session?.accountId ?? null), null);
    // No session here can mean the message is held for the machine that runs the conversation,
    // not that a session stopped (fb-faa9d074-e09: "the session stopped running" for one that never began).
    const awaiting = session ? null : this.safe(() => this.d.awaitingMachine?.(incident.platform, incident.conversationKey) ?? null, null);
    const revision = crypto.createHash('sha256').update(JSON.stringify({
      pane, auth, account: account?.status, check: account?.loginCheck, s: session?.tmuxSession, st: session?.startedAt, open: open.map((o) => o.id), aw: awaiting,
    })).digest('hex').slice(0, 16);
    // Unchanged evidence reuses the last verdict (no new call), except a working-slow one, which is
    // re-judged — but never sooner than the backoff allows, whatever changed on screen.
    const n = incident.judgeCount ?? 0;
    const wait = n === 0 ? 0 : Math.min(JUDGE_BACKOFF_BASE_MS * 2 ** (n - 1), JUDGE_BACKOFF_MAX_MS);
    const inBackoff = !!incident.silenceClass && incident.lastJudgedAt !== undefined && this.now() - incident.lastJudgedAt < wait;
    if (inBackoff || (incident.evidenceRevision === revision && incident.silenceClass && incident.silenceClass !== 'working-slow')) {
      return { revision: incident.evidenceRevision ?? revision, v: {
        silenceClass: incident.silenceClass!, confidence: incident.confidence ?? 0, route: incident.judgeRoute ?? 'cached',
        evidence: incident.evidence ?? '', truncated: incident.cachedVerdict?.truncated ?? false,
        actionsSinceMessage: incident.cachedVerdict?.actionsSinceMessage ?? 'unknown', calls: 0,
      } };
    }
    if (!session && awaiting) {
      const v: SilenceVerdict = { silenceClass: 'waiting-for-machine', confidence: 1, route: 'structural', evidence: `message held for machine ${awaiting}`, truncated: false, actionsSinceMessage: 'none', calls: 0 };
      this.recordVerdict(incident, v, revision, fence);
      return { v, revision };
    }
    if (!session) {
      const v: SilenceVerdict = { silenceClass: 'crashed', confidence: 1, route: 'structural', evidence: 'no session for this conversation', truncated: false, actionsSinceMessage: 'unknown', calls: 0 };
      this.recordVerdict(incident, v, revision, fence);
      return { v, revision };
    }
    if (!cfg.judge || !this.d.judge) {
      const v: SilenceVerdict = { silenceClass: 'undetermined', confidence: 0, route: 'judge-off', evidence: 'judge switched off', truncated: false, actionsSinceMessage: 'unknown', calls: 0 };
      this.recordVerdict(incident, v, revision, fence);
      return { v, revision };
    }
    const oldest = open.reduce((m, o) => Math.min(m, o.acceptedAt), Number.POSITIVE_INFINITY);
    fence.write(() => { this.d.store.updateIncident(incident.id, { lastJudgedAt: this.now(), judgeCount: n + 1 }); });
    let v: SilenceVerdict;
    try {
      v = await this.d.judge.judge({
        framework: session.framework,
        authStatus: auth,
        account,
        healthyByFramework: this.safe(() => this.d.healthyByFramework(), {}),
        timing: { acceptedAt: Number.isFinite(oldest) ? oldest : this.now(), now: this.now(), sessionAlive: session.alive, startedFirstTurn: null },
        pane,
        hints: this.safe(() => this.d.hints(pane), []),
      });
    } catch (err) {
      v = { silenceClass: 'undetermined', confidence: 0, route: 'error', evidence: `judge threw: ${String(err).slice(0, 120)}`, truncated: false, actionsSinceMessage: 'unknown', calls: 0 };
    }
    this.recordVerdict(incident, v, revision, fence);
    return { v, revision };
  }

  private recordVerdict(incident: Incident, v: SilenceVerdict, revision: string, fence: AdmissionFence): void {
    fence.write(() => { this.d.store.updateIncident(incident.id, {
      silenceClass: v.silenceClass, confidence: v.confidence, judgeRoute: v.route, evidence: v.evidence, evidenceRevision: revision,
      cachedVerdict: { truncated: v.truncated, actionsSinceMessage: v.actionsSinceMessage },
    }); });
    this.log({ event: 'verdict', incident: incident.id, class: v.silenceClass, confidence: v.confidence, route: v.route, truncated: v.truncated, actions: v.actionsSinceMessage, calls: v.calls });
  }

  /** The waiting messages, re-delivered into the moved conversation with the "why it is late" instruction. */
  buildRedriveText(incident: Incident, target: string, open: Obligation[]): string {
    const why = incident.silenceClass === 'engine-login'
      ? `the ${engineName(incident.framework)} sign-in ran out`
      : incident.silenceClass === 'usage-or-subscription-wall'
        ? `the ${engineName(incident.framework)} account hit its usage limit`
        : 'the previous session stopped';
    const header = `[Instar: ${open.length > 1 ? 'these messages' : 'this message'} waited without an answer because ${why}. `
      + `This conversation now runs on ${engineName(target)}. Begin your reply with one short line saying why it is late, then answer. `
      + 'If something here was already answered in this conversation, say so in one line instead of answering it again.]';
    const bodies = open.filter((o) => o.text).map((o) => (open.length > 1 && o.senderName ? `${o.senderName}: ${o.text}` : o.text!));
    return [header, '', ...bodies].join('\n');
  }

  private async moveConversation(platform: ConversationPlatform, key: string, incident: Incident, target: string, by: 'automatic' | 'tap', fence?: AdmissionFence): Promise<'succeeded' | 'refused'> {
    const open = this.subjects(platform, key);
    fence?.check();
    const text = this.buildRedriveText(incident, target, open);
    const r = await this.safeAsync(() => this.d.applyFallback(platform, key, target, by, text), { ok: false, from: null, fromUpdatedBy: null, reason: 'move threw' });
    if (!r.ok) {
      this.log({ event: 'fallback-refused', incident: incident.id, target, reason: r.reason });
      return 'refused';
    }
    const write = (fn: () => void) => fence ? fence.record(fn) : fn();
    write(() => {
    const tried = [...new Set([...(this.d.store.getIncident(incident.id)?.triedFrameworks ?? incident.triedFrameworks), ...(incident.framework ? [incident.framework] : [])])];
    this.d.store.updateIncident(incident.id, {
      fallback: { from: r.from, fromUpdatedBy: r.fromUpdatedBy, to: target, appliedAt: this.now(), by },
      triedFrameworks: tried,
    });
    // The waiting messages went into the new session: each gets a fresh notice deadline there.
    for (const o of open) this.d.store.markRedriven(o.id, this.now(), this.d.config().noticeAfterMs);
    });
    this.log({ event: 'fallback-applied', incident: incident.id, from: r.from, to: target, by, redriven: open.length });
    return 'succeeded';
  }

  private async sendWaitingIfUncovered(platform: ConversationPlatform, key: string, incident: Incident, open: Obligation[], cls: SilenceClass, waitingReason?: 'restarting-sign-in', fence?: AdmissionFence): Promise<void> {
    const uncovered = open.filter((o) => !o.coveredBy.includes('waiting') && !o.standbySeenAt);
    if (!uncovered.length) return;
    const text = renderNotice({ kind: 'waiting', count: uncovered.length, silenceClass: cls, framework: incident.framework, action: null, outcome: null, ...(waitingReason ? { waitingReason } : {}) });
    fence?.check();
    const id = await this.safeAsync(() => this.d.sendNotice(platform, key, text), null);
    if (id === null) { this.log({ event: 'notice-undelivered', incident: incident.id, kind: 'waiting' }); return; }
    const record = () => {
    this.d.store.markCovered(uncovered.map((o) => o.id), 'waiting');
    this.log({ event: 'notice-sent', incident: incident.id, kind: 'waiting', class: cls, covered: uncovered.length });
    this.d.store.appendNotice(incident.id, { kind: 'waiting', revision: `waiting|${cls}`, messageId: id, at: this.now(), covered: uncovered.map((o) => o.id) });
    };
    if (fence) fence.record(record); else record();
  }

  private async sendStatus(platform: ConversationPlatform, key: string, incident: Incident, open: Obligation[],
    s: { silenceClass: SilenceClass; action: NeverSilentAction; outcome: 'started' | 'succeeded' | 'refused' | 'exhausted' | null; target: string | null; askReason?: 'pinned' | 'replay' }, fence?: AdmissionFence): Promise<void> {
    const revision = `${s.silenceClass}|${s.action}|${s.outcome ?? ''}`;
    const fresh = this.d.store.getIncident(incident.id) ?? incident;
    const alreadySent = fresh.notices.some((n) => n.kind === 'status' && n.revision === revision);
    const uncovered = open.filter((o) => !o.coveredBy.includes('status'));
    if (alreadySent && !uncovered.length) return;
    const count = alreadySent ? uncovered.length : open.length;
    let button: { text: string; data: string } | undefined;
    if (s.action === 'ask-fallback' && s.target) {
      // Already tapped (or closed): the person answered; never offer a second button.
      if (fresh.ask && fresh.ask.state !== 'open') return;
      if (fresh.ask && fresh.ask.state === 'open') {
        // One open ask per incident; a later message joins it rather than asking again.
        if (alreadySent) return;
      }
      const nonce = fresh.ask?.state === 'open' ? fresh.ask.nonce : crypto.randomBytes(12).toString('hex');
      button = { text: ASK_BUTTON_TEXT(s.target), data: askCallbackData(nonce) };
      const write = () => { this.d.store.updateIncident(incident.id, { ask: { nonce, state: 'open', sentAt: this.now(), target: s.target } }); };
      if (fence) fence.write(write); else write();
    }
    const text = renderNotice({
      kind: 'status', count, silenceClass: s.silenceClass, framework: fresh.framework, action: s.action, outcome: s.outcome,
      target: s.target, repairStarted: this.safe(() => this.d.repairStarted(fresh.accountId), false), askReason: s.askReason,
    });
    fence?.check();
    const id = await this.safeAsync(() => this.d.sendNotice(platform, key, text, button), null);
    if (id === null) { this.log({ event: 'notice-undelivered', incident: incident.id, kind: 'status', revision }); return; }
    const record = () => {
    this.d.store.markCovered(open.map((o) => o.id), 'status');
    this.log({ event: 'notice-sent', incident: incident.id, kind: 'status', revision, covered: open.length, ask: !!button });
    this.d.store.appendNotice(incident.id, { kind: 'status', revision, messageId: id, at: this.now(), covered: open.map((o) => o.id) });
    };
    if (fence) fence.record(record); else record();
  }

  // ── The one-tap ask (Frontloaded Decision 2) ────────────────────────────────

  /** Returns the short text shown to the person who tapped. Idempotent; never throws. */
  /**
   * Answers the tap at once (Telegram's callback answer expires in seconds, and a sweep may hold
   * the conversation's lock while it judges), then makes the move under the lock. A move that
   * fails reopens the ask and tells the person in the conversation. Idempotent; never throws.
   */
  async handleAskTap(nonce: string, fromIsOwner: boolean): Promise<string> {
    if (!fromIsOwner) return 'Only the owner can move this conversation.';
    const inc = this.d.store.incidentByAskNonce(nonce);
    if (!inc || !inc.ask) return 'That button is no longer active.';
    if (inc.ask.state === 'tapped') return `Already moving it to ${engineName(inc.ask.target)}.`;
    if (inc.ask.state !== 'open' || inc.closedAt) return 'Nothing to move: this conversation has answered since.';
    const target = inc.ask.target;
    if (!target) return 'That button is no longer active.';
    this.d.store.updateIncident(inc.id, { ask: { ...inc.ask, state: 'tapped', tappedAt: this.now() } });
    const k = `${inc.platform}:${inc.conversationKey}`;
    this.pendingTaps.add(this.withLock(k, async () => {
      const fresh = this.d.store.getIncident(inc.id) ?? inc;
      // The conversation may have answered while the tap waited for the lock: never move it then.
      if (fresh.closedAt || this.subjects(fresh.platform, fresh.conversationKey).length === 0) {
        this.d.store.updateIncident(inc.id, { ask: { ...(fresh.ask ?? inc.ask!), state: 'closed' } });
        return;
      }
      const fence = this.admission(fresh.platform, fresh.conversationKey, fresh);
      const outcome = await this.moveConversation(fresh.platform, fresh.conversationKey, fresh, target, 'tap', fence);
      if (outcome !== 'succeeded') {
        fence.record(() => { this.d.store.updateIncident(inc.id, { action: 'fallback', outcome: 'refused' }); });
        // Reopening a button is prospective permission, not result accounting.
        fence.write(() => { this.d.store.updateIncident(inc.id, { ask: { ...(fresh.ask ?? inc.ask!), state: 'open' } }); });
        const text = `I couldn't move this conversation to ${engineName(target)} just now. It stays where it is and I'll tell you here when it's fixed.`;
        fence.check();
        await this.safeAsync(() => this.d.sendNotice(fresh.platform, fresh.conversationKey, text), null);
        return;
      }
      fence.record(() => { this.d.store.updateIncident(inc.id, { action: 'fallback', outcome: 'succeeded' }); });
    }).catch(() => undefined));
    return `Moving this conversation to ${engineName(target)}. It will answer here shortly.`;
  }

  private readonly pendingTaps = new Set<Promise<unknown>>();
  /** Resolves when every queued tap has finished (tests and orderly shutdown). */
  async settle(): Promise<void> {
    while (this.pendingTaps.size) {
      const all = [...this.pendingTaps];
      await Promise.all(all);
      for (const p of all) this.pendingTaps.delete(p);
    }
  }

  // ── Moving back after the original login is repaired ────────────────────────

  private async restoreMoved(): Promise<void> {
    for (const inc of this.d.store.movedIncidents()) {
      if (!inc.accountId || !this.safe(() => this.d.accountHealthy(inc.accountId!), false)) continue;
      if (this.d.store.openFor(inc.platform, inc.conversationKey).length) continue; // never mid-answer
      const ok = await this.safeAsync(() => this.d.restoreFallback(inc.platform, inc.conversationKey, inc.fallback!.from, inc.fallback!.fromUpdatedBy ?? null), false);
      if (ok) {
        this.d.store.updateIncident(inc.id, { fallback: { ...inc.fallback!, restoredAt: this.now() } });
        this.log({ event: 'fallback-restored', incident: inc.id });
      }
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private safe<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch { return fallback; /* @silent-fallback-ok — a failed lookup takes the conservative value; telling still happens */ }
  }
  private async safeAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try { return await fn(); } catch { return fallback; /* @silent-fallback-ok — a failed action is recorded as refused; telling still happens */ }
  }
  private log(event: Record<string, unknown>): void {
    try { this.d.log?.({ at: new Date(this.now()).toISOString(), ...event }); } catch { /* @silent-fallback-ok — logging never breaks the sweep */ }
  }
}
