/**
 * ProjectAppsRuntime — the live half of project apps (docs/specs/project-apps.md).
 *
 * Holds the in-memory fold of the `project-app-record` kind (rebuilt once from the journal, then
 * kept current from the commit observers), answers the Work read, writes offers and the owner's
 * answers, and carries out the link-pin steps for Telegram/Slack.
 *
 * Pin rule (spec §3.6): a NEW message is only ever sent because of one deliberate act (an `act`
 * step). Steps that send nothing new — pinning a message already posted, unpinning, editing a
 * pinned link in place — run on their own. One (project, app) pair runs one step at a time, and
 * the attachment fold is re-read before every platform call. The acting machine is decided when a
 * step runs: the conversation's owner if one is registered, else the lease holder.
 */
import crypto from 'node:crypto';
import {
  type UnionEntry, type PairState, type PinView, type PinAct, type PinPlatform, type AnswerVia,
  foldPairs, foldPins, nextPinAction, pinUncertain, pinOutOfDate, builtinApp, BUILTIN_APPS,
  buildOffer, buildAnswer, buildPinEvent, offerKey, APP_REF_RE, CUSTOM_APP_REF_RE, OFFER_RECORD_MAX_BYTES,
} from '../core/ProjectAppStore.js';
import type { HlcTimestamp } from '../core/HybridLogicalClock.js';

type Build = (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp) => Record<string, unknown> | null;

export interface PinPlatformOps {
  /** Send the link message; resolves to the platform message id, or null when the send was held/quiet. */
  send(conversationKey: string, text: string): Promise<string | null>;
  pin(conversationKey: string, messageId: string, pinned: boolean): Promise<void>;
  /** Edit a message's text in place. `missing` = the message is gone; other failures throw. */
  edit(conversationKey: string, messageId: string, text: string): Promise<'edited' | 'not-modified' | 'missing'>;
}

export interface BuiltinSummary {
  state: 'ok' | 'pending' | 'unreadable';
  headline?: string;
  counts?: Array<{ label: string; value: number; tone?: 'ok' | 'attn' | 'bad' | 'quiet' }>;
  asOf?: string;
  why?: string;
  action?: { label: string; href: string };
}

export interface ProjectAppsRuntimeDeps {
  emit: (recordKey: string, build: Build) => { outcome: string };
  loadUnion: () => UnionEntry[];
  now: () => number;
  machineId: string;
  /** Whether this machine is where platform steps for this conversation run right now. */
  isActingMachine: (conversationKey: string) => boolean;
  holdsLease: () => boolean;
  /** The bound projects' conversation keys (the Chief of Staff), null when it is off. */
  projectKeys: () => string[] | null;
  /** The agent's stable public address, best first; null when there is none. */
  publicBase: () => string | null;
  platformFor: (conversationKey: string) => { platform: PinPlatform; ops: PinPlatformOps } | null;
  /** The summary for a builtin app; never awaited on the read path. */
  builtinSummary: (appId: string) => BuiltinSummary;
  /** Whether the feature behind a builtin app is on (an off feature cannot be offered). */
  builtinAvailable: (appId: string) => boolean;
  /**
   * Part 2 (docs/specs/project-apps-sandbox.md): a custom app by its ref, or null when there is no such
   * app or custom apps are off on this agent (then its rows are hidden and it cannot be offered).
   * Absent ⇒ custom apps are not available on this build.
   */
  customApp?: (appRef: string) => { appId: string; title: string; conversationKey: string; specOk: boolean; summary?: BuiltinSummary } | null;
  log?: (entry: Record<string, unknown>) => void;
}

export interface ProjectAppRow {
  appRef: string; title: string; openHref: string; nativeScreen?: string;
  summary: { headline: string; counts: Array<{ label: string; value: number; tone?: string }>; asOf: string } | null;
  summaryState: 'ok' | 'pending' | 'unreadable'; summaryWhy?: string; summaryAction?: { label: string; href: string };
  pin?: { platform: PinPlatform; state: 'pinned' | 'pending' | 'failed' | 'uncertain' | 'out-of-date' | 'none'; reason?: string };
}
export interface ProjectAppsView {
  apps: ProjectAppRow[];
  offers: Array<{ appRef: string; title: string; why: string; at: string }>;
  answers: Array<{ appRef: string; answer: string; by: string; via: string; at: string }>;
  addable: Array<{ appRef: string; title: string; note?: string }>;
}

export type Refusal = { ok: false; status: number; error: string; detail?: string };
const refuse = (status: number, error: string, detail?: string): Refusal => ({ ok: false, status, error, ...(detail ? { detail } : {}) });

const isTelegramKey = (k: string) => /^telegram:\d+$/.test(k);
export const ACT_TTL_MS = 10 * 60_000;
const written = (o: string) => o === 'emitted' || o === 'accepted' || o === 'unconfirmed';

export class ProjectAppsRuntime {
  private union: UnionEntry[] | null = null;
  /** This machine's own writes since the last read, so a step sees them before the journal flushes. */
  private ownWrites: UnionEntry[] = [];
  private pairs: Map<string, PairState> | null = null;
  private queues = new Map<string, Promise<void>>();
  private recentRequestIds = new Map<string, number>();
  private consumed = new Set<string>();

  private invalidator: (() => void) | null = null;

  constructor(private readonly d: ProjectAppsRuntimeDeps) {}

  /** Emit and keep the record in memory until the journal read carries it. */
  private emit(recordKey: string, build: Build): { outcome: string } {
    let captured: Record<string, unknown> | null = null;
    const r = this.d.emit(recordKey, (hlc, origin, observed) => { captured = build(hlc, origin, observed); return captured; });
    if (captured && written(r.outcome)) { this.ownWrites.push({ data: captured, origin: this.d.machineId }); this.union = null; this.pairs = null; }
    return r;
  }

  /** The Work read's cache clear (set once the route is mounted). */
  setWorkInvalidator(fn: () => void): void { this.invalidator = fn; }
  invalidateWork(): void { try { this.invalidator?.(); } catch { /* @silent-fallback-ok — the cache expires on its own in 10 s */ } }

  /** A committed batch of this kind (own or a peer's): refresh the fold and run what it asks for. */
  onCommitted(): void {
    this.union = null; this.pairs = null;
    this.invalidateWork();
    void this.process();
  }

  private load(): { union: UnionEntry[]; pairs: Map<string, PairState> } {
    if (!this.union || !this.pairs) {
      let u: UnionEntry[] = [];
      try { u = this.d.loadUnion(); } catch { u = []; } // @silent-fallback-ok — an unreadable journal reads as no apps; the Work row still shows the project
      // One entry per record key: the journal read and this machine's unflushed writes overlap.
      const seen = new Set<string>(); const merged: UnionEntry[] = [];
      for (const e of [...u, ...this.ownWrites]) {
        const k = String(e.data.recordKey ?? ''); if (k && seen.has(k)) continue; if (k) seen.add(k); merged.push(e);
      }
      if (this.ownWrites.length > 200) this.ownWrites = this.ownWrites.slice(-200);
      this.union = merged; this.pairs = foldPairs(merged);
    }
    return { union: this.union, pairs: this.pairs };
  }

  private pair(ck: string, ref: string): PairState | undefined {
    return this.load().pairs.get(`${ck}\u0000${ref}`);
  }

  private titleOf(ref: string): string { return builtinApp(ref)?.title ?? this.custom(ref)?.title ?? ref; }

  private custom(ref: string): ReturnType<NonNullable<ProjectAppsRuntimeDeps['customApp']>> {
    if (!CUSTOM_APP_REF_RE.test(ref) || !this.d.customApp) return null;
    try { return this.d.customApp(ref); } catch { return null; } // @silent-fallback-ok — an unreadable custom app is hidden, never shown wrong
  }

  /** A pair's app is shown: a builtin, or a custom app that exists, on this project, with custom apps on. */
  private visible(ck: string, ref: string): boolean {
    if (APP_REF_RE.test(ref)) return true;
    const c = this.custom(ref);
    return !!c && c.conversationKey === ck;
  }

  /** The Work read's per-project fields (spec §3.3). */
  view(conversationKey: string): ProjectAppsView {
    const { union, pairs } = this.load();
    const mine = [...pairs.values()].filter((p) => p.conversationKey === conversationKey && this.visible(conversationKey, p.appRef));
    const base = this.d.publicBase();
    const apps: ProjectAppRow[] = mine.filter((p) => p.state === 'attached')
      .sort((a, b) => String(b.attachedAt).localeCompare(String(a.attachedAt)))
      .map((p) => {
        const b = builtinApp(p.appRef);
        const c = b ? null : this.custom(p.appRef);
        const s: BuiltinSummary = b ? this.d.builtinSummary(b.id) : c ? (c.summary ?? { state: 'pending' }) : { state: 'unreadable' as const, why: 'This app is not available on this machine.' };
        const pins = foldPins(union, conversationKey, p.appRef);
        const platform = this.d.platformFor(conversationKey)?.platform;
        return {
          appRef: p.appRef, title: this.titleOf(p.appRef), openHref: b?.consoleRoute ?? (c ? `/dashboard/project-app/?app=${c.appId}` : '#/work/board'),
          ...(b ? { nativeScreen: b.nativeScreen } : {}),
          summary: s.state === 'ok' && s.headline && s.asOf ? { headline: s.headline, counts: s.counts ?? [], asOf: s.asOf } : null,
          summaryState: s.state, ...(s.why ? { summaryWhy: s.why } : {}), ...(s.action ? { summaryAction: s.action } : {}),
          ...(platform ? { pin: this.pinState(platform, pins, base) } : {}),
        };
      });
    const offers = mine.filter((p) => p.state === 'offered' && p.offer).map((p) => ({ appRef: p.appRef, title: this.titleOf(p.appRef), why: p.offer!.why, at: p.offer!.at }));
    const answers = mine.flatMap((p) => p.answers.map((a) => ({ appRef: p.appRef, ...a }))).sort((x, y) => y.at.localeCompare(x.at)).slice(0, 10);
    const attachedRefs = new Set(apps.map((a) => a.appRef));
    const addable = BUILTIN_APPS.map((b) => `builtin:${b.id}`).filter((ref) => !attachedRefs.has(ref)).map((ref) => {
      const p = pairs.get(`${conversationKey}\u0000${ref}`);
      const last = p?.answers[0];
      const note = p?.state === 'declined' || p?.state === 'detached' ? `you said no on ${String(p.ownerAnswer?.at).slice(0, 10)}`
        : p?.state === 'withdrawn' && last ? `your agent withdrew this on ${last.at.slice(0, 10)}` : undefined;
      return { appRef: ref, title: this.titleOf(ref), ...(note ? { note } : {}) };
    });
    return { apps, offers, answers, addable };
  }

  private pinState(platform: PinPlatform, pins: PinView | null, base: string | null): NonNullable<ProjectAppRow['pin']> {
    if (pinUncertain(pins)) return { platform, state: 'uncertain' };
    if (pins?.last?.state === 'failed') return { platform, state: 'failed', ...(pins.last.reason ? { reason: pins.last.reason } : {}) };
    if (pinOutOfDate(pins, base)) return { platform, state: 'out-of-date' };
    if (pins?.current) return { platform, state: 'pinned' };
    if (pins?.live.some((m) => m.state === 'posted')) return { platform, state: 'pending' };
    return { platform, state: 'none' };
  }

  /** The agent's one suggestion (spec §3.3). Lease holder only. */
  offer(conversationKey: string, appRef: string, why: string): { ok: true } | Refusal {
    if (!this.d.holdsLease()) return refuse(409, 'not-lease-holder', 'Offers are made on the machine that serves Telegram.');
    const keys = this.d.projectKeys();
    if (!keys || !keys.includes(conversationKey)) return refuse(404, 'unknown-project');
    if (CUSTOM_APP_REF_RE.test(appRef)) {
      if (!this.d.customApp) return refuse(409, 'custom-apps-not-available', 'Custom apps are not available on this agent.');
      const c = this.custom(appRef);
      if (!c || c.conversationKey !== conversationKey) return refuse(404, 'unknown-app', 'No such custom app on this project.');
      // The spec process (project-apps-sandbox §3.4): every custom-app offer names a converged spec.
      if (!c.specOk) return refuse(409, 'app-spec-not-converged', 'The app\'s spec no longer carries review-convergence and review-report.');
    } else {
      const b = APP_REF_RE.test(appRef) ? builtinApp(appRef) : null;
      if (!b) return refuse(404, 'unknown-app');
      if (!this.d.builtinAvailable(b.id)) return refuse(409, 'app-unavailable', `${b.title} is switched off on this agent.`);
    }
    const text = String(why ?? '').trim();
    if (!text) return refuse(400, 'why-required', 'Say in a line why this project would be easier to follow with the app.');
    const at = new Date(this.d.now()).toISOString();
    if (Buffer.byteLength(JSON.stringify({ conversationKey, appRef, why: text, at }), 'utf8') > OFFER_RECORD_MAX_BYTES - 512) return refuse(400, 'why-too-long', `Keep the reason under ${OFFER_RECORD_MAX_BYTES - 1024} bytes.`);
    const p = this.pair(conversationKey, appRef);
    if (p?.state === 'attached') return refuse(409, 'already-attached');
    if (p?.state === 'declined' || p?.state === 'detached') return refuse(409, 'owner-declined', 'The owner said no to this app for this project; it stays under Add app on the row.');
    if (p?.offer) return refuse(409, 'already-offered');
    const r = this.emit(offerKey(conversationKey, appRef), buildOffer({ conversationKey, appRef, why: text, at }));
    if (!written(r.outcome)) return refuse(503, 'write-refused', r.outcome);
    this.onCommitted();
    this.d.log?.({ event: 'offer', conversationKey, appRef, at });
    return { ok: true };
  }

  /**
   * An answer (spec §3.3). `proof` is what the ROUTE verified: an owner proof, or the agent's Bearer.
   * The body never decides `by` or `via`.
   */
  answer(conversationKey: string, appRef: string, answer: string, proof: { by: 'owner' | 'agent'; via: AnswerVia; principal?: string }, requestId?: string): { ok: true; changed: boolean } | Refusal {
    const keys = this.d.projectKeys();
    if (!keys || !keys.includes(conversationKey)) return refuse(404, 'unknown-project');
    if (!builtinApp(appRef)) {
      if (!CUSTOM_APP_REF_RE.test(appRef)) return refuse(404, 'unknown-app');
      if (!this.d.customApp) return refuse(404, 'custom-apps-not-available');
      const c = this.custom(appRef);
      if (!c || c.conversationKey !== conversationKey) return refuse(404, 'unknown-app');
    }
    if (requestId) {
      const seen = this.recentRequestIds.get(`${conversationKey}|${appRef}|${requestId}`);
      if (seen !== undefined) return { ok: true, changed: false };
    }
    const p = this.pair(conversationKey, appRef);
    if (proof.by === 'agent') {
      if (answer !== 'withdraw') return refuse(403, 'owner-proof-required', 'Only the owner can attach, decline or remove an app.');
      if (p?.state !== 'offered') return refuse(409, 'not-an-open-offer');
    } else if (!['attach', 'decline', 'detach'].includes(answer)) return refuse(400, 'bad-answer');
    const at = new Date(this.d.now()).toISOString();
    // Idempotent: answering the state the pair is already in adds history but no act (spec §3.6).
    const noOp = (answer === 'attach' && p?.state === 'attached') || (answer === 'detach' && (p?.state === 'detached' || !p || p.state === 'none'));
    const r = this.emit(`appanswer-pending:${conversationKey}:${appRef}`, buildAnswer({ conversationKey, appRef, answer: answer as 'attach', by: proof.by, via: proof.via, ...(proof.principal ? { principal: proof.principal } : {}), at }));
    if (!written(r.outcome)) return refuse(503, 'write-refused', r.outcome);
    if (requestId) this.rememberRequest(`${conversationKey}|${appRef}|${requestId}`);
    const platform = this.d.platformFor(conversationKey)?.platform;
    if (!noOp && platform && (answer === 'attach' || answer === 'detach')) this.writeAct(conversationKey, appRef, platform, answer as PinAct);
    this.onCommitted();
    this.d.log?.({ event: 'answer', conversationKey, appRef, answer, by: proof.by, via: proof.via, at });
    return { ok: true, changed: !noOp };
  }

  /** Try again / Update link / Post the link again (spec §3.6): a replicated act, any machine. */
  requestPinAct(conversationKey: string, appRef: string, act: 'retry' | 'update-link' | 'post-again'): { ok: true } | Refusal {
    const p = this.pair(conversationKey, appRef);
    if (p?.state !== 'attached') return refuse(409, 'not-attached');
    const platform = this.d.platformFor(conversationKey)?.platform;
    if (!platform) return refuse(409, 'no-platform', 'This project’s conversation is not on Telegram or Slack.');
    if (!this.writeAct(conversationKey, appRef, platform, act)) return refuse(503, 'write-refused');
    this.onCommitted();
    return { ok: true };
  }

  private writeAct(conversationKey: string, appRef: string, platform: PinPlatform, act: PinAct): boolean {
    const opId = crypto.randomBytes(9).toString('base64url');
    return written(this.emit(`apppin-act:${opId}`, buildPinEvent({ conversationKey, appRef, platform, state: 'act', act, opId, at: new Date(this.d.now()).toISOString() })).outcome);
  }

  private rememberRequest(k: string): void {
    const now = this.d.now();
    this.recentRequestIds.set(k, now);
    for (const [key, t] of this.recentRequestIds) if (now - t > 24 * 3600_000) this.recentRequestIds.delete(key);
  }

  /** Run what the fold asks for, one step at a time per pair (spec §3.6). */
  async process(): Promise<void> {
    const { pairs } = this.load();
    for (const p of pairs.values()) {
      if (!this.visible(p.conversationKey, p.appRef)) continue;
      const platform = this.d.platformFor(p.conversationKey);
      if (!platform) continue;
      if (!this.d.isActingMachine(p.conversationKey)) continue;
      const key = `${p.conversationKey}\u0000${p.appRef}`;
      const prev = this.queues.get(key) ?? Promise.resolve();
      const next = prev.then(() => this.step(p.conversationKey, p.appRef)).catch(() => { /* @silent-fallback-ok — each step records its own failure */ });
      this.queues.set(key, next);
    }
  }

  /** Unconsumed acts for a pair, oldest first: an act whose opId has no later step. */
  private pendingActs(union: UnionEntry[], ck: string, ref: string): Array<{ opId: string; act: PinAct }> {
    const steps = union.map((e) => e.data).filter((d) => d.recordType === 'project-app-pin' && d.conversationKey === ck && d.appRef === ref);
    const outcomeOps = new Set(steps.filter((d) => d.state !== 'act').map((d) => String(d.opId)));
    return steps.filter((d) => d.state === 'act' && !outcomeOps.has(String(d.opId)) && !this.consumed.has(String(d.opId)))
      // An act nobody consumed for ten minutes (its machine was off or on an older build) expires
      // instead of firing as a surprise post days later (second-pass review).
      .filter((d) => { const t = Date.parse(String(d.at)); const fresh = Number.isFinite(t) && this.d.now() - t <= ACT_TTL_MS; if (!fresh) this.consumed.add(String(d.opId)); return fresh; })
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .map((d) => ({ opId: String(d.opId), act: d.act as PinAct }));
  }

  private async step(ck: string, ref: string): Promise<void> {
    for (let guard = 0; guard < 8; guard++) {
      // Re-read the fold before every platform call.
      this.union = null; this.pairs = null;
      const { union } = this.load();
      if (!this.d.isActingMachine(ck)) return;
      const pf = this.d.platformFor(ck); if (!pf) return;
      const p = this.pair(ck, ref);
      const attached = p?.state === 'attached';
      const pins = foldPins(union, ck, ref);
      const acts = this.pendingActs(union, ck, ref);
      const act = acts[0] ?? null;
      const base = this.d.publicBase();
      const action = nextPinAction(act?.act ?? null, attached, pins, base);
      const opId = act?.opId ?? crypto.randomBytes(9).toString('base64url');
      const at = () => new Date(this.d.now()).toISOString();
      const record = (state: 'pending' | 'posted' | 'pinned' | 'edited' | 'unpinned' | 'failed', extra: Record<string, unknown> = {}) => {
        if (state !== 'pending') this.d.log?.({ event: `pin-${state}`, conversationKey: ck, appRef: ref, ...(typeof extra.reason === 'string' ? { reason: extra.reason } : {}), at: at() });
        return this.emit(`apppin-step:${opId}:${state}:${crypto.randomBytes(4).toString('hex')}`, buildPinEvent({ conversationKey: ck, appRef: ref, platform: pf.platform, state, opId, at: at(), ...extra }));
      };
      if (action.kind === 'none') {
        // An act that has nothing to do is consumed (recorded) so it never fires later by surprise.
        if (act) {
          this.consumed.add(act.opId);
          if (action.why === 'no-public-address') record('failed', { reason: 'no-public-address' });
          else if (action.why === 'uncertain') record('failed', { reason: 'uncertain: check the conversation, then Post the link again' });
          else record('failed', { reason: action.why ?? 'nothing-to-do' });
          continue;
        }
        return;
      }
      if (act) this.consumed.add(act.opId);
      const text = this.linkText(ref, base);
      try {
        if (action.kind === 'post') {
          if (!base) { record('failed', { reason: 'no-public-address' }); return; }
          record('pending', action.replacesMessageId ? { replacesMessageId: action.replacesMessageId } : {});
          const id = await pf.ops.send(ck, text);
          if (!id) { record('failed', { reason: 'The link message was held instead of sent.' }); return; }
          record('posted', { messageId: id, baseUrl: base, ...(action.replacesMessageId ? { replacesMessageId: action.replacesMessageId } : {}) });
        } else if (action.kind === 'pin') {
          // The fold is re-read above: a detach that arrived meanwhile turns this into an unpin.
          await pf.ops.pin(ck, action.messageId, true);
          record('pinned', { messageId: action.messageId });
        } else if (action.kind === 'unpin') {
          await pf.ops.pin(ck, action.messageId, false);
          record('unpinned', { messageId: action.messageId });
        } else if (action.kind === 'edit') {
          if (!base) return;
          const res = await pf.ops.edit(ck, action.messageId, text);
          if (res === 'missing') record('failed', { messageId: action.messageId, reason: 'message-missing' });
          else record('edited', { messageId: action.messageId, baseUrl: base });
        }
      } catch (err) {
        record('failed', { reason: (err instanceof Error ? err.message : String(err)).slice(0, 280), ...(action.kind === 'edit' ? { messageId: action.messageId } : {}) });
        return;
      }
    }
  }

  private linkText(ref: string, base: string | null): string {
    const b = builtinApp(ref);
    const c = b ? null : this.custom(ref);
    if (c) return `📌 ${this.titleOf(ref)}: ${base ?? ''}/dashboard/project-app/?app=${c.appId}`;
    const route = b?.consoleRoute ?? '#/work/board';
    return `📌 ${this.titleOf(ref)}: ${base ?? ''}/dashboard/console/${route}`;
  }

  /** An Open tap (spec §10a): app ref only, no content. */
  recordOpen(conversationKey: string, appRef: string): void {
    this.d.log?.({ event: 'opened', conversationKey, appRef, at: new Date(this.d.now()).toISOString() });
  }

  /** Measures for §10a (counts only). */
  stats(opens: Array<{ appRef: string; conversationKey: string; at: string }>): Record<string, unknown> {
    const { pairs } = this.load();
    const all = [...pairs.values()];
    const offered = all.filter((p) => p.offer).length;
    const attachedAfterOffer = all.filter((p) => p.offer && p.state === 'attached').length;
    return {
      attached: all.filter((p) => p.state === 'attached').length,
      offers: offered,
      offerAcceptanceRate: offered ? attachedAfterOffer / offered : null,
      opens: opens.length,
    };
  }
}

export { isTelegramKey };
